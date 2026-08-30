// ============================================================
// seed/01_chart_of_accounts.ts
//
// Seeds the standard QBO chart of accounts for an e-commerce
// seller into the demo organization.
//
// Run: npx ts-node butterbase/seed/01_chart_of_accounts.ts
//
// Requires env vars:
//   BUTTERBASE_URL      — your Butterbase project URL
//   BUTTERBASE_SERVICE_KEY — service role key (bypasses RLS)
//   DEMO_ORG_ID         — UUID of the demo organization
// ============================================================

import { getServiceClient } from "../functions/_shared/db";

const db = getServiceClient();

const ORG_ID = process.env.DEMO_ORG_ID!;

// Each entry maps to one chart_of_accounts row.
// qbo_account_id uses realistic QBO-style IDs (numeric strings).
// These are the accounts most relevant to a Shopify e-commerce seller.
const ACCOUNTS: Array<{
  qbo_account_id: string;
  name: string;
  account_type: string;
  account_subtype: string | null;
  full_name: string;
}> = [
  // ── Income ──────────────────────────────────────────────────
  {
    qbo_account_id: "1",
    name: "Shopify Sales",
    account_type: "Income",
    account_subtype: "SalesOfProductIncome",
    full_name: "Shopify Sales",
  },
  {
    qbo_account_id: "2",
    name: "Amazon Sales",
    account_type: "Income",
    account_subtype: "SalesOfProductIncome",
    full_name: "Amazon Sales",
  },
  {
    qbo_account_id: "3",
    name: "Etsy Sales",
    account_type: "Income",
    account_subtype: "SalesOfProductIncome",
    full_name: "Etsy Sales",
  },
  {
    qbo_account_id: "4",
    name: "Wholesale Revenue",
    account_type: "Income",
    account_subtype: "SalesOfProductIncome",
    full_name: "Wholesale Revenue",
  },
  {
    qbo_account_id: "5",
    name: "Shipping Income",
    account_type: "Income",
    account_subtype: "ServiceFeeIncome",
    full_name: "Shipping Income",
  },
  {
    qbo_account_id: "6",
    name: "Returns & Allowances",
    account_type: "Income",
    account_subtype: "DiscountsRefundsGiven",
    full_name: "Returns & Allowances",
  },

  // ── Cost of Goods Sold ──────────────────────────────────────
  {
    qbo_account_id: "10",
    name: "Inventory / Product Cost",
    account_type: "Cost of Goods Sold",
    account_subtype: "SuppliesMaterialsCogs",
    full_name: "Cost of Goods Sold:Inventory / Product Cost",
  },
  {
    qbo_account_id: "11",
    name: "Shipping Cost of Goods",
    account_type: "Cost of Goods Sold",
    account_subtype: "ShippingFreightDelivery",
    full_name: "Cost of Goods Sold:Shipping Cost of Goods",
  },
  {
    qbo_account_id: "12",
    name: "Packaging Supplies",
    account_type: "Cost of Goods Sold",
    account_subtype: "SuppliesMaterialsCogs",
    full_name: "Cost of Goods Sold:Packaging Supplies",
  },

  // ── Expenses ────────────────────────────────────────────────
  {
    qbo_account_id: "20",
    name: "Advertising & Marketing",
    account_type: "Expense",
    account_subtype: "AdvertisingPromotional",
    full_name: "Advertising & Marketing",
  },
  {
    qbo_account_id: "21",
    name: "Shopify Fees",
    account_type: "Expense",
    account_subtype: "OtherMiscellaneousServiceCost",
    full_name: "Platform Fees:Shopify Fees",
  },
  {
    qbo_account_id: "22",
    name: "Amazon Fees",
    account_type: "Expense",
    account_subtype: "OtherMiscellaneousServiceCost",
    full_name: "Platform Fees:Amazon Fees",
  },
  {
    qbo_account_id: "23",
    name: "Etsy Fees",
    account_type: "Expense",
    account_subtype: "OtherMiscellaneousServiceCost",
    full_name: "Platform Fees:Etsy Fees",
  },
  {
    qbo_account_id: "24",
    name: "Payment Processing Fees",
    account_type: "Expense",
    account_subtype: "OtherMiscellaneousServiceCost",
    full_name: "Platform Fees:Payment Processing Fees",
  },
  {
    qbo_account_id: "25",
    name: "Software & Subscriptions",
    account_type: "Expense",
    account_subtype: "SoftwareAndTechnology",
    full_name: "Software & Subscriptions",
  },
  {
    qbo_account_id: "26",
    name: "Office Supplies",
    account_type: "Expense",
    account_subtype: "OfficeGeneralAdministrativeExpenses",
    full_name: "Office Supplies",
  },
  {
    qbo_account_id: "27",
    name: "Shipping Supplies",
    account_type: "Expense",
    account_subtype: "SuppliesMaterials",
    full_name: "Shipping Supplies",
  },
  {
    qbo_account_id: "28",
    name: "Professional Services",
    account_type: "Expense",
    account_subtype: "ProfessionalFees",
    full_name: "Professional Services",
  },
  {
    qbo_account_id: "29",
    name: "Bank & Merchant Fees",
    account_type: "Expense",
    account_subtype: "BankCharges",
    full_name: "Bank & Merchant Fees",
  },
  {
    qbo_account_id: "30",
    name: "Utilities",
    account_type: "Expense",
    account_subtype: "Utilities",
    full_name: "Utilities",
  },
  {
    qbo_account_id: "31",
    name: "Travel & Entertainment",
    account_type: "Expense",
    account_subtype: "TravelMeals",
    full_name: "Travel & Entertainment",
  },
  {
    qbo_account_id: "32",
    name: "Payroll Expenses",
    account_type: "Expense",
    account_subtype: "PayrollExpenses",
    full_name: "Payroll Expenses",
  },
  {
    qbo_account_id: "33",
    name: "Insurance",
    account_type: "Expense",
    account_subtype: "Insurance",
    full_name: "Insurance",
  },
  {
    qbo_account_id: "34",
    name: "Taxes & Licenses",
    account_type: "Expense",
    account_subtype: "TaxesPaid",
    full_name: "Taxes & Licenses",
  },
  {
    qbo_account_id: "35",
    name: "Uncategorized Expense",
    account_type: "Expense",
    account_subtype: null,
    full_name: "Uncategorized Expense",
  },

  // ── Assets ──────────────────────────────────────────────────
  {
    qbo_account_id: "40",
    name: "Checking Account",
    account_type: "Bank",
    account_subtype: "Checking",
    full_name: "Checking Account",
  },
  {
    qbo_account_id: "41",
    name: "Inventory Asset",
    account_type: "Other Current Asset",
    account_subtype: "Inventory",
    full_name: "Inventory Asset",
  },
  {
    qbo_account_id: "42",
    name: "Accounts Receivable",
    account_type: "Accounts Receivable",
    account_subtype: "AccountsReceivable",
    full_name: "Accounts Receivable",
  },

  // ── Liabilities ─────────────────────────────────────────────
  {
    qbo_account_id: "50",
    name: "Accounts Payable",
    account_type: "Accounts Payable",
    account_subtype: "AccountsPayable",
    full_name: "Accounts Payable",
  },
  {
    qbo_account_id: "51",
    name: "Sales Tax Payable",
    account_type: "Other Current Liability",
    account_subtype: "SalesTaxPayable",
    full_name: "Sales Tax Payable",
  },
  {
    qbo_account_id: "52",
    name: "Credit Card",
    account_type: "Credit Card",
    account_subtype: "CreditCard",
    full_name: "Credit Card",
  },
];

async function seed() {
  if (!ORG_ID) throw new Error("DEMO_ORG_ID env var is required");

  console.log(`Seeding ${ACCOUNTS.length} chart of accounts entries for org ${ORG_ID}...`);

  const rows = ACCOUNTS.map((a) => ({
    organization_id: ORG_ID,
    qbo_account_id: a.qbo_account_id,
    name: a.name,
    account_type: a.account_type,
    account_subtype: a.account_subtype,
    full_name: a.full_name,
    is_active: true,
  }));

  const { error } = await db
    .from("chart_of_accounts")
    .upsert(rows, { onConflict: "organization_id,qbo_account_id" });

  if (error) {
    console.error("Seed failed:", error);
    process.exit(1);
  }

  console.log("Chart of accounts seeded successfully.");
}

seed();
