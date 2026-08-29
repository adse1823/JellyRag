// qbo-webhook-handler
//
// Receives QBO webhook notifications for transaction create/update.
// QBO sends a batch of entity change events; we fetch each changed
// entity and upsert it, then enqueue categorization if needed.
//
// QBO webhook docs: https://developer.intuit.com/app/developer/qbo/docs/develop/webhooks
//
// Input:  raw webhook payload from QBO (validated by HMAC signature)
// Output: { processed: number }
//
// This function is exposed as an HTTP endpoint. The calling
// infrastructure (Butterbase gateway or Next.js API route) must:
//   1. Validate the Intuit-Signature-Hash header before calling this handler
//   2. Respond 200 immediately — QBO retries on non-2xx

import { getServiceClient } from "../_shared/db";
import { getQBOConnection, qboGet, QBOTransaction } from "../_shared/qbo-client";
import { handler as categorize } from "../categorize-transaction/index";
import { createHmac } from "crypto";

interface QBOWebhookPayload {
  eventNotifications: Array<{
    realmId: string;
    dataChangeEvent: {
      entities: Array<{
        name: string;   // 'Purchase' | 'Deposit' | 'CreditMemo' | 'Account' | ...
        id: string;
        operation: "Create" | "Update" | "Delete" | "Merge" | "Void";
        lastUpdated: string;
      }>;
    };
  }>;
}

// Validate QBO webhook HMAC signature.
// Must be called before handler() in the HTTP layer.
export function validateQBOWebhook(
  rawBody: string,
  signatureHeader: string,
  webhookToken: string
): boolean {
  const expected = createHmac("sha256", webhookToken)
    .update(rawBody)
    .digest("base64");
  return expected === signatureHeader;
}

export async function handler(payload: QBOWebhookPayload) {
  const db = getServiceClient();
  let processed = 0;

  for (const notification of payload.eventNotifications) {
    const realmId = notification.realmId;

    // Find which org owns this realmId
    const { data: connection } = await db
      .from("integration_connections")
      .select("organization_id")
      .eq("qbo_realm_id", realmId)
      .eq("provider", "qbo")
      .eq("status", "active")
      .single();

    if (!connection) {
      console.warn(`No org found for QBO realm ${realmId} — skipping`);
      continue;
    }

    const orgId: string = connection.organization_id;
    const conn = await getQBOConnection(db, orgId);

    for (const entity of notification.dataChangeEvent.entities) {
      // Only handle transaction entities we care about
      const entityType = entity.name;
      if (!["Purchase", "Deposit", "CreditMemo"].includes(entityType)) continue;
      if (entity.operation === "Delete" || entity.operation === "Void") {
        // Mark deleted transactions as excluded from reconciliation
        await db
          .from("transactions")
          .update({ reconciliation_status: "excluded", updated_at: new Date().toISOString() })
          .eq("organization_id", orgId)
          .eq("source", "qbo")
          .eq("external_id", entity.id);
        continue;
      }

      // Fetch the updated entity from QBO
      let qboTx: QBOTransaction;
      try {
        qboTx = await qboGet<QBOTransaction>(conn, entityType.toLowerCase(), entity.id);
      } catch (err) {
        console.warn(`Failed to fetch ${entityType}/${entity.id}:`, err);
        continue;
      }

      const txType = entityType === "Purchase" ? "expense"
        : entityType === "Deposit" ? "income"
        : "refund";

      const vendorName = qboTx.EntityRef?.name ?? null;
      const description = qboTx.PrivateNote ?? qboTx.Line?.[0]?.Description ?? `${txType} ${qboTx.Id}`;
      const amount = Math.abs(qboTx.TotalAmt ?? 0);

      const row = {
        organization_id: orgId,
        source: "qbo" as const,
        external_id: qboTx.Id,
        date: qboTx.TxnDate,
        description,
        vendor_name: vendorName,
        amount_usd: amount,
        transaction_type: txType,
        updated_at: new Date().toISOString(),
      };

      const { data: upserted, error } = await db
        .from("transactions")
        .upsert(
          { ...row, category_status: "pending", qbo_write_status: "pending" },
          { onConflict: "organization_id,source,external_id" }
        )
        .select("id, category_status")
        .single();

      if (error) {
        console.warn(`Upsert failed for ${entityType}/${entity.id}:`, error.message);
        continue;
      }

      // Only enqueue for categorization if it's newly pending
      if (upserted.category_status === "pending") {
        categorize({ transaction_id: upserted.id }).catch((err) =>
          console.warn(`categorize failed for ${upserted.id}:`, err)
        );
      }

      processed++;
    }
  }

  return { processed };
}
