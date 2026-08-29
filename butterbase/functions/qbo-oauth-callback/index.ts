// qbo-oauth-callback
//
// Handles the redirect back from Intuit after the user authorizes.
// Exchanges the auth code for tokens, stores them, then triggers
// qbo-initial-sync to pull the chart of accounts and transactions.
//
// Input:  { code: string; realmId: string; state: string }
// Output: { ok: boolean; organization_id: string }

import { getServiceClient } from "../_shared/db";
import { handler as initialSync } from "../qbo-initial-sync/index";

const TOKEN_URL = "https://oauth.platform.intuit.com/oauth2/v1/tokens/bearer";

export async function handler(input: {
  code: string;
  realmId: string;
  state: string;
}) {
  const db = getServiceClient();

  const clientId = process.env.QBO_CLIENT_ID!;
  const clientSecret = process.env.QBO_CLIENT_SECRET!;
  const redirectUri = process.env.QBO_REDIRECT_URI!;

  // ── Validate state (CSRF protection) ──────────────────────────
  const { data: stateRow, error: stateErr } = await db
    .from("oauth_states")
    .select("organization_id, expires_at")
    .eq("state", input.state)
    .eq("provider", "qbo")
    .single();

  if (stateErr || !stateRow) throw new Error("Invalid OAuth state — possible CSRF");
  if (new Date(stateRow.expires_at) < new Date()) throw new Error("OAuth state expired");

  // Delete state row immediately (single-use)
  await db.from("oauth_states").delete().eq("state", input.state);

  const orgId: string = stateRow.organization_id;

  // ── Exchange code for tokens ───────────────────────────────────
  const credentials = Buffer.from(`${clientId}:${clientSecret}`).toString("base64");

  const res = await fetch(TOKEN_URL, {
    method: "POST",
    headers: {
      Authorization: `Basic ${credentials}`,
      "Content-Type": "application/x-www-form-urlencoded",
      Accept: "application/json",
    },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      code: input.code,
      redirect_uri: redirectUri,
    }),
  });

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Token exchange failed (${res.status}): ${body}`);
  }

  const tokens = await res.json() as {
    access_token: string;
    refresh_token: string;
    expires_in: number;
    x_refresh_token_expires_in: number;
    token_type: string;
  };

  const expiresAt = new Date(Date.now() + tokens.expires_in * 1000).toISOString();

  // ── Fetch company name from QBO ────────────────────────────────
  const companyRes = await fetch(
    `https://quickbooks.api.intuit.com/v3/company/${input.realmId}/companyinfo/${input.realmId}?minorversion=65`,
    {
      headers: {
        Authorization: `Bearer ${tokens.access_token}`,
        Accept: "application/json",
      },
    }
  );
  const companyJson = companyRes.ok ? await companyRes.json() as { CompanyInfo?: { CompanyName?: string } } : null;
  const companyName = companyJson?.CompanyInfo?.CompanyName ?? null;

  // ── Upsert integration connection ─────────────────────────────
  await db.from("integration_connections").upsert(
    {
      organization_id: orgId,
      provider: "qbo",
      status: "active",
      qbo_realm_id: input.realmId,
      qbo_company_name: companyName,
      access_token: tokens.access_token,
      refresh_token: tokens.refresh_token,
      token_expires_at: expiresAt,
      token_scope: "com.intuit.quickbooks.accounting",
      updated_at: new Date().toISOString(),
    },
    { onConflict: "organization_id,provider" }
  );

  // ── Trigger initial sync ───────────────────────────────────────
  // Run async — don't block the OAuth callback response
  initialSync({ organization_id: orgId }).catch((err) =>
    console.error(`qbo-initial-sync failed for org ${orgId}:`, err)
  );

  return { ok: true, organization_id: orgId };
}
