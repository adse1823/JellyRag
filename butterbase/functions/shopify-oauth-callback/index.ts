// shopify-oauth-callback
//
// Handles the redirect back from Shopify after authorization.
// Exchanges the code for a permanent access token and triggers
// an initial payout sync.
//
// Input:  { code: string; shop: string; state: string; hmac: string }
// Output: { ok: boolean; organization_id: string }

import { createHmac } from "crypto";
import { getServiceClient } from "../_shared/db";
import { exchangeShopifyCode } from "../_shared/shopify-client";
import { handler as payoutSync } from "../shopify-payout-sync/index";

export async function handler(input: {
  code: string;
  shop: string;
  state: string;
  hmac: string;
  rawQueryString: string; // full query string without hmac, for HMAC validation
}) {
  const db = getServiceClient();

  // ── Validate HMAC (Shopify's equivalent of QBO's signature) ───
  if (!validateShopifyHmac(input.rawQueryString, input.hmac)) {
    throw new Error("Invalid Shopify HMAC — possible CSRF or tampered request");
  }

  // ── Validate state ─────────────────────────────────────────────
  const { data: stateRow, error: stateErr } = await db
    .from("oauth_states")
    .select("organization_id, expires_at")
    .eq("state", input.state)
    .eq("provider", "shopify")
    .single();

  if (stateErr || !stateRow) throw new Error("Invalid OAuth state");
  if (new Date(stateRow.expires_at) < new Date()) throw new Error("OAuth state expired");

  await db.from("oauth_states").delete().eq("state", input.state);

  const orgId: string = stateRow.organization_id;

  // ── Exchange code for access token ────────────────────────────
  const accessToken = await exchangeShopifyCode(input.shop, input.code);

  // ── Fetch shop name from Shopify ──────────────────────────────
  const shopRes = await fetch(`https://${input.shop}/admin/api/2024-01/shop.json`, {
    headers: { "X-Shopify-Access-Token": accessToken },
  });
  const shopJson = shopRes.ok ? await shopRes.json() as { shop?: { name?: string } } : null;
  const shopName = shopJson?.shop?.name ?? null;

  // ── Upsert integration connection ─────────────────────────────
  await db.from("integration_connections").upsert(
    {
      organization_id: orgId,
      provider: "shopify",
      status: "active",
      shopify_domain: input.shop,
      shopify_shop_name: shopName,
      access_token: accessToken,
      token_scope: "read_orders,read_financial,read_payments",
      updated_at: new Date().toISOString(),
    },
    { onConflict: "organization_id,provider" }
  );

  // ── Trigger initial payout sync ───────────────────────────────
  payoutSync({ organization_id: orgId }).catch((err) =>
    console.error(`shopify-payout-sync failed for org ${orgId}:`, err)
  );

  return { ok: true, organization_id: orgId };
}

function validateShopifyHmac(rawQueryString: string, hmac: string): boolean {
  const secret = process.env.SHOPIFY_CLIENT_SECRET!;
  // rawQueryString must have hmac parameter removed before hashing
  const queryWithoutHmac = rawQueryString
    .split("&")
    .filter((p) => !p.startsWith("hmac="))
    .sort()
    .join("&");

  const expected = createHmac("sha256", secret)
    .update(queryWithoutHmac)
    .digest("hex");

  return expected === hmac;
}
