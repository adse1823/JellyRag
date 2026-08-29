// QBO REST API wrapper.
// Handles: token refresh before expiry, base URL, typed responses.
// All functions that call QBO import from here — one place to update
// if QBO API version or auth scheme changes.

import { DB } from "./db";

const QBO_BASE = "https://quickbooks.api.intuit.com/v3/company";
const QBO_VERSION = "65"; // minorversion
const TOKEN_URL = "https://oauth.platform.intuit.com/oauth2/v1/tokens/bearer";

export interface QBOConnection {
  organization_id: string;
  realm_id: string;
  access_token: string;
  refresh_token: string;
  token_expires_at: string;
}

export interface QBOAccount {
  Id: string;
  Name: string;
  AccountType: string;
  AccountSubType: string;
  FullyQualifiedName: string;
  Active: boolean;
}

export interface QBOTransaction {
  Id: string;
  TxnDate: string;
  PrivateNote?: string;
  TotalAmt: number;
  Line?: QBOLine[];
  EntityRef?: { value: string; name: string };
  PaymentMethodRef?: { value: string };
  AccountRef?: { value: string; name: string };
  SyncToken: string;
}

export interface QBOLine {
  DetailType: string;
  Amount: number;
  AccountBasedExpenseLineDetail?: { AccountRef: { value: string; name: string } };
  DepositLineDetail?: { AccountRef: { value: string; name: string } };
  Description?: string;
}

// ── Token refresh ─────────────────────────────────────────────

async function refreshAccessToken(
  db: DB,
  connection: QBOConnection
): Promise<QBOConnection> {
  const clientId = process.env.QBO_CLIENT_ID!;
  const clientSecret = process.env.QBO_CLIENT_SECRET!;
  const credentials = Buffer.from(`${clientId}:${clientSecret}`).toString("base64");

  const res = await fetch(TOKEN_URL, {
    method: "POST",
    headers: {
      Authorization: `Basic ${credentials}`,
      "Content-Type": "application/x-www-form-urlencoded",
      Accept: "application/json",
    },
    body: new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: connection.refresh_token,
    }),
  });

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`QBO token refresh failed (${res.status}): ${body}`);
  }

  const data = await res.json() as {
    access_token: string;
    refresh_token: string;
    expires_in: number;
  };

  const expiresAt = new Date(Date.now() + data.expires_in * 1000).toISOString();

  // Persist new tokens
  await db
    .from("integration_connections")
    .update({
      access_token: data.access_token,
      refresh_token: data.refresh_token,
      token_expires_at: expiresAt,
      updated_at: new Date().toISOString(),
    })
    .eq("organization_id", connection.organization_id)
    .eq("provider", "qbo");

  return { ...connection, access_token: data.access_token, refresh_token: data.refresh_token, token_expires_at: expiresAt };
}

// Load the active QBO connection for an org, refreshing the token if needed.
export async function getQBOConnection(db: DB, orgId: string): Promise<QBOConnection> {
  const { data, error } = await db
    .from("integration_connections")
    .select("organization_id, qbo_realm_id, access_token, refresh_token, token_expires_at")
    .eq("organization_id", orgId)
    .eq("provider", "qbo")
    .eq("status", "active")
    .single();

  if (error || !data) throw new Error(`No active QBO connection for org ${orgId}`);

  const conn: QBOConnection = {
    organization_id: data.organization_id,
    realm_id: data.qbo_realm_id,
    access_token: data.access_token,
    refresh_token: data.refresh_token,
    token_expires_at: data.token_expires_at,
  };

  // Refresh if expiring within 5 minutes
  const expiresAt = new Date(conn.token_expires_at).getTime();
  if (Date.now() + 5 * 60 * 1000 >= expiresAt) {
    return refreshAccessToken(db, conn);
  }

  return conn;
}

// ── API helpers ───────────────────────────────────────────────

function qboHeaders(accessToken: string) {
  return {
    Authorization: `Bearer ${accessToken}`,
    Accept: "application/json",
    "Content-Type": "application/json",
  };
}

function qboUrl(realmId: string, path: string): string {
  return `${QBO_BASE}/${realmId}/${path}?minorversion=${QBO_VERSION}`;
}

// Run a QBO query (SQL-like syntax against QBO entities).
export async function qboQuery<T>(
  conn: QBOConnection,
  query: string
): Promise<T[]> {
  const url = `${QBO_BASE}/${conn.realm_id}/query?query=${encodeURIComponent(query)}&minorversion=${QBO_VERSION}`;
  const res = await fetch(url, { headers: qboHeaders(conn.access_token) });

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`QBO query failed (${res.status}): ${body}`);
  }

  const json = await res.json() as { QueryResponse: Record<string, T[]> };
  const keys = Object.keys(json.QueryResponse).filter((k) => k !== "startPosition" && k !== "maxResults" && k !== "totalCount");
  return (json.QueryResponse[keys[0]] ?? []) as T[];
}

// Fetch a single QBO entity by ID.
export async function qboGet<T>(
  conn: QBOConnection,
  entity: string,
  id: string
): Promise<T> {
  const res = await fetch(qboUrl(conn.realm_id, `${entity}/${id}`), {
    headers: qboHeaders(conn.access_token),
  });

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`QBO GET ${entity}/${id} failed (${res.status}): ${body}`);
  }

  const json = await res.json() as Record<string, T>;
  const key = entity.charAt(0).toUpperCase() + entity.slice(1);
  return json[key] as T;
}

// Sparse-update a QBO entity.
export async function qboUpdate<T>(
  conn: QBOConnection,
  entity: string,
  payload: object
): Promise<T> {
  const url = `${QBO_BASE}/${conn.realm_id}/${entity}?operation=update&minorversion=${QBO_VERSION}`;
  const res = await fetch(url, {
    method: "POST",
    headers: qboHeaders(conn.access_token),
    body: JSON.stringify(payload),
  });

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`QBO update ${entity} failed (${res.status}): ${body}`);
  }

  const json = await res.json() as Record<string, T>;
  const key = entity.charAt(0).toUpperCase() + entity.slice(1);
  return json[key] as T;
}

// Fetch all accounts from QBO chart of accounts.
export async function fetchQBOAccounts(conn: QBOConnection): Promise<QBOAccount[]> {
  return qboQuery<QBOAccount>(conn, "SELECT * FROM Account WHERE Active = true MAXRESULTS 1000");
}

// Fetch transactions modified since a given date.
// QBO supports Purchase (expenses), Deposit (income), and more.
export async function fetchQBOTransactionsSince(
  conn: QBOConnection,
  since: Date,
  entityType: "Purchase" | "Deposit" | "CreditMemo"
): Promise<QBOTransaction[]> {
  const sinceStr = since.toISOString().split("T")[0];
  const all: QBOTransaction[] = [];
  let startPos = 1;
  const pageSize = 100;

  while (true) {
    const batch = await qboQuery<QBOTransaction>(
      conn,
      `SELECT * FROM ${entityType} WHERE MetaData.LastUpdatedTime > '${sinceStr}' STARTPOSITION ${startPos} MAXRESULTS ${pageSize}`
    );
    all.push(...batch);
    if (batch.length < pageSize) break;
    startPos += pageSize;
  }

  return all;
}
