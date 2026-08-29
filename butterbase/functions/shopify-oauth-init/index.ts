// shopify-oauth-init
//
// Generates the Shopify OAuth authorization URL.
// The merchant must provide their shop domain (e.g. mystore.myshopify.com).
//
// Input:  { organization_id: string; shop_domain: string }
// Output: { auth_url: string }

import { randomBytes } from "crypto";
import { getServiceClient } from "../_shared/db";

const SCOPES = "read_orders,read_financial,read_payments";

export async function handler(input: {
  organization_id: string;
  shop_domain: string;
}) {
  const db = getServiceClient();

  const clientId = process.env.SHOPIFY_CLIENT_ID!;
  const redirectUri = process.env.SHOPIFY_REDIRECT_URI!;

  // Normalize shop domain
  const shopDomain = input.shop_domain
    .replace(/^https?:\/\//, "")
    .replace(/\/$/, "")
    .toLowerCase();

  const state = randomBytes(32).toString("hex");
  const expiresAt = new Date(Date.now() + 10 * 60 * 1000).toISOString();

  // Store state — also store shop_domain so callback can retrieve it
  await db.from("oauth_states").insert({
    state,
    organization_id: input.organization_id,
    provider: "shopify",
    expires_at: expiresAt,
    // Reuse the state row's primary key; stash shop_domain in a note field
    // by encoding it in state as JSON — cleaner than adding a column
  });

  // Encode shop_domain into the state value (base64 JSON) so callback can recover it
  const statePayload = Buffer.from(JSON.stringify({ nonce: state, shop: shopDomain })).toString("base64url");

  // Re-insert with the encoded state key
  await db.from("oauth_states").delete().eq("state", state);
  await db.from("oauth_states").insert({
    state: statePayload,
    organization_id: input.organization_id,
    provider: "shopify",
    expires_at: expiresAt,
  });

  const params = new URLSearchParams({
    client_id: clientId,
    scope: SCOPES,
    redirect_uri: redirectUri,
    state: statePayload,
  });

  return { auth_url: `https://${shopDomain}/admin/oauth/authorize?${params}` };
}
