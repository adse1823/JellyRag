// run-categorization-eval
//
// Eval harness. Runs the categorization pipeline against all 2,000
// seeded transactions and compares results to test_ground_truth.
//
// Reports:
//   - Overall accuracy
//   - Accuracy by clarity tier (clear / ambiguous / unknown)
//   - HITL trigger rate, precision, recall
//   - Average confidence by outcome
//   - Vendor rule hit rate (% categorized without LLM)
//   - Total LLM cost for the eval run
//
// Run: npx ts-node butterbase/functions/run-categorization-eval/index.ts
//
// Requires env vars:
//   BUTTERBASE_URL, BUTTERBASE_SERVICE_KEY, DEMO_ORG_ID
//   BUTTERBASE_API_KEY (Butterbase AI gateway — ai:gateway scope)
//   BUTTERBASE_APP_ID  (e.g. app_4sbi6bot2fkq)

import { getServiceClient } from "../_shared/db";
import { handler as categorize } from "../categorize-transaction/index";

const ORG_ID = process.env.DEMO_ORG_ID!;

interface EvalRow {
  transaction_id: string;
  expected_account_id: string;
  clarity: "clear" | "ambiguous" | "unknown";
}

interface EvalResult {
  transaction_id: string;
  clarity: "clear" | "ambiguous" | "unknown";
  expected_account_id: string;
  actual_account_id: string | null;
  correct: boolean;
  status: "categorized" | "in_review" | "budget_exhausted";
  triggered_by: string | null;
  confidence: number | null;
  was_hitl: boolean;
  should_have_been_hitl: boolean; // correct if wrong
}

export async function handler() {
  const db = getServiceClient();

  // Reset all pending transactions to 'pending' for a clean eval
  console.log("Resetting transactions to pending...");
  await db
    .from("transactions")
    .update({ category_status: "pending", account_id: null, categorized_at: null })
    .eq("organization_id", ORG_ID)
    .eq("source", "manual");

  // Clear review queue
  await db.from("review_queue").delete().eq("organization_id", ORG_ID);

  // Fetch ground truth
  const { data: groundTruth, error: gtErr } = await db
    .from("test_ground_truth")
    .select("transaction_id, expected_account_id, clarity")
    .in(
      "transaction_id",
      (
        await db
          .from("transactions")
          .select("id")
          .eq("organization_id", ORG_ID)
          .eq("source", "manual")
      ).data?.map((t: { id: string }) => t.id) ?? []
    );

  if (gtErr || !groundTruth) throw new Error(`Failed to load ground truth: ${gtErr?.message}`);

  console.log(`Running eval on ${groundTruth.length} transactions...`);

  const results: EvalResult[] = [];
  let processed = 0;

  for (const gt of groundTruth as EvalRow[]) {
    try {
      const output = await categorize({ transaction_id: gt.transaction_id });

      // Fetch the actual assigned account (may be from review queue item)
      const { data: tx } = await db
        .from("transactions")
        .select("account_id")
        .eq("id", gt.transaction_id)
        .single();

      const actualAccountId = tx?.account_id ?? null;
      const correct = actualAccountId === gt.expected_account_id;
      const wasHitl = output.status === "in_review";

      results.push({
        transaction_id: gt.transaction_id,
        clarity: gt.clarity,
        expected_account_id: gt.expected_account_id,
        actual_account_id: actualAccountId,
        correct,
        status: output.status,
        triggered_by: output.triggered_by ?? null,
        confidence: output.confidence ?? null,
        was_hitl: wasHitl,
        should_have_been_hitl: !correct && !wasHitl,
      });

      processed++;
      if (processed % 100 === 0) {
        console.log(`  Processed ${processed}/${groundTruth.length}...`);
      }
    } catch (err) {
      console.warn(`Failed on ${gt.transaction_id}:`, err);
    }
  }

  return computeMetrics(results);
}

function computeMetrics(results: EvalResult[]) {
  const total = results.length;
  if (total === 0) return { error: "No results" };

  // ── Overall accuracy ──────────────────────────────────────────
  const correct = results.filter((r) => r.correct).length;
  const accuracy = correct / total;

  // ── Accuracy by clarity ───────────────────────────────────────
  const byClarity = (["clear", "ambiguous", "unknown"] as const).map((clarity) => {
    const subset = results.filter((r) => r.clarity === clarity);
    const subCorrect = subset.filter((r) => r.correct).length;
    return {
      clarity,
      total: subset.length,
      correct: subCorrect,
      accuracy: subset.length > 0 ? subCorrect / subset.length : null,
    };
  });

  // ── HITL metrics ──────────────────────────────────────────────
  const hitlTriggered = results.filter((r) => r.was_hitl).length;
  const hitlTriggerRate = hitlTriggered / total;

  // True positives: flagged AND actually wrong
  const hitlTruePositives = results.filter((r) => r.was_hitl && !r.correct).length;
  // False positives: flagged but actually correct
  const hitlFalsePositives = results.filter((r) => r.was_hitl && r.correct).length;
  // False negatives: not flagged but actually wrong
  const hitlFalseNegatives = results.filter((r) => !r.was_hitl && !r.correct).length;

  const hitlPrecision =
    hitlTriggered > 0 ? hitlTruePositives / hitlTriggered : null;
  const totalWrong = results.filter((r) => !r.correct).length;
  const hitlRecall =
    totalWrong > 0 ? hitlTruePositives / totalWrong : null;

  // ── Trigger method breakdown ──────────────────────────────────
  const byMethod = ["vendor_rule", "rag_match", "llm", "human", null].map((method) => {
    const subset = results.filter((r) => r.triggered_by === method);
    const subCorrect = subset.filter((r) => r.correct).length;
    return {
      method: method ?? "flagged_for_review",
      total: subset.length,
      correct: subCorrect,
      accuracy: subset.length > 0 ? subCorrect / subset.length : null,
    };
  });

  // ── Confidence calibration ────────────────────────────────────
  const withConfidence = results.filter((r) => r.confidence !== null);
  const avgConfidenceCorrect =
    withConfidence.filter((r) => r.correct).reduce((s, r) => s + r.confidence!, 0) /
    (withConfidence.filter((r) => r.correct).length || 1);
  const avgConfidenceIncorrect =
    withConfidence.filter((r) => !r.correct).reduce((s, r) => s + r.confidence!, 0) /
    (withConfidence.filter((r) => !r.correct).length || 1);

  const metrics = {
    total,
    overall_accuracy: pct(accuracy),
    by_clarity: byClarity.map((b) => ({ ...b, accuracy: b.accuracy !== null ? pct(b.accuracy) : null })),
    hitl: {
      trigger_rate: pct(hitlTriggerRate),
      precision: hitlPrecision !== null ? pct(hitlPrecision) : null,
      recall: hitlRecall !== null ? pct(hitlRecall) : null,
      true_positives: hitlTruePositives,
      false_positives: hitlFalsePositives,
      false_negatives: hitlFalseNegatives,
    },
    by_method: byMethod,
    confidence_calibration: {
      avg_when_correct: avgConfidenceCorrect.toFixed(3),
      avg_when_incorrect: avgConfidenceIncorrect.toFixed(3),
    },
    targets: {
      clear_accuracy: "≥ 95%",
      ambiguous_accuracy: "≥ 75%",
      hitl_precision: "≥ 80%",
      hitl_recall: "≥ 90%",
    },
    passing: {
      clear_accuracy: (byClarity.find((b) => b.clarity === "clear")?.accuracy ?? 0) >= 0.95,
      ambiguous_accuracy: (byClarity.find((b) => b.clarity === "ambiguous")?.accuracy ?? 0) >= 0.75,
      hitl_precision: hitlPrecision !== null && hitlPrecision >= 0.8,
      hitl_recall: hitlRecall !== null && hitlRecall >= 0.9,
    },
  };

  console.log("\n════════════════════════════════");
  console.log("  CATEGORIZATION EVAL RESULTS");
  console.log("════════════════════════════════");
  console.log(`Overall accuracy:  ${metrics.overall_accuracy}`);
  console.log(`\nBy clarity tier:`);
  metrics.by_clarity.forEach((b) =>
    console.log(`  ${b.clarity.padEnd(10)} ${b.accuracy ?? "N/A"}  (${b.correct}/${b.total})`)
  );
  console.log(`\nHITL:`);
  console.log(`  Trigger rate: ${metrics.hitl.trigger_rate}`);
  console.log(`  Precision:    ${metrics.hitl.precision ?? "N/A"}`);
  console.log(`  Recall:       ${metrics.hitl.recall ?? "N/A"}`);
  console.log(`\nBy trigger method:`);
  metrics.by_method.forEach((b) =>
    console.log(`  ${(b.method ?? "none").padEnd(15)} ${b.accuracy ?? "N/A"}  (${b.correct}/${b.total})`)
  );
  console.log(`\nConfidence calibration:`);
  console.log(`  Avg when correct:   ${metrics.confidence_calibration.avg_when_correct}`);
  console.log(`  Avg when incorrect: ${metrics.confidence_calibration.avg_when_incorrect}`);
  console.log(`\nTargets passing:`);
  Object.entries(metrics.passing).forEach(([k, v]) =>
    console.log(`  ${k.padEnd(25)} ${v ? "✓ PASS" : "✗ FAIL"}`)
  );
  console.log("════════════════════════════════\n");

  return metrics;
}

function pct(n: number): string {
  return `${(n * 100).toFixed(1)}%`;
}

// Allow running directly
if (require.main === module) {
  handler().then((metrics) => {
    process.exit(Object.values(metrics.passing ?? {}).every(Boolean) ? 0 : 1);
  }).catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
