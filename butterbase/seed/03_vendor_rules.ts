// ============================================================
// seed/03_vendor_rules.ts
//
// Seeds initial vendor rules for the demo org.
// These cover the clear-cut vendors in the synthetic dataset,
// so the categorization pipeline demonstrates the fast path:
// vendor rule hit → no LLM call → instant categorization.
//
// Run: npx ts-node butterbase/seed/03_vendor_rules.ts
//
// Requires env vars:
//   BUTTERBASE_URL
//   BUTTERBASE_SERVICE_KEY
//   DEMO_ORG_ID
// ============================================================

import { getServiceClient } from "../functions/_shared/db";

const db = getServiceClient();

const ORG_ID = process.env.DEMO_ORG_ID!;

// Each rule maps a vendor_pattern to a qbo_account_id.
// match_type:
//   'exact'    — full string equality (case-insensitive at query time)
//   'prefix'   — vendor_name starts with this pattern
//   'contains' — vendor_name contains this pattern
const RULES: Array<{
  vendor_pattern: string;
  match_type: "exact" | "prefix" | "contains";
  qbo_account_id: string;
}> = [
  // Advertising
  { vendor_pattern: "GOOGLE ADS",       match_type: "exact",    qbo_account_id: "20" },
  { vendor_pattern: "META PLATFORMS",   match_type: "exact",    qbo_account_id: "20" },

  // Shopify fees and payouts
  { vendor_pattern: "SHOPIFY",          match_type: "prefix",   qbo_account_id: "21" },
  { vendor_pattern: "SHOPIFY PAYOUT",   match_type: "exact",    qbo_account_id: "1"  },

  // Software
  { vendor_pattern: "ZOOM",             match_type: "prefix",   qbo_account_id: "25" },
  { vendor_pattern: "NOTION",           match_type: "prefix",   qbo_account_id: "25" },
  { vendor_pattern: "SLACK",            match_type: "prefix",   qbo_account_id: "25" },
  { vendor_pattern: "AMAZON WEB SERVICES", match_type: "exact", qbo_account_id: "25" },
  { vendor_pattern: "DROPBOX",          match_type: "prefix",   qbo_account_id: "25" },

  // Shipping
  { vendor_pattern: "USPS",             match_type: "exact",    qbo_account_id: "11" },
  { vendor_pattern: "FEDEX",            match_type: "prefix",   qbo_account_id: "11" },
  { vendor_pattern: "UPS",              match_type: "prefix",   qbo_account_id: "11" },
  { vendor_pattern: "SHIPBOB",          match_type: "prefix",   qbo_account_id: "11" },

  // Office supplies
  { vendor_pattern: "COSTCO WHOLESALE", match_type: "prefix",   qbo_account_id: "26" },
  { vendor_pattern: "STAPLES",          match_type: "prefix",   qbo_account_id: "26" },
  { vendor_pattern: "OFFICE DEPOT",     match_type: "prefix",   qbo_account_id: "26" },

  // Payment processing
  { vendor_pattern: "STRIPE",           match_type: "prefix",   qbo_account_id: "24" },
  { vendor_pattern: "PAYPAL",           match_type: "prefix",   qbo_account_id: "24" },

  // Inventory / COGS
  { vendor_pattern: "ALIBABA",          match_type: "prefix",   qbo_account_id: "10" },
  { vendor_pattern: "ALIEXPRESS",       match_type: "prefix",   qbo_account_id: "10" },

  // Refunds
  { vendor_pattern: "SHOPIFY REFUND",   match_type: "prefix",   qbo_account_id: "6"  },
];

async function seed() {
  if (!ORG_ID) throw new Error("DEMO_ORG_ID env var is required");

  // Resolve qbo_account_ids to UUIDs
  const { data: accounts, error: acctErr } = await db
    .from("chart_of_accounts")
    .select("id, qbo_account_id")
    .eq("organization_id", ORG_ID);

  if (acctErr || !accounts) {
    console.error("Failed to fetch chart of accounts:", acctErr);
    process.exit(1);
  }

  const accountMap = new Map(accounts.map((a) => [a.qbo_account_id, a.id]));

  const rows = RULES.map((rule) => {
    const accountId = accountMap.get(rule.qbo_account_id);
    if (!accountId) throw new Error(`No account for qbo_account_id ${rule.qbo_account_id}`);
    return {
      organization_id: ORG_ID,
      vendor_pattern: rule.vendor_pattern,
      match_type: rule.match_type,
      account_id: accountId,
      confidence: 1.00,
      created_by: null,  // system-seeded
    };
  });

  console.log(`Seeding ${rows.length} vendor rules...`);

  const { error } = await db
    .from("vendor_rules")
    .upsert(rows, { onConflict: "organization_id,vendor_pattern" });

  if (error) {
    console.error("Vendor rule seed failed:", error);
    process.exit(1);
  }

  console.log("Vendor rules seeded successfully.");
  console.log("These rules cover the 'clear' transactions in the synthetic dataset.");
  console.log("Any transaction matching these patterns will be categorized instantly, with no LLM call.");
}

seed().catch(console.error);
