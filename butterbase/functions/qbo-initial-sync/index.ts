// qbo-initial-sync
//
// Runs once after QBO OAuth connects. Pulls:
//   1. Full chart of accounts → chart_of_accounts table
//   2. Last 12 months of transactions (Purchase, Deposit, CreditMemo)
//      → transactions table
//   3. Enqueues each new transaction for categorization
//
// Input:  { organization_id: string }
// Output: { accounts_synced: number; transactions_synced: number }

import { getServiceClient } from "../_shared/db";
import { getQBOConnection, fetchQBOAccounts, fetchQBOTransactionsSince, QBOTransaction } from "../_shared/qbo-client";
import { handler as categorize } from "../categorize-transaction/index";

export async function handler(input: { organization_id: string }) {
  const db = getServiceClient();
  const orgId = input.organization_id;
  const conn = await getQBOConnection(db, orgId);

  // ── 1. Sync chart of accounts ──────────────────────────────────
  const qboAccounts = await fetchQBOAccounts(conn);

  const accountRows = qboAccounts.map((a) => ({
    organization_id: orgId,
    qbo_account_id: a.Id,
    name: a.Name,
    account_type: a.AccountType,
    account_subtype: a.AccountSubType ?? null,
    full_name: a.FullyQualifiedName,
    is_active: a.Active,
    synced_at: new Date().toISOString(),
  }));

  if (accountRows.length > 0) {
    const { error } = await db
      .from("chart_of_accounts")
      .upsert(accountRows, { onConflict: "organization_id,qbo_account_id" });
    if (error) throw new Error(`chart_of_accounts upsert failed: ${error.message}`);
  }

  // ── 2. Sync transactions (last 12 months) ──────────────────────
  const since = new Date();
  since.setMonth(since.getMonth() - 12);

  const [purchases, deposits, credits] = await Promise.all([
    fetchQBOTransactionsSince(conn, since, "Purchase"),
    fetchQBOTransactionsSince(conn, since, "Deposit"),
    fetchQBOTransactionsSince(conn, since, "CreditMemo"),
  ]);

  const allTxs = [
    ...purchases.map((t) => normalizeQBOTransaction(t, "expense", orgId)),
    ...deposits.map((t) => normalizeQBOTransaction(t, "income", orgId)),
    ...credits.map((t) => normalizeQBOTransaction(t, "refund", orgId)),
  ];

  let txSynced = 0;
  const BATCH = 100;

  for (let i = 0; i < allTxs.length; i += BATCH) {
    const batch = allTxs.slice(i, i + BATCH);
    const { data: inserted, error } = await db
      .from("transactions")
      .upsert(batch, { onConflict: "organization_id,source,external_id", ignoreDuplicates: true })
      .select("id, category_status");

    if (error) {
      console.warn(`Transaction batch upsert error: ${error.message}`);
      continue;
    }

    // Enqueue only newly inserted (pending) rows for categorization
    const pending = (inserted ?? []).filter((r: { category_status: string }) => r.category_status === "pending");
    txSynced += pending.length;

    // Categorize in background — don't block sync completion
    for (const row of pending as { id: string }[]) {
      categorize({ transaction_id: row.id }).catch((err) =>
        console.warn(`categorize failed for ${row.id}:`, err)
      );
    }
  }

  return { accounts_synced: accountRows.length, transactions_synced: txSynced };
}

// ── Normalize QBO transaction to our schema ────────────────────

function normalizeQBOTransaction(
  t: QBOTransaction,
  txType: "expense" | "income" | "refund",
  orgId: string
) {
  // Extract vendor/payee name from the entity reference
  const vendorName = t.EntityRef?.name ?? extractVendorFromLines(t) ?? null;

  // Extract description from private note or first line description
  const description =
    t.PrivateNote ??
    t.Line?.[0]?.Description ??
    `${txType} ${t.Id}`;

  // Amount: always stored as positive; type conveys direction
  const amount = Math.abs(t.TotalAmt ?? 0);

  return {
    organization_id: orgId,
    source: "qbo" as const,
    external_id: t.Id,
    date: t.TxnDate,
    description,
    vendor_name: vendorName,
    amount_usd: amount,
    transaction_type: txType,
    category_status: "pending" as const,
    qbo_write_status: "pending" as const,
  };
}

function extractVendorFromLines(t: QBOTransaction): string | null {
  for (const line of t.Line ?? []) {
    const ref =
      line.AccountBasedExpenseLineDetail?.AccountRef?.name ??
      line.DepositLineDetail?.AccountRef?.name;
    if (ref) return ref;
  }
  return null;
}
