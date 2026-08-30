// ============================================================
// demo/run.ts
//
// 3-act live demo of the accounting agent pipeline.
//
// Act 1 — Vendor rule: "KLAVIYO MONTHLY" auto-categorized
//          instantly, zero LLM cost.
// Act 2 — Unknown vendor: "LUMINARY CREATIVE GROUP" runs
//          through RAG + LLM, flagged for HITL review.
// Act 3 — Human resolves: accepted + vendor rule created.
//
// Run: npx ts-node butterbase/demo/run.ts
//
// Requires env vars:
//   BUTTERBASE_URL, BUTTERBASE_SERVICE_KEY  (DB access)
//   BUTTERBASE_API_KEY                      (Butterbase AI gateway — ai:gateway scope)
//   BUTTERBASE_APP_ID                       (e.g. app_4sbi6bot2fkq)
//   DEMO_ORG_ID
// ============================================================

import * as readline from "readline";
import { randomUUID } from "crypto";
import { getServiceClient } from "../functions/_shared/db";
import { handler as categorize } from "../functions/categorize-transaction/index";
import { handler as processDecision } from "../functions/process-review-decision/index";

const db = getServiceClient();
const ORG_ID = process.env.DEMO_ORG_ID!;

// ── Terminal formatting ────────────────────────────────────────

const B  = "\x1b[1m";
const D  = "\x1b[2m";
const G  = "\x1b[32m";
const Y  = "\x1b[33m";
const R  = "\x1b[0m";

const bold  = (s: string) => `${B}${s}${R}`;
const dim   = (s: string) => `${D}${s}${R}`;
const green = (s: string) => `${G}${s}${R}`;
const yellow = (s: string) => `${Y}${s}${R}`;

const W = 56;
const sep  = () => console.log("─".repeat(W));
const dsep = () => console.log("═".repeat(W));

function header(title: string) {
  console.log();
  dsep();
  console.log(bold(` ${title}`));
  dsep();
  console.log();
}

function pause(prompt = "Press Enter to continue..."): Promise<void> {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((res) => rl.question(dim(`\n  ${prompt}\n`), () => { rl.close(); res(); }));
}

function usd(n: number) {
  return `$${Math.abs(n).toLocaleString("en-US", { minimumFractionDigits: 2 })}`;
}

// ── DB helpers ─────────────────────────────────────────────────

async function accountName(id: string): Promise<string> {
  const { data } = await db.from("chart_of_accounts").select("name").eq("id", id).single();
  return data?.name ?? id;
}

async function getOrCreateDemoReviewer(): Promise<string> {
  const { data: existing } = await db
    .from("users")
    .select("id")
    .eq("organization_id", ORG_ID)
    .limit(1)
    .maybeSingle();
  if (existing) return existing.id;

  const DEMO_EMAIL = "demo-reviewer@jellyrag.internal";
  const { data: byEmail } = await db
    .from("users")
    .select("id")
    .eq("email", DEMO_EMAIL)
    .maybeSingle();
  if (byEmail) return byEmail.id;

  const { data: newUser, error } = await db
    .from("users")
    .insert({ organization_id: ORG_ID, email: DEMO_EMAIL, role: "owner" })
    .select("id")
    .single();
  if (error) throw new Error(`Failed to create demo reviewer: ${error.message}`);
  return newUser.id;
}

async function getQueueItem(transactionId: string) {
  const { data } = await db
    .from("review_queue")
    .select("id, flag_reasons, suggested_account_id, suggested_confidence, suggested_reasoning")
    .eq("transaction_id", transactionId)
    .eq("status", "pending")
    .maybeSingle();
  return data as {
    id: string;
    flag_reasons: string[];
    suggested_account_id: string | null;
    suggested_confidence: number | null;
    suggested_reasoning: string | null;
  } | null;
}

async function insertTx(opts: {
  vendor_name: string;
  description: string;
  amount_usd: number;
  date: string;
}): Promise<string> {
  const id = randomUUID();
  const { error } = await db.from("transactions").insert({
    id,
    organization_id: ORG_ID,
    source: "manual",
    external_id: `demo-${id}`,
    date: opts.date,
    description: opts.description,
    vendor_name: opts.vendor_name,
    amount_usd: opts.amount_usd,
    transaction_type: "expense",
    category_status: "pending",
  });
  if (error) throw new Error(`Insert failed: ${error.message}`);
  return id;
}

// ── Act 1: Vendor rule hit ─────────────────────────────────────
// KLAVIYO is in the learned vendor rules (seed 04) as a prefix
// match → Software & Technology. No LLM call is made.

async function act1(): Promise<string> {
  header("ACT 1 — Vendor Rule Hit");

  const VENDOR = "KLAVIYO MONTHLY";
  const AMOUNT = 349.00;
  const DATE   = "2024-07-15";

  console.log(`  Transaction:  ${bold(VENDOR.padEnd(32))} ${bold(usd(AMOUNT))}`);
  console.log(`  Date:         ${DATE}`);
  console.log();

  const txId = await insertTx({ vendor_name: VENDOR, description: "KLAVIYO MONTHLY SUBSCRIPTION", amount_usd: AMOUNT, date: DATE });

  console.log(dim("  ▶ Running categorize-transaction..."));

  const t0 = Date.now();
  const result = await categorize({ transaction_id: txId });
  const ms = Date.now() - t0;

  console.log();

  if (result.status === "categorized" && result.triggered_by === "vendor_rule") {
    const name = await accountName(result.account_id!);
    console.log(`  ${green("✓ CATEGORIZED")} ${dim(`in ${ms}ms`)}`);
    console.log(`    Triggered by:  ${bold("vendor_rule")}`);
    console.log(`    Account:       ${bold(name)}`);
    console.log(`    Confidence:    ${bold("100%")}`);
    console.log(`    LLM cost:      ${bold("$0.00")}  ${dim("← zero LLM calls")}`);
  } else {
    console.log(`  ${yellow("⚠")} Unexpected result — expected vendor_rule hit:`, result);
  }

  return txId;
}

// ── Act 2: Unknown vendor → HITL ──────────────────────────────
// LUMINARY CREATIVE GROUP is not in vendor rules and not in RAG
// memory. The LLM categorizes it but confidence is low enough
// (and the amount is high enough) to trigger HITL.
//
// Note: if this vendor was resolved in a prior demo run, a
// vendor rule will exist and it will categorize automatically.
// The setup step below deletes it to ensure a consistent demo.

async function act2(): Promise<{ txId: string; queueItem: Awaited<ReturnType<typeof getQueueItem>> }> {
  header("ACT 2 — Unknown Vendor → HITL Review");

  const VENDOR = "LUMINARY CREATIVE GROUP";
  const AMOUNT = 1250.00;
  const DATE   = "2024-07-22";

  // Clean up any vendor rule from a previous demo run so the demo
  // always reaches the HITL gate.
  await db
    .from("vendor_rules")
    .delete()
    .eq("organization_id", ORG_ID)
    .eq("vendor_pattern", "LUMINARY CREATIVE GROUP");

  console.log(`  Transaction:  ${bold(VENDOR.padEnd(32))} ${bold(usd(AMOUNT))}`);
  console.log(`  Date:         ${DATE}`);
  console.log();

  const txId = await insertTx({ vendor_name: VENDOR, description: "LUMINARY CREATIVE GROUP INV #2847", amount_usd: AMOUNT, date: DATE });

  console.log(dim("  ▶ Running categorize-transaction..."));
  console.log(dim("    Step 1: vendor rules → no match"));
  console.log(dim("    Step 2: RAG retrieval → no confident match"));
  console.log(dim("    Step 3: LLM call (claude-haiku-4-5)..."));

  const t0 = Date.now();
  const result = await categorize({ transaction_id: txId });
  const ms = Date.now() - t0;

  const queueItem = await getQueueItem(txId);
  console.log();

  if (result.status === "in_review" && queueItem) {
    const suggested = queueItem.suggested_account_id
      ? await accountName(queueItem.suggested_account_id)
      : "Unknown";
    const pct = queueItem.suggested_confidence
      ? `${Math.round(queueItem.suggested_confidence * 100)}%`
      : "N/A";
    const reasoning = queueItem.suggested_reasoning
      ? queueItem.suggested_reasoning.slice(0, 110) + (queueItem.suggested_reasoning.length > 110 ? "..." : "")
      : "—";

    console.log(`  ${yellow("⚑ FLAGGED FOR REVIEW")} ${dim(`(${ms}ms)`)}`);
    console.log(`    Flag reasons:   ${bold(queueItem.flag_reasons.join(", "))}`);
    console.log(`    LLM suggestion: ${bold(suggested)}  ${dim(`(${pct})`)}`);
    console.log(`    Reasoning:      ${dim(`"${reasoning}"`)}`);
  } else if (result.status === "categorized") {
    const name = await accountName(result.account_id!);
    const pct  = Math.round((result.confidence ?? 0) * 100);
    console.log(`  ${green("✓ CATEGORIZED")} via ${bold(result.triggered_by ?? "unknown")} ${dim(`(${ms}ms)`)}`);
    console.log(`    Account:    ${bold(name)}`);
    console.log(`    Confidence: ${pct}%`);
    console.log();
    console.log(dim("  (System was confident — Act 3 will be skipped)"));
  } else {
    console.log(`  ${yellow("⚠")} Unexpected result:`, result);
  }

  return { txId, queueItem };
}

// ── Act 3: Human resolves → vendor rule created ────────────────

async function act3(
  queueItem: Awaited<ReturnType<typeof getQueueItem>>
): Promise<void> {
  header("ACT 3 — Human Resolves → Rule Auto-Created");

  if (!queueItem || !queueItem.suggested_account_id) {
    console.log(dim("  (No pending review item — Act 2 categorized automatically.)"));
    return;
  }

  const suggested = await accountName(queueItem.suggested_account_id);
  const pct = queueItem.suggested_confidence
    ? `${Math.round(queueItem.suggested_confidence * 100)}%`
    : "N/A";

  console.log(`  Reviewing:    ${bold("LUMINARY CREATIVE GROUP".padEnd(32))} ${bold(usd(1250))}`);
  console.log(`  Suggestion:   ${bold(suggested)}  ${dim(`(${pct})`)}`);
  console.log();
  console.log(`  Reviewer action: ${bold("Accept suggestion + create vendor rule")}`);
  console.log();
  console.log(dim("  ▶ Running process-review-decision..."));

  const reviewerId = await getOrCreateDemoReviewer();

  const t0 = Date.now();
  const result = await processDecision({
    review_queue_id: queueItem.id,
    reviewer_id: reviewerId,
    account_id: queueItem.suggested_account_id,
    add_vendor_rule: true,
  });
  const ms = Date.now() - t0;

  console.log();

  if (result.ok) {
    console.log(`  ${green("✓ RESOLVED")} ${dim(`in ${ms}ms`)}`);
    console.log(`    Account:     ${bold(suggested)}`);
    sep();
    if (result.vendor_rule_created) {
      console.log(`    Vendor rule created:`);
      console.log(`      Pattern:  ${bold('"LUMINARY CREATIVE GROUP"')}  (exact)`);
      console.log(`      Maps to:  ${bold(suggested)}`);
      console.log();
      console.log(dim(`    Next time this vendor appears: vendor_rule hit, $0.00 LLM cost.`));
    } else if (result.auto_rule_inferred) {
      console.log(dim("    Vendor rule auto-inferred from 3 consistent human decisions."));
    }
  } else {
    console.log(`  ${yellow("⚠")} Unexpected result:`, result);
  }
}

// ── Main ───────────────────────────────────────────────────────

async function main() {
  if (!ORG_ID) throw new Error("DEMO_ORG_ID env var is required");

  console.log();
  dsep();
  console.log(bold("  ACCOUNTING AGENT — LIVE DEMO"));
  console.log(dim("  Vendor rule → RAG → LLM → HITL → rule learned"));
  dsep();

  await pause("Press Enter to start...");

  await act1();
  await pause("Press Enter for Act 2...");

  const { queueItem } = await act2();
  await pause("Press Enter for Act 3...");

  await act3(queueItem);

  console.log();
  dsep();
  console.log(bold("  Demo complete."));
  console.log(dim("  The arc: instant rule hit → ambiguous flag → human resolves → rule learned."));
  dsep();
  console.log();

  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
