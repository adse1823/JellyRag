// LLM call wrapper — routes through Butterbase AI gateway.
// Handles: model selection based on budget state, OpenAI-compatible
// chat call, cost recording, and returning a typed categorization response.
//
// Requires env vars:
//   BUTTERBASE_API_KEY  — personal key with ai:gateway scope
//   BUTTERBASE_APP_ID   — app ID (e.g. app_4sbi6bot2fkq)
//   BUTTERBASE_API_URL  — optional, defaults to https://api.butterbase.ai

import OpenAI from "openai";
import { createHash } from "crypto";
import {
  DB,
  getMonthlyBudget,
  upsertMonthlyBudget,
  insertCostEvent,
  incrementBudgetSpend,
} from "./db";

const BB_API_URL = process.env.BUTTERBASE_API_URL ?? "https://api.butterbase.ai";
const BB_APP_ID  = process.env.BUTTERBASE_APP_ID!;

const openai = new OpenAI({
  apiKey:  process.env.BUTTERBASE_API_KEY,
  baseURL: `${BB_API_URL}/v1/${BB_APP_ID}`,
});

const SYSTEM_PROMPT =
  "You are a bookkeeping assistant for an e-commerce company using QuickBooks Online. " +
  "Your job is to assign the correct QBO account category to a financial transaction. " +
  "Respond with valid JSON only. No prose outside the JSON object.";

// Token prices per million tokens (Butterbase passes through at provider rates)
const TOKEN_PRICES: Record<string, { input: number; output: number }> = {
  "anthropic/claude-sonnet-4.6": { input: 3.0 / 1e6,  output: 15.0 / 1e6 },
  "anthropic/claude-haiku-4.5":  { input: 0.25 / 1e6, output: 1.25 / 1e6 },
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
  const model = pctUsed >= 0.8
    ? "anthropic/claude-haiku-4.5"
    : "anthropic/claude-sonnet-4.6";
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

  const response = await openai.chat.completions.create({
    model,
    max_tokens: 512,
    messages: [
      { role: "system", content: SYSTEM_PROMPT },
      { role: "user",   content: prompt },
    ],
  });

  const raw = response.choices[0]?.message?.content ?? "";
  const parsed = parseCategorizationResponse(raw);

  const inputTokens  = response.usage?.prompt_tokens ?? 0;
  const outputTokens = response.usage?.completion_tokens ?? 0;
  const prices = TOKEN_PRICES[model] ?? TOKEN_PRICES["anthropic/claude-sonnet-4.6"];
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
    reasoning:  typeof parsed.reasoning  === "string" ? parsed.reasoning  : "",
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

  const relevantAccounts = accounts.filter((a) => {
    if (transaction.amount_usd > 0) {
      return ["Expense", "Cost of Goods Sold", "Bank", "Credit Card"].includes(a.account_type);
    } else {
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
  return new Date().toISOString().slice(0, 7);
}
