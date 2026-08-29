// Idempotency helpers for QBO write-back.
// Prevents double-posting a categorization to QBO on retries.

import { createHash } from "crypto";
import { DB } from "./db";

// Generate a stable idempotency key for a given write operation.
// Derived from (transaction_id + categorization_event_id) so the
// same event always produces the same key.
export function makeIdempotencyKey(transactionId: string, catEventId: string): string {
  return createHash("sha256")
    .update(`${transactionId}:${catEventId}`)
    .digest("hex");
}

// Check whether this write has already been successfully committed.
// Returns true if a success record exists — caller should skip the write.
export async function isAlreadyWritten(db: DB, idempotencyKey: string): Promise<boolean> {
  const { data } = await db
    .from("qbo_write_log")
    .select("id, status")
    .eq("idempotency_key", idempotencyKey)
    .maybeSingle();

  return data?.status === "success";
}

// Record the outcome of a QBO write attempt.
export async function recordWriteAttempt(
  db: DB,
  args: {
    organization_id: string;
    transaction_id: string;
    idempotency_key: string;
    status: "success" | "failed";
    qbo_response_id?: string | null;
  }
) {
  const { error } = await db.from("qbo_write_log").insert({
    organization_id: args.organization_id,
    transaction_id: args.transaction_id,
    idempotency_key: args.idempotency_key,
    status: args.status,
    qbo_response_id: args.qbo_response_id ?? null,
  });

  // Unique constraint on idempotency_key: if a record already exists
  // (race condition on concurrent retry), ignore the conflict.
  if (error && !error.message.includes("unique")) {
    throw new Error(`recordWriteAttempt failed: ${error.message}`);
  }
}

// Exponential backoff retry wrapper for external API calls.
// maxAttempts: total attempts (1 = no retry).
// baseDelayMs: delay before attempt 2, doubled each time.
export async function withRetry<T>(
  fn: () => Promise<T>,
  opts: { maxAttempts?: number; baseDelayMs?: number; label?: string } = {}
): Promise<T> {
  const { maxAttempts = 3, baseDelayMs = 1000, label = "operation" } = opts;

  let lastError: unknown;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastError = err;
      if (attempt === maxAttempts) break;
      const delay = baseDelayMs * Math.pow(2, attempt - 1);
      console.warn(`${label}: attempt ${attempt} failed, retrying in ${delay}ms`, err);
      await sleep(delay);
    }
  }
  throw lastError;
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
