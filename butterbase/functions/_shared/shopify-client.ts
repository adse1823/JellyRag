// Shopify Admin REST API + Payments Balance API wrapper.
// Read-only scopes: read_orders, read_financial, read_payments.

import { DB } from "./db";

const API_VERSION = "2024-01";

export interface ShopifyConnection {
  organization_id: string;
  shop_domain: string;   // e.g. mystore.myshopify.com
  access_token: string;
}

export interface ShopifyPayout {
  id: number;
  status: "scheduled" | "in_transit" | "paid" | "failed" | "cancelled";
  date: string;             // YYYY-MM-DD
  currency: string;
  amount: string;           // net amount as string decimal
  summary: {
    adjustments_fee_amount: string;
    adjustments_gross_amount: string;
    charges_fee_amount: string;
    charges_gross_amount: string;
    refunds_fee_amount: string;
    refunds_gross_amount: string;
    reserved_funds_fee_amount: string;
    reserved_funds_gross_amount: string;
    retrials_fee_amount: string;
    retrials_gross_amount: string;
  };
}

export interface ShopifyPayoutTransaction {
  id: number;
  type: "payout" | "refund" | "dispute" | "reserve" | "adjustment" | "payment";
  payout_id: number;
  currency: string;
  amount: string;
  fee: string;
  net: string;
  source_id: number | null;
  source_type: string | null;    // 'Order', 'Refund', etc.
  source_order_id: number | null;
  processed_at: string;
}

export async function getShopifyConnection(db: DB, orgId: string): Promise<ShopifyConnection> {
  const { data, error } = await db
    .from("integration_connections")
    .select("organization_id, shopify_domain, access_token")
    .eq("organization_id", orgId)
    .eq("provider", "shopify")
    .eq("status", "active")
    .single();

  if (error || !data) throw new Error(`No active Shopify connection for org ${orgId}`);

  return {
    organization_id: data.organization_id,
    shop_domain: data.shopify_domain,
    access_token: data.access_token,
  };
}

function shopifyUrl(conn: ShopifyConnection, path: string): string {
  return `https://${conn.shop_domain}/admin/api/${API_VERSION}/${path}`;
}

function shopifyHeaders(conn: ShopifyConnection) {
  return {
    "X-Shopify-Access-Token": conn.access_token,
    "Content-Type": "application/json",
  };
}

// Fetch all payouts, optionally since a date.
export async function fetchPayouts(
  conn: ShopifyConnection,
  opts: { sinceDateStr?: string } = {}
): Promise<ShopifyPayout[]> {
  const all: ShopifyPayout[] = [];
  let pageInfo: string | null = null;
  const pageSize = 250;

  while (true) {
    const params = new URLSearchParams({ limit: String(pageSize) });
    if (opts.sinceDateStr) params.set("date_min", opts.sinceDateStr);
    if (pageInfo) params.set("page_info", pageInfo);

    const url = shopifyUrl(conn, `shopify_payments/payouts.json?${params}`);
    const res = await fetch(url, { headers: shopifyHeaders(conn) });

    if (!res.ok) {
      const body = await res.text();
      throw new Error(`Shopify payouts fetch failed (${res.status}): ${body}`);
    }

    const json = await res.json() as { payouts: ShopifyPayout[] };
    all.push(...json.payouts);

    // Shopify uses Link header for cursor pagination
    const link = res.headers.get("Link");
    const nextMatch = link?.match(/<[^>]+page_info=([^&>]+)[^>]*>;\s*rel="next"/);
    if (!nextMatch || json.payouts.length < pageSize) break;
    pageInfo = nextMatch[1];
  }

  return all;
}

// Fetch line-level transactions for a payout.
export async function fetchPayoutTransactions(
  conn: ShopifyConnection,
  payoutId: number
): Promise<ShopifyPayoutTransaction[]> {
  const all: ShopifyPayoutTransaction[] = [];
  let pageInfo: string | null = null;
  const pageSize = 250;

  while (true) {
    const params = new URLSearchParams({ payout_id: String(payoutId), limit: String(pageSize) });
    if (pageInfo) params.set("page_info", pageInfo);

    const url = shopifyUrl(conn, `shopify_payments/transactions.json?${params}`);
    const res = await fetch(url, { headers: shopifyHeaders(conn) });

    if (!res.ok) {
      const body = await res.text();
      throw new Error(`Shopify payout transactions fetch failed (${res.status}): ${body}`);
    }

    const json = await res.json() as { transactions: ShopifyPayoutTransaction[] };
    all.push(...json.transactions);

    const link = res.headers.get("Link");
    const nextMatch = link?.match(/<[^>]+page_info=([^&>]+)[^>]*>;\s*rel="next"/);
    if (!nextMatch || json.transactions.length < pageSize) break;
    pageInfo = nextMatch[1];
  }

  return all;
}

// Exchange a Shopify OAuth code for a permanent access token.
export async function exchangeShopifyCode(
  shopDomain: string,
  code: string
): Promise<string> {
  const clientId = process.env.SHOPIFY_CLIENT_ID!;
  const clientSecret = process.env.SHOPIFY_CLIENT_SECRET!;

  const res = await fetch(`https://${shopDomain}/admin/oauth/access_token`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ client_id: clientId, client_secret: clientSecret, code }),
  });

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Shopify token exchange failed (${res.status}): ${body}`);
  }

  const json = await res.json() as { access_token: string };
  return json.access_token;
}
