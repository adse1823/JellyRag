// qbo-write-categorization
//
// Writes an approved category back to QuickBooks Online.
// Idempotent: safe to call multiple times for the same event.
// Retries up to 3 times with exponential backoff.
//
// Must be called AFTER the transaction is categorized (status = 'categorized')
// and ONLY for transactions where source = 'qbo'.
//
// Input:
//   { transaction_id: string; categorization_event_id: string }

import { getServiceClient, getTransaction } from "../_shared/db";
import {
  makeIdempotencyKey,
  isAlreadyWritten,
  recordWriteAttempt,
  withRetry,
} from "../_shared/idempotency";

interface Input {
  transaction_id: string;
  categorization_event_id: string;
}

interface Output {
  ok: boolean;
  skipped?: boolean;   // true if already written (idempotency hit)
  qbo_response_id?: string;
}

export async function handler(input: Input): Promise<Output> {
  const db = getServiceClient();
  const { transaction_id, categorization_event_id } = input;

  // ── Idempotency check ─────────────────────────────────────────
  const idempotencyKey = makeIdempotencyKey(transaction_id, categorization_event_id);
  if (await isAlreadyWritten(db, idempotencyKey)) {
    return { ok: true, skipped: true };
  }

  // ── Load transaction ──────────────────────────────────────────
  const tx = await getTransaction(db, transaction_id);

  if (tx.source !== "qbo") {
    // Only QBO transactions need write-back
    return { ok: true, skipped: true };
  }

  if (!tx.account_id) {
    throw new Error(`Transaction ${transaction_id} has no account_id — cannot write back`);
  }

  // ── Load QBO connection ───────────────────────────────────────
  const { data: connection, error: connErr } = await db
    .from("integration_connections")
    .select("access_token, refresh_token, token_expires_at, qbo_realm_id")
    .eq("organization_id", tx.organization_id)
    .eq("provider", "qbo")
    .eq("status", "active")
    .single();

  if (connErr || !connection) {
    throw new Error(`No active QBO connection for org ${tx.organization_id}`);
  }

  // ── Load QBO account ID (external_id from chart_of_accounts) ──
  const { data: account, error: acctErr } = await db
    .from("chart_of_accounts")
    .select("qbo_account_id, name")
    .eq("id", tx.account_id)
    .single();

  if (acctErr || !account) {
    throw new Error(`Account ${tx.account_id} not found`);
  }

  // ── Write to QBO with retry ───────────────────────────────────
  let qboResponseId: string | undefined;

  try {
    qboResponseId = await withRetry(
      () => writeToQBO({
        accessToken: connection.access_token,
        realmId: connection.qbo_realm_id!,
        transaction: {
          external_id: tx.external_id,
          transaction_type: tx.transaction_type,
          qbo_account_id: account.qbo_account_id,
        },
      }),
      { maxAttempts: 3, baseDelayMs: 1000, label: "qbo-write" }
    );

    // Record success
    await recordWriteAttempt(db, {
      organization_id: tx.organization_id,
      transaction_id,
      idempotency_key: idempotencyKey,
      status: "success",
      qbo_response_id: qboResponseId,
    });

    // Update transaction write status
    await db
      .from("transactions")
      .update({ qbo_write_status: "written", qbo_write_at: new Date().toISOString() })
      .eq("id", transaction_id);

    return { ok: true, qbo_response_id: qboResponseId };
  } catch (err) {
    // Record failure for observability
    await recordWriteAttempt(db, {
      organization_id: tx.organization_id,
      transaction_id,
      idempotency_key: idempotencyKey,
      status: "failed",
    });

    await db
      .from("transactions")
      .update({ qbo_write_status: "failed" })
      .eq("id", transaction_id);

    throw err;
  }
}

// ── QBO API call ─────────────────────────────────────────────
// Writes the account assignment back to a QBO transaction.
// QBO's sparse-update API: only include fields being changed.
//
// Endpoint differs by transaction type:
//   expense / fee   → Purchase entity  PATCH /v3/company/{realmId}/purchase
//   income / payout → Deposit entity   PATCH /v3/company/{realmId}/deposit
//   refund          → CreditMemo       PATCH /v3/company/{realmId}/creditmemo
//
// We do a read-then-write (fetch current SyncToken, then sparse update)
// because QBO requires SyncToken to prevent lost-update conflicts.

async function writeToQBO(args: {
  accessToken: string;
  realmId: string;
  transaction: {
    external_id: string;
    transaction_type: string;
    qbo_account_id: string;
  };
}): Promise<string> {
  const { accessToken, realmId, transaction } = args;
  const baseUrl = `https://quickbooks.api.intuit.com/v3/company/${realmId}`;
  const headers = {
    Authorization: `Bearer ${accessToken}`,
    Accept: "application/json",
    "Content-Type": "application/json",
  };

  const entity = qboEntityForType(transaction.transaction_type);
  const entityId = transaction.external_id;

  // Step 1: Read current entity to get SyncToken
  const readRes = await fetch(`${baseUrl}/${entity}/${entityId}?minorversion=65`, { headers });
  if (!readRes.ok) {
    const body = await readRes.text();
    throw new Error(`QBO read failed (${readRes.status}): ${body}`);
  }
  const readBody = await readRes.json() as Record<string, Record<string, unknown>>;
  const currentEntity = readBody[capitalize(entity)];
  const syncToken = currentEntity.SyncToken as string;

  // Step 2: Sparse update — set the account reference
  const updatePayload = buildUpdatePayload(entity, entityId, syncToken, transaction.qbo_account_id);

  const writeRes = await fetch(
    `${baseUrl}/${entity}?operation=update&minorversion=65`,
    { method: "POST", headers, body: JSON.stringify(updatePayload) }
  );

  if (!writeRes.ok) {
    const body = await writeRes.text();
    throw new Error(`QBO write failed (${writeRes.status}): ${body}`);
  }

  const writeBody = await writeRes.json() as Record<string, Record<string, unknown>>;
  return (writeBody[capitalize(entity)]?.Id as string) ?? entityId;
}

function qboEntityForType(transactionType: string): string {
  switch (transactionType) {
    case "expense":
    case "fee":
      return "purchase";
    case "income":
    case "payout":
      return "deposit";
    case "refund":
      return "creditmemo";
    default:
      return "purchase";
  }
}

function capitalize(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

// Builds the minimal QBO sparse-update body.
// The account assignment sits in Line[0].AccountBasedExpenseLineDetail
// for purchases, or Line[0].DepositLineDetail for deposits.
function buildUpdatePayload(
  entity: string,
  id: string,
  syncToken: string,
  qboAccountId: string
): object {
  const accountRef = { value: qboAccountId };

  if (entity === "purchase") {
    return {
      Purchase: {
        Id: id,
        SyncToken: syncToken,
        Line: [
          {
            DetailType: "AccountBasedExpenseLineDetail",
            AccountBasedExpenseLineDetail: { AccountRef: accountRef },
          },
        ],
      },
    };
  }

  if (entity === "deposit") {
    return {
      Deposit: {
        Id: id,
        SyncToken: syncToken,
        Line: [
          {
            DetailType: "DepositLineDetail",
            DepositLineDetail: { AccountRef: accountRef },
          },
        ],
      },
    };
  }

  // creditmemo
  return {
    CreditMemo: {
      Id: id,
      SyncToken: syncToken,
      Line: [
        {
          DetailType: "SalesItemLineDetail",
          SalesItemLineDetail: { ItemAccountRef: accountRef },
        },
      ],
    },
  };
}
