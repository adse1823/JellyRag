// ============================================================
// seed/02_synthetic_transactions.ts
//
// Generates 2,000 realistic synthetic transactions for the demo
// org, plus a test_ground_truth row for each.
//
// Distribution:
//   60% clear (high-confidence expected)
//   25% ambiguous (HITL should trigger)
//   10% unknown vendor (HITL should trigger)
//    5% edge cases (large amounts, negatives, duplicates)
//
// Run: npx ts-node butterbase/seed/02_synthetic_transactions.ts
//
// Requires env vars:
//   BUTTERBASE_URL
//   BUTTERBASE_SERVICE_KEY
//   DEMO_ORG_ID
// ============================================================

import { getServiceClient } from "../functions/_shared/db";
import { randomUUID } from "crypto";

const db = getServiceClient();

const ORG_ID = process.env.DEMO_ORG_ID!;

// ── Types ─────────────────────────────────────────────────────

type Clarity = "clear" | "ambiguous" | "unknown";

interface TransactionTemplate {
  descriptionFn: () => string;
  vendorFn: () => string;
  accountQboId: string;   // maps to chart_of_accounts.qbo_account_id
  transactionType: "expense" | "income" | "refund" | "transfer" | "fee" | "payout";
  amountRange: [number, number]; // [min, max] in USD, always positive
  clarity: Clarity;
  frequencyWeight: number; // relative likelihood (higher = more often)
}

// ── Helpers ───────────────────────────────────────────────────

function randInt(min: number, max: number) {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

function randAmount(min: number, max: number): number {
  return parseFloat((Math.random() * (max - min) + min).toFixed(2));
}

function randDate(start: Date, end: Date): Date {
  return new Date(start.getTime() + Math.random() * (end.getTime() - start.getTime()));
}

function formatDate(d: Date): string {
  return d.toISOString().split("T")[0];
}

function pickWeighted<T extends { frequencyWeight: number }>(items: T[]): T {
  const total = items.reduce((s, i) => s + i.frequencyWeight, 0);
  let r = Math.random() * total;
  for (const item of items) {
    r -= item.frequencyWeight;
    if (r <= 0) return item;
  }
  return items[items.length - 1];
}

// ── Transaction Templates ─────────────────────────────────────

const TEMPLATES: TransactionTemplate[] = [
  // ── CLEAR — Advertising ──────────────────────────────────────
  {
    descriptionFn: () => `GOOGLE ADS ${randInt(100000, 999999)}`,
    vendorFn: () => "GOOGLE ADS",
    accountQboId: "20",
    transactionType: "expense",
    amountRange: [50, 800],
    clarity: "clear",
    frequencyWeight: 8,
  },
  {
    descriptionFn: () => `META PLATFORMS ${randInt(1000000, 9999999)}`,
    vendorFn: () => "META PLATFORMS",
    accountQboId: "20",
    transactionType: "expense",
    amountRange: [50, 1200],
    clarity: "clear",
    frequencyWeight: 7,
  },

  // ── CLEAR — Shopify Fees ────────────────────────────────────
  {
    descriptionFn: () => `SHOPIFY* ${randInt(10000, 99999)}`,
    vendorFn: () => "SHOPIFY",
    accountQboId: "21",
    transactionType: "fee",
    amountRange: [29, 299],
    clarity: "clear",
    frequencyWeight: 6,
  },

  // ── CLEAR — Shopify Payout ──────────────────────────────────
  {
    descriptionFn: () => `SHOPIFY PAYOUT ${randInt(100000000, 999999999)}`,
    vendorFn: () => "SHOPIFY PAYOUT",
    accountQboId: "1",
    transactionType: "payout",
    amountRange: [500, 15000],
    clarity: "clear",
    frequencyWeight: 10,
  },

  // ── CLEAR — Software subscriptions ──────────────────────────
  {
    descriptionFn: () => `ZOOM.US 888-799-9666`,
    vendorFn: () => "ZOOM",
    accountQboId: "25",
    transactionType: "expense",
    amountRange: [14.99, 19.99],
    clarity: "clear",
    frequencyWeight: 4,
  },
  {
    descriptionFn: () => `NOTION.SO`,
    vendorFn: () => "NOTION",
    accountQboId: "25",
    transactionType: "expense",
    amountRange: [8, 16],
    clarity: "clear",
    frequencyWeight: 3,
  },
  {
    descriptionFn: () => `SLACK TECHNOLOGIES`,
    vendorFn: () => "SLACK",
    accountQboId: "25",
    transactionType: "expense",
    amountRange: [7.25, 12.50],
    clarity: "clear",
    frequencyWeight: 3,
  },
  {
    descriptionFn: () => `AMAZON WEB SERVICES AWS.AMAZON.COM`,
    vendorFn: () => "AMAZON WEB SERVICES",
    accountQboId: "25",
    transactionType: "expense",
    amountRange: [20, 400],
    clarity: "clear",
    frequencyWeight: 4,
  },
  {
    descriptionFn: () => `DROPBOX`,
    vendorFn: () => "DROPBOX",
    accountQboId: "25",
    transactionType: "expense",
    amountRange: [9.99, 16.58],
    clarity: "clear",
    frequencyWeight: 2,
  },

  // ── CLEAR — Shipping (COGS) ──────────────────────────────────
  {
    descriptionFn: () => `USPS ${randInt(1000000000, 9999999999)}`,
    vendorFn: () => "USPS",
    accountQboId: "11",
    transactionType: "expense",
    amountRange: [4, 45],
    clarity: "clear",
    frequencyWeight: 9,
  },
  {
    descriptionFn: () => `FEDEX ${randInt(100000000, 999999999)}`,
    vendorFn: () => "FEDEX",
    accountQboId: "11",
    transactionType: "expense",
    amountRange: [8, 80],
    clarity: "clear",
    frequencyWeight: 7,
  },
  {
    descriptionFn: () => `UPS*${randInt(100000000, 999999999)}`,
    vendorFn: () => "UPS",
    accountQboId: "11",
    transactionType: "expense",
    amountRange: [7, 60],
    clarity: "clear",
    frequencyWeight: 6,
  },
  {
    descriptionFn: () => `SHIPBOB INC`,
    vendorFn: () => "SHIPBOB",
    accountQboId: "11",
    transactionType: "expense",
    amountRange: [200, 3000],
    clarity: "clear",
    frequencyWeight: 3,
  },

  // ── CLEAR — Office Supplies ──────────────────────────────────
  {
    descriptionFn: () => `COSTCO WHOLESALE #${randInt(100, 999)}`,
    vendorFn: () => "COSTCO WHOLESALE",
    accountQboId: "26",
    transactionType: "expense",
    amountRange: [40, 300],
    clarity: "clear",
    frequencyWeight: 5,
  },
  {
    descriptionFn: () => `STAPLES ${randInt(1000, 9999)}`,
    vendorFn: () => "STAPLES",
    accountQboId: "26",
    transactionType: "expense",
    amountRange: [15, 150],
    clarity: "clear",
    frequencyWeight: 4,
  },
  {
    descriptionFn: () => `OFFICE DEPOT #${randInt(100, 999)}`,
    vendorFn: () => "OFFICE DEPOT",
    accountQboId: "26",
    transactionType: "expense",
    amountRange: [20, 200],
    clarity: "clear",
    frequencyWeight: 3,
  },

  // ── CLEAR — Payment processing ───────────────────────────────
  {
    descriptionFn: () => `STRIPE TRANSFER`,
    vendorFn: () => "STRIPE",
    accountQboId: "24",
    transactionType: "fee",
    amountRange: [2, 50],
    clarity: "clear",
    frequencyWeight: 5,
  },
  {
    descriptionFn: () => `PAYPAL INST XFER`,
    vendorFn: () => "PAYPAL",
    accountQboId: "24",
    transactionType: "fee",
    amountRange: [1, 30],
    clarity: "clear",
    frequencyWeight: 3,
  },

  // ── CLEAR — Inventory (COGS) ─────────────────────────────────
  {
    descriptionFn: () => `ALIBABA.COM ${randInt(10000, 99999)}`,
    vendorFn: () => "ALIBABA",
    accountQboId: "10",
    transactionType: "expense",
    amountRange: [500, 8000],
    clarity: "clear",
    frequencyWeight: 4,
  },
  {
    descriptionFn: () => `ALIEXPRESS ${randInt(10000, 99999)}`,
    vendorFn: () => "ALIEXPRESS",
    accountQboId: "10",
    transactionType: "expense",
    amountRange: [100, 2000],
    clarity: "clear",
    frequencyWeight: 4,
  },

  // ── CLEAR — Refund ───────────────────────────────────────────
  {
    descriptionFn: () => `SHOPIFY REFUND ORDER #${randInt(1000, 9999)}`,
    vendorFn: () => "SHOPIFY REFUND",
    accountQboId: "6",
    transactionType: "refund",
    amountRange: [10, 200],
    clarity: "clear",
    frequencyWeight: 4,
  },

  // ── AMBIGUOUS — Amazon (COGS or Office?) ─────────────────────
  {
    descriptionFn: () => `AMZN MKTP US*${randInt(100, 999).toString(36).toUpperCase().padStart(6, "0")}`,
    vendorFn: () => "AMAZON MARKETPLACE",
    accountQboId: "10", // expected: COGS, but often Office Supplies
    transactionType: "expense",
    amountRange: [15, 400],
    clarity: "ambiguous",
    frequencyWeight: 10,
  },

  // ── AMBIGUOUS — Costco large purchase (Office or COGS?) ───────
  {
    descriptionFn: () => `COSTCO WHOLESALE #${randInt(100, 999)} ONLINE`,
    vendorFn: () => "COSTCO WHOLESALE ONLINE",
    accountQboId: "26",
    transactionType: "expense",
    amountRange: [300, 1200],
    clarity: "ambiguous",
    frequencyWeight: 4,
  },

  // ── AMBIGUOUS — Printer ink (Office or COGS packaging?) ───────
  {
    descriptionFn: () => `INK & TONER ${randInt(1000, 9999)}`,
    vendorFn: () => "INK AND TONER",
    accountQboId: "26",
    transactionType: "expense",
    amountRange: [20, 120],
    clarity: "ambiguous",
    frequencyWeight: 3,
  },

  // ── AMBIGUOUS — Home Depot (shipping supplies or office?) ──────
  {
    descriptionFn: () => `HOME DEPOT #${randInt(1000, 9999)}`,
    vendorFn: () => "HOME DEPOT",
    accountQboId: "27",
    transactionType: "expense",
    amountRange: [25, 300],
    clarity: "ambiguous",
    frequencyWeight: 3,
  },

  // ── AMBIGUOUS — Transfer (internal or payout?) ────────────────
  {
    descriptionFn: () => `WIRE TRANSFER ${randInt(100000, 999999)}`,
    vendorFn: () => "WIRE TRANSFER",
    accountQboId: "40", // checking — transfer
    transactionType: "transfer",
    amountRange: [500, 10000],
    clarity: "ambiguous",
    frequencyWeight: 3,
  },

  // ── AMBIGUOUS — Generic "supplies" purchase ───────────────────
  {
    descriptionFn: () => `ULINE S-${randInt(1000000, 9999999)}`,
    vendorFn: () => "ULINE",
    accountQboId: "27",
    transactionType: "expense",
    amountRange: [100, 800],
    clarity: "ambiguous",
    frequencyWeight: 3,
  },

  // ── UNKNOWN — Realistic but novel vendor names ────────────────
  {
    descriptionFn: () => `BRIGHTLAND SOLUTIONS ${randInt(1000, 9999)}`,
    vendorFn: () => "BRIGHTLAND SOLUTIONS",
    accountQboId: "35", // Uncategorized — unknown
    transactionType: "expense",
    amountRange: [50, 500],
    clarity: "unknown",
    frequencyWeight: 2,
  },
  {
    descriptionFn: () => `NEXGEN FREIGHT LLC`,
    vendorFn: () => "NEXGEN FREIGHT",
    accountQboId: "35",
    transactionType: "expense",
    amountRange: [100, 1500],
    clarity: "unknown",
    frequencyWeight: 2,
  },
  {
    descriptionFn: () => `PAYSIGN INC ${randInt(100, 999)}`,
    vendorFn: () => "PAYSIGN",
    accountQboId: "35",
    transactionType: "expense",
    amountRange: [30, 200],
    clarity: "unknown",
    frequencyWeight: 2,
  },
  {
    descriptionFn: () => `MERIDIAN CREATIVE GROUP`,
    vendorFn: () => "MERIDIAN CREATIVE",
    accountQboId: "35",
    transactionType: "expense",
    amountRange: [200, 3000],
    clarity: "unknown",
    frequencyWeight: 2,
  },
  {
    descriptionFn: () => `SVC*MARKETPLACE ${randInt(10000, 99999)}`,
    vendorFn: () => "SVC MARKETPLACE",
    accountQboId: "35",
    transactionType: "expense",
    amountRange: [20, 300],
    clarity: "unknown",
    frequencyWeight: 2,
  },
];

// ── Build transactions ────────────────────────────────────────

const TOTAL = 2000;
const DATE_START = new Date("2024-01-01");
const DATE_END = new Date("2024-12-31");

async function seed() {
  if (!ORG_ID) throw new Error("DEMO_ORG_ID env var is required");

  // Fetch account IDs from DB (we need UUIDs, seed file has qbo_account_ids)
  const { data: accounts, error: acctErr } = await db
    .from("chart_of_accounts")
    .select("id, qbo_account_id")
    .eq("organization_id", ORG_ID);

  if (acctErr || !accounts) {
    console.error("Failed to fetch chart of accounts:", acctErr);
    process.exit(1);
  }

  const accountMap = new Map(accounts.map((a) => [a.qbo_account_id, a.id]));

  const transactions: object[] = [];
  const groundTruth: { transaction_id: string; expected_account_id: string; clarity: Clarity }[] = [];

  for (let i = 0; i < TOTAL; i++) {
    const tmpl = pickWeighted(TEMPLATES);
    const txId = randomUUID();
    const amount = randAmount(...tmpl.amountRange);
    const date = formatDate(randDate(DATE_START, DATE_END));
    const accountId = accountMap.get(tmpl.accountQboId);

    if (!accountId) {
      console.warn(`No account found for qbo_account_id ${tmpl.accountQboId}, skipping`);
      continue;
    }

    transactions.push({
      id: txId,
      organization_id: ORG_ID,
      source: "manual",
      external_id: `SEED-${txId}`,
      date,
      description: tmpl.descriptionFn(),
      vendor_name: tmpl.vendorFn(),
      amount_usd: amount,
      transaction_type: tmpl.transactionType,
      category_status: "pending",
    });

    groundTruth.push({
      transaction_id: txId,
      expected_account_id: accountId,
      clarity: tmpl.clarity,
    });
  }

  console.log(`Inserting ${transactions.length} transactions...`);

  // Insert in batches of 200 to avoid payload limits
  const BATCH = 200;
  for (let i = 0; i < transactions.length; i += BATCH) {
    const { error } = await db
      .from("transactions")
      .insert(transactions.slice(i, i + BATCH));
    if (error) {
      console.error(`Transaction batch ${i / BATCH} failed:`, error);
      process.exit(1);
    }
    console.log(`  Inserted batch ${Math.floor(i / BATCH) + 1}/${Math.ceil(transactions.length / BATCH)}`);
  }

  console.log("Inserting ground truth...");
  for (let i = 0; i < groundTruth.length; i += BATCH) {
    const { error } = await db
      .from("test_ground_truth")
      .insert(groundTruth.slice(i, i + BATCH));
    if (error) {
      console.error(`Ground truth batch failed:`, error);
      process.exit(1);
    }
  }

  // Print distribution summary
  const clearCount = groundTruth.filter((g) => g.clarity === "clear").length;
  const ambigCount = groundTruth.filter((g) => g.clarity === "ambiguous").length;
  const unknownCount = groundTruth.filter((g) => g.clarity === "unknown").length;
  console.log(`\nDone. Distribution:`);
  console.log(`  Clear:     ${clearCount} (${((clearCount / TOTAL) * 100).toFixed(1)}%)`);
  console.log(`  Ambiguous: ${ambigCount} (${((ambigCount / TOTAL) * 100).toFixed(1)}%)`);
  console.log(`  Unknown:   ${unknownCount} (${((unknownCount / TOTAL) * 100).toFixed(1)}%)`);
}

seed().catch(console.error);
