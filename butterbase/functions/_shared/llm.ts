// LLM call wrapper.
// Handles: model selection based on budget state, calling Anthropic,
// cost recording, and returning a typed categorization response.

import Anthropic from "@anthropic-ai/sdk";
import { createHash } from "crypto";
import {
  DB,
  getMonthlyBudget,
  upsertMonthlyBudget,
  insertCostEvent,
  incrementBudgetSpend,
} from "./db";

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

// Token prices per million tokens (as of Claude claude-sonnet-4-6 / claude-haiku-4-5)
const TOKEN_PRICES: Record<string, { input: number; output: number }> = {
  "claude-sonnet-4-6": { input: 3.0 / 1e6,  output: 15.0 / 1e6 },
  "claude-haiku-4-5":  { input: 0.25 / 1e6, output: 1.25 / 1e6 },
};

export interface LLMCategorizationResult {
  account_id: string;
  confidence: number;
  reasoning: string;
  alternatives: Array<{ account_id: string; name: string; confidence: number }>;
  model_id: string;
  prompt_hash: string;
  input_tokens: number;
  output_tokens: number;
  cost_usd: number;
}

// Decide which model to use based on current budget state.
// Downgrades to Haiku at 80% spend; blocks at 100%.
export async function resolveModel(
  db: DB,
  orgId: string,
  budgetUsd: number
): Promise<{ model: string; allowed: boolean }> {
  const month = currentMonth();
  await upsertMonthlyBudget(db, orgId, month, budgetUsd);
  const budget = await getMonthlyBudget(db, orgId, month);

  if (!budget || budget.status === "exhausted") {
    return { model: "", allowed: false };
  }

  const pctUsed = budget.spent_usd / budget.budget_usd;
  const model = pctUsed >= 0.8 ? "claude-haiku-4-5" : "claude-sonnet-4-6";
  return { model, allowed: true };
}

export async function categorizationLLMCall(
  db: DB,
  orgId: string,
  prompt: string,
  model: string,
  categorizationEventId?: string
): Promise<LLMCategorizationResult> {
  const promptHash = createHash("sha256").update(prompt).digest("hex");

  const response = await anthropic.messages.create({
    model,
    max_tokens: 512,
    messages: [{ role: "user", content: prompt }],
    system:
      "You are a bookkeeping assistant for an e-commerce company using QuickBooks Online. " +
      "Your job is to assign the correct QBO account category to a financial transaction. " +
      "Respond with valid JSON only. No prose outside the JSON object.",
  });

  const raw = response.content[0].type === "text" ? response.content[0].text : "";
  const parsed = parseCategorizationResponse(raw);

  const inputTokens = response.usage.input_tokens;
  const outputTokens = response.usage.output_tokens;
  const prices = TOKEN_PRICES[model] ?? TOKEN_PRICES["claude-sonnet-4-6"];
  const costUsd = inputTokens * prices.input + outputTokens * prices.output;

  const month = currentMonth();
  await Promise.all([
    insertCostEvent(db, {
      organization_id: orgId,
      categorization_event_id: categorizationEventId ?? null,
      model_id: model,
      input_tokens: inputTokens,
      output_tokens: outputTokens,
      cost_usd: costUsd,
      budget_month: month,
    }),
    incrementBudgetSpend(db, orgId, month, costUsd),
  ]);

  return {
    ...parsed,
    model_id: model,
    prompt_hash: promptHash,
    input_tokens: inputTokens,
    output_tokens: outputTokens,
    cost_usd: costUsd,
  };
}

function parseCategorizationResponse(raw: string): Pick<
  LLMCategorizationResult,
  "account_id" | "confidence" | "reasoning" | "alternatives"
> {
  // Strip markdown code fences if the model adds them
  const cleaned = raw.replace(/```(?:json)?/g, "").trim();
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(cleaned);
  } catch {
    throw new Error(`LLM returned invalid JSON: ${raw.slice(0, 200)}`);
  }

  if (typeof parsed.account_id !== "string") {
    throw new Error(`LLM response missing account_id: ${raw.slice(0, 200)}`);
  }

  return {
    account_id: parsed.account_id as string,
    confidence: typeof parsed.confidence === "number" ? parsed.confidence : 0.5,
    reasoning: typeof parsed.reasoning === "string" ? parsed.reasoning : "",
    alternatives: Array.isArray(parsed.alternatives)
      ? (parsed.alternatives as Array<{ account_id: string; name: string; confidence: number }>)
      : [],
  };
}

export function buildCategorizationPrompt(args: {
  transaction: {
    description: string;
    vendor_name: string | null;
    amount_usd: number;
    date: string;
    transaction_type: string;
  };
  accounts: Array<{ id: string; name: string; account_type: string; account_subtype: string | null; full_name: string }>;
  ragMatches: Array<{ embedded_text: string; account_name: string; similarity: number }>;
  vendorRuleHints: Array<{ vendor_pattern: string; account_name: string }>;
}): string {
  const { transaction, accounts, ragMatches, vendorRuleHints } = args;

  // Filter accounts to relevant types for this transaction direction
  const relevantAccounts = accounts.filter((a) => {
    if (transaction.amount_usd > 0) {
      // Debit / expense
      return ["Expense", "Cost of Goods Sold", "Bank", "Credit Card"].includes(a.account_type);
    } else {
      // Credit / income or refund
      return ["Income", "Other Current Asset", "Bank"].includes(a.account_type);
    }
  });

  const accountList = relevantAccounts
    .map((a) => `  {"id": "${a.id}", "name": "${a.name}", "type": "${a.account_type}", "full_name": "${a.full_name}"}`)
    .join(",\n");

  const ragSection =
    ragMatches.length > 0
      ? `\n## Similar past transactions (memory)\n` +
        ragMatches
          .map((m) => `  - "${m.embedded_text}" → ${m.account_name} (similarity: ${m.similarity.toFixed(2)})`)
          .join("\n")
      : "";

  const ruleSection =
    vendorRuleHints.length > 0
      ? `\n## Partial vendor rule matches\n` +
        vendorRuleHints.map((r) => `  - Pattern "${r.vendor_pattern}" → ${r.account_name}`).join("\n")
      : "";

  return `## Transaction to categorize
Vendor: ${transaction.vendor_name ?? "(unknown)"}
Description: ${transaction.description}
Amount: $${Math.abs(transaction.amount_usd).toFixed(2)} ${transaction.amount_usd < 0 ? "(credit)" : "(debit)"}
Date: ${transaction.date}
Type: ${transaction.transaction_type}
${ragSection}${ruleSection}

## Valid QBO accounts (use one of these IDs)
[
${accountList}
]

## Required JSON response format
{
  "account_id": "<exact id from the list above>",
  "confidence": <0.00 to 1.00>,
  "reasoning": "<one sentence explaining the choice>",
  "alternatives": [
    {"account_id": "<id>", "name": "<account name>", "confidence": <0.00 to 1.00>},
    {"account_id": "<id>", "name": "<account name>", "confidence": <0.00 to 1.00>}
  ]
}`;
}

function currentMonth(): string {
  return new Date().toISOString().slice(0, 7); // 'YYYY-MM'
}
