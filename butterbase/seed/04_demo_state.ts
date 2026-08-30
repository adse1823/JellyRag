// ============================================================
// seed/04_demo_state.ts
//
// Seeds the "3 months in" demo state:
//   - Jan–Mar 2024 transactions marked as categorized (from ground truth)
//   - Categorization events for each (realistic trigger mix)
//   - 15 additional vendor rules auto-created from HITL decisions
//   - 6 review queue items for recent ambiguous transactions
//   - Calls generate-embeddings batch so RAG memory is warm
//
// Run AFTER seeds 01, 02, 03 have been applied.
//
// Run: npx ts-node butterbase/seed/04_demo_state.ts
//
// Requires env vars:
//   BUTTERBASE_URL, BUTTERBASE_SERVICE_KEY (consumed by getServiceClient)
//   DEMO_ORG_ID
// ============================================================

import { randomUUID } from "crypto";
import { getServiceClient } from "../functions/_shared/db";
import { handler as generateEmbeddings } from "../functions/generate-embeddings/index";

const db = getServiceClient();

const ORG_ID = process.env.DEMO_ORG_ID!;

// Vendor rules that would have been auto-created from HITL decisions over 3 months
const LEARNED_RULES: Array<{
  vendor_pattern: string;
  match_type: "exact" | "prefix" | "contains";
  qbo_account_id: string;
}> = [
  // Ambiguous → resolved via HITL, rule auto-created
  { vendor_pattern: "AMAZON MARKETPLACE",    match_type: "prefix",   qbo_account_id: "10" }, // COGS
  { vendor_pattern: "ULINE",                 match_type: "prefix",   qbo_account_id: "27" }, // Shipping supplies
  { vendor_pattern: "HOME DEPOT",            match_type: "prefix",   qbo_account_id: "27" }, // Packaging / shipping supplies
  { vendor_pattern: "INK AND TONER",         match_type: "contains", qbo_account_id: "26" }, // Office supplies
  { vendor_pattern: "COSTCO WHOLESALE ONLINE", match_type: "prefix", qbo_account_id: "10" }, // Inventory/COGS
  { vendor_pattern: "WIRE TRANSFER",         match_type: "prefix",   qbo_account_id: "40" }, // Bank transfer

  // Unknown vendors that appeared and got resolved
  { vendor_pattern: "NEXGEN FREIGHT",        match_type: "prefix",   qbo_account_id: "11" }, // Shipping
  { vendor_pattern: "MERIDIAN CREATIVE",     match_type: "prefix",   qbo_account_id: "20" }, // Advertising
  { vendor_pattern: "BRIGHTLAND SOLUTIONS",  match_type: "prefix",   qbo_account_id: "25" }, // Software
  { vendor_pattern: "PAYSIGN",               match_type: "prefix",   qbo_account_id: "24" }, // Payment processing
  { vendor_pattern: "SVC MARKETPLACE",       match_type: "prefix",   qbo_account_id: "10" }, // COGS

  // New vendors that appeared in months 2–3
  { vendor_pattern: "TIKTOK ADS",            match_type: "prefix",   qbo_account_id: "20" }, // Advertising
  { vendor_pattern: "KLAVIYO",               match_type: "prefix",   qbo_account_id: "25" }, // Software
  { vendor_pattern: "GORGIAS",               match_type: "prefix",   qbo_account_id: "25" }, // Software
  { vendor_pattern: "AFTERSHIP",             match_type: "prefix",   qbo_account_id: "25" }, // Software
];

// Trigger distribution for categorization events (realistic: vendor rules dominate)
const TRIGGER_WEIGHTS = [
  { trigger: "vendor_rule" as const, weight: 60 },
  { trigger: "rag_match"  as const, weight: 20 },
  { trigger: "llm"        as const, weight: 15 },
  { trigger: "human"      as const, weight: 5  },
];

function pickTrigger(): "vendor_rule" | "rag_match" | "llm" | "human" {
  const total = TRIGGER_WEIGHTS.reduce((s, w) => s + w.weight, 0);
  let r = Math.random() * total;
  for (const { trigger, weight } of TRIGGER_WEIGHTS) {
    r -= weight;
    if (r <= 0) return trigger;
  }
  return "vendor_rule";
}

function randConfidence(trigger: string): number {
  if (trigger === "vendor_rule") return 1.0;
  if (trigger === "rag_match") return parseFloat((0.80 + Math.random() * 0.15).toFixed(2));
  if (trigger === "llm") return parseFloat((0.70 + Math.random() * 0.20).toFixed(2));
  return 1.0; // human
}

function randDateInRange(start: string, end: string): string {
  const s = new Date(start).getTime();
  const e = new Date(end).getTime();
  return new Date(s + Math.random() * (e - s)).toISOString();
}

async function seed() {
  if (!ORG_ID) throw new Error("DEMO_ORG_ID env var is required");

  // ── 1. Fetch all Jan–Mar transactions with ground truth ───────
  console.log("Fetching Jan–Mar transactions and ground truth...");

  const { data: janMarTxs, error: txErr } = await db
    .from("transactions")
    .select("id, date")
    .eq("organization_id", ORG_ID)
    .eq("source", "manual")
    .gte("date", "2024-01-01")
    .lte("date", "2024-03-31");

  if (txErr || !janMarTxs) {
    console.error("Failed to fetch transactions:", txErr);
    process.exit(1);
  }

  const txIds = janMarTxs.map((t: { id: string }) => t.id);
  console.log(`  Found ${txIds.length} transactions in Jan–Mar.`);

  const { data: groundTruth, error: gtErr } = await db
    .from("test_ground_truth")
    .select("transaction_id, expected_account_id")
    .in("transaction_id", txIds);

  if (gtErr || !groundTruth) {
    console.error("Failed to fetch ground truth:", gtErr);
    process.exit(1);
  }

  const gtMap = new Map(
    (groundTruth as { transaction_id: string; expected_account_id: string }[]).map(
      (g) => [g.transaction_id, g.expected_account_id]
    )
  );

  // ── 2. Mark transactions as categorized ──────────────────────
  console.log("Marking transactions as categorized...");

  const BATCH = 100;
  for (let i = 0; i < txIds.length; i += BATCH) {
    const batchIds = txIds.slice(i, i + BATCH);
    for (const txId of batchIds) {
      const accountId = gtMap.get(txId);
      if (!accountId) continue;

      const txDate = janMarTxs.find((t: { id: string }) => t.id === txId)?.date ?? "2024-01-15";
      const categorizedAt = randDateInRange(`${txDate}T08:00:00Z`, `${txDate}T20:00:00Z`);

      await db
        .from("transactions")
        .update({
          category_status: "categorized",
          account_id: accountId,
          categorized_at: categorizedAt,
        })
        .eq("id", txId);
    }
    console.log(`  Categorized batch ${Math.floor(i / BATCH) + 1}/${Math.ceil(txIds.length / BATCH)}`);
  }

  // ── 3. Create categorization events ──────────────────────────
  console.log("Creating categorization events...");

  const events = (groundTruth as { transaction_id: string; expected_account_id: string }[])
    .filter((g) => gtMap.has(g.transaction_id))
    .map((g) => {
      const trigger = pickTrigger();
      const txDate = janMarTxs.find((t: { id: string }) => t.id === g.transaction_id)?.date ?? "2024-01-15";
      return {
        id: randomUUID(),
        organization_id: ORG_ID,
        transaction_id: g.transaction_id,
        triggered_by: trigger,
        account_id: g.expected_account_id,
        confidence: randConfidence(trigger),
        reasoning: trigger === "vendor_rule"
          ? "Matched vendor rule — no LLM call required."
          : trigger === "rag_match"
          ? "Top RAG match confidence exceeded threshold."
          : trigger === "llm"
          ? "LLM categorized based on vendor name and transaction context."
          : "Human reviewer confirmed categorization.",
        created_at: randDateInRange(`${txDate}T08:00:00Z`, `${txDate}T20:00:00Z`),
      };
    });

  for (let i = 0; i < events.length; i += BATCH) {
    const { error } = await db
      .from("categorization_events")
      .insert(events.slice(i, i + BATCH));
    if (error) {
      console.error(`Event batch ${Math.floor(i / BATCH) + 1} failed:`, error);
      process.exit(1);
    }
  }
  console.log(`  Created ${events.length} categorization events.`);

  // ── 4. Add learned vendor rules ───────────────────────────────
  console.log("Adding learned vendor rules...");

  const { data: accounts, error: acctErr } = await db
    .from("chart_of_accounts")
    .select("id, qbo_account_id")
    .eq("organization_id", ORG_ID);

  if (acctErr || !accounts) {
    console.error("Failed to fetch accounts:", acctErr);
    process.exit(1);
  }

  const accountMap = new Map(
    (accounts as { id: string; qbo_account_id: string }[]).map((a) => [a.qbo_account_id, a.id])
  );

  const ruleRows = LEARNED_RULES.map((rule) => {
    const accountId = accountMap.get(rule.qbo_account_id);
    if (!accountId) throw new Error(`No account for qbo_account_id ${rule.qbo_account_id}`);
    return {
      organization_id: ORG_ID,
      vendor_pattern: rule.vendor_pattern,
      match_type: rule.match_type,
      account_id: accountId,
      confidence: 0.95,
      created_by: null,
    };
  });

  const { error: ruleErr } = await db
    .from("vendor_rules")
    .upsert(ruleRows, { onConflict: "organization_id,vendor_pattern" });

  if (ruleErr) {
    console.error("Vendor rule insert failed:", ruleErr);
    process.exit(1);
  }
  console.log(`  Added ${ruleRows.length} learned vendor rules.`);

  // ── 5. Seed review queue (6 recent ambiguous transactions) ────
  console.log("Seeding review queue...");

  // Pick 6 pending ambiguous/unknown transactions from April onwards
  const { data: reviewCandidates } = await db
    .from("transactions")
    .select("id, vendor_name, amount_usd")
    .eq("organization_id", ORG_ID)
    .eq("category_status", "pending")
    .gte("date", "2024-04-01")
    .limit(6);

  if (reviewCandidates && reviewCandidates.length > 0) {
    const { data: candidateGT } = await db
      .from("test_ground_truth")
      .select("transaction_id, expected_account_id")
      .in("transaction_id", reviewCandidates.map((t: { id: string }) => t.id));

    const candidateGTMap = new Map(
      (candidateGT ?? []).map((g: { transaction_id: string; expected_account_id: string }) => [
        g.transaction_id,
        g.expected_account_id,
      ])
    );

    const queueRows = reviewCandidates.map((tx: { id: string; vendor_name: string; amount_usd: number }) => {
      const suggestedAccountId = candidateGTMap.get(tx.id) ?? null;
      const isHighValue = tx.amount_usd > 500;
      const flagReasons: string[] = [];
      if (isHighValue) flagReasons.push("amount_threshold");
      flagReasons.push("low_confidence");

      return {
        id: randomUUID(),
        organization_id: ORG_ID,
        transaction_id: tx.id,
        flag_reasons: flagReasons,
        flag_metadata: {
          amount_usd: tx.amount_usd,
          vendor_name: tx.vendor_name,
        },
        suggested_account_id: suggestedAccountId,
        suggested_confidence: parseFloat((0.55 + Math.random() * 0.25).toFixed(2)),
        suggested_reasoning: `Vendor "${tx.vendor_name}" has not been seen before or has ambiguous categorization. Human review recommended.`,
        status: "pending",
      };
    });

    // Mark these transactions as in_review
    await db
      .from("transactions")
      .update({ category_status: "in_review" })
      .in("id", reviewCandidates.map((t: { id: string }) => t.id));

    const { error: qErr } = await db.from("review_queue").insert(queueRows);
    if (qErr) {
      console.error("Review queue insert failed:", qErr);
      process.exit(1);
    }
    console.log(`  Created ${queueRows.length} review queue items.`);
  } else {
    console.log("  No candidates found for review queue — skipping.");
  }

  // ── 6. Generate embeddings for all categorized transactions ───
  console.log("\nGenerating embeddings (this may take a minute)...");
  try {
    const result = await generateEmbeddings({ batch_org_id: ORG_ID });
    console.log(`  Embedded ${result.embedded} transactions.`);
  } catch (err) {
    console.warn("  Embedding generation failed (check API keys):", err);
    console.warn("  Re-run: npx ts-node butterbase/functions/generate-embeddings/index.ts");
  }

  console.log("\n✓ Demo state seeded successfully.");
  console.log(`  Jan–Mar categorized: ${txIds.length} transactions`);
  console.log(`  Total vendor rules:  20 (initial) + ${LEARNED_RULES.length} (learned) = ${20 + LEARNED_RULES.length}`);
  console.log(`  Review queue:        6 items pending`);
}

seed().catch(console.error);
