// qbo-oauth-init
//
// Generates the QBO OAuth 2.0 authorization URL and stores a
// short-lived state token to prevent CSRF.
//
// Called by the frontend when the user clicks "Connect QuickBooks".
// Returns a redirect URL — the frontend sends the user there.
//
// Input:  { organization_id: string }
// Output: { auth_url: string }

import { createHash, randomBytes } from "crypto";
import { getServiceClient } from "../_shared/db";

const QBO_AUTH_BASE = "https://appcenter.intuit.com/connect/oauth2";
const SCOPES = "com.intuit.quickbooks.accounting";

export async function handler(input: { organization_id: string }) {
  const db = getServiceClient();

  const clientId = process.env.QBO_CLIENT_ID!;
  const redirectUri = process.env.QBO_REDIRECT_URI!; // e.g. https://app.example.com/api/auth/qbo/callback

  // Generate a cryptographically random state token
  const state = randomBytes(32).toString("hex");

  // Store state in DB with a 10-minute TTL so the callback can validate it
  const expiresAt = new Date(Date.now() + 10 * 60 * 1000).toISOString();
  await db.from("oauth_states").insert({
    state,
    organization_id: input.organization_id,
    provider: "qbo",
    expires_at: expiresAt,
  });

  const params = new URLSearchParams({
    client_id: clientId,
    scope: SCOPES,
    redirect_uri: redirectUri,
    response_type: "code",
    access_type: "offline",
    state,
  });

  return { auth_url: `${QBO_AUTH_BASE}?${params.toString()}` };
}
