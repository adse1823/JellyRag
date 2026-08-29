# Accounting Agent — Decision Log

New venture — production-stack thesis applied to accounting.

## Thesis

Agents that ship "real revenue" — i.e. touch money, act unattended, and get trusted with
consequential decisions — need a production stack most demos skip: memory, sandboxing, cost
controls, observability, retry logic, human-in-the-loop gates. That stack is boring and
invisible from outside, which is exactly why it's a moat: model capability commoditizes fast,
the operational layer around it doesn't.

## Domain: Accounting

Chosen over supply chain ops and insurance because, starting with zero domain network:

- **Integration access is public and self-serve.** QuickBooks Online and Xero both have
  documented public APIs — no enterprise sales team or IT gatekeeper needed to get in, unlike
  NetSuite/SAP (supply chain) or Guidewire/Duck Creek (insurance).
- **Buyers are cold-reachable.** Small bookkeeping/accounting firms can be found and emailed
  directly. Supply chain needs a design-partner relationship to get real data access; insurance
  sales cycles run 6–18 months and lean on industry relationships neither of us has.
- **The category is proven, not speculative.** Bench, Pilot, Puzzle, Digits, Truewind, Decimal
  already exist — real demand, not a hunch. The risk is crowding, not lack of a market.

## Niche: vertical bookkeeping, not horizontal

"AI bookkeeper for any small business" (Bench et al.) is crowded and hard to differentiate
against funded incumbents with a head start on their own memory/data flywheel.

**Chosen wedge: e-commerce sellers with multi-channel reconciliation** (Shopify + Amazon +
Etsy + wholesale). Reconciling payouts, fees, refunds, and COGS across channels is genuinely
messy and handled poorly by generic tools — the vertical's reconciliation rules become the
moat (same flywheel logic as memory in general: once encoded, a horizontal competitor can't
copy it overnight).

Other verticals considered and set aside for now (real gaps, but not the first move):
restaurants (POS/tip-pooling/food-cost), property management (trust accounting), construction
(WIP/percentage-of-completion), nonprofits (fund accounting).

## Product shape

**Core (year-round, recurring):** transaction categorization, multi-channel payout/fee
reconciliation, COGS reconciliation for e-commerce sellers. This is the base subscription and
the thing that builds the per-client memory (categorization rules, vendor patterns) over time.

**Expansion module (seasonal, bundled — not standalone):** audit-prep automation.

- Audit prep alone was rejected as a standalone business: real pain, but it's an annual event
  per client, which is a bad fit for a subscription. It only works bundled into something
  already selling year-round.
- What it does: given a PBC (Prepared By Client) list or a sampling request from an auditor
  ("invoice + PO + proof of payment for these 25 transactions"), automatically retrieves and
  assembles the packet from the client's systems instead of a human hand-gathering it.
- Existing players (Suralink, CaseWare, Thomson Reuters/CCH) cover the *portal/checklist*
  workflow but not *agentic auto-retrieval* — that gap is the actual opening.
- Because the core product already has the client's transaction/vendor data and system access
  by the time audit season hits, the audit-prep module gets better for free instead of starting
  cold — same memory flywheel feeding two features.
- Packaging: base plan billed monthly all year; "audit mode" unlocked as a higher tier or a
  seasonal add-on fee timed to fiscal year-end + audit window. Turns the once-a-year event into
  an expansion-revenue moment instead of a revenue floor problem.

## Buyer decision: company being audited, not the audit firm

Two buyer options were compared for the audit-prep module:

1. **The audited company** (controller/CFO) — chosen.
2. The audit firm (CPA firm performing the audit) — rejected for now.

Why the firm was rejected despite being the buyer where the production stack is most
literally required (GAAS/PCAOB documentation standards force real observability, professional
judgment rules force real HITL, independence/confidentiality rules force real multi-tenant
sandboxing — the stack stops being a differentiator and becomes the price of entry): the sales
motion is slow, gated by professional trust and procurement, and requires SOC 2 and compliance
literacy before anyone takes the call. Not viable as a first move with no existing network.

Why the audited company works better as buyer #1: no external blessing needed on the tool at
all — the auditor just receives whatever evidence packet the controller hands them, so the only
trust relationship to build is with the controller. Much lower barrier to a first sale. The
tradeoff: without a regulator forcing the stack, its rigor has to be sold on reputation risk
("this is your credibility in front of your own auditor") rather than compliance necessity —
softer, but real.

**Open fork not yet resolved:** whether the year-round core product is sold direct to an
in-house controller/CFO (works if the e-commerce company is big enough to have one — VC-backed,
bank covenant, etc.) or to an outsourced bookkeeping firm serving the client, with the firm's
staff running audit-prep on the client's behalf. These imply different onboarding flows and
pricing pages. Decide before building v1.

## Production stack, mapped to this specific product

| Component | Core (year-round) | Audit-prep module |
|---|---|---|
| **Memory** | Per-client categorization rules, vendor patterns ("this vendor is always office supplies for Client X, COGS for Client Y") | Per-client document locations, prior-year schedules — compounds on top of core's data |
| **Sandbox** | Scoped to QBO/Xero API read/write on specific ledger entries; never touches bank credentials or initiates payments | Mostly read/retrieve, not write/execute — lower blast radius than the core product or than AP/supply-chain domains generally |
| **Cost controls** | Per-client monthly budget (firms bill by client) | Lower stakes; standard budgeting |
| **Observability** | Full audit trail of why each transaction was categorized — accountants are professionally liable for the books | The trail *is* the deliverable: "what was gathered, from where" is what a controller hands to their auditor |
| **Retry logic** | Idempotency-aware retries against QBO/Xero — never double-post a transaction | Retries against flaky bank portals/legacy systems during multi-step document retrieval |
| **HITL gate** | Human review above a dollar threshold, anything unrecognized, before month-end close finalizes | Mandatory human review before any packet goes external to the auditor — non-negotiable regardless of buyer |

## Competitive landscape (for reference)

- **Horizontal AI bookkeeping (crowded):** Bench, Pilot, Puzzle, Digits, Truewind, Decimal
- **AP automation, enterprise-skewed:** Bill.com, Ramp, Airbase, Tipalti
- **Sales tax (effectively solved):** Avalara, TaxJar/Stripe Tax
- **Month-end close, upmarket:** FloQast, Trintech
- **Audit-prep portals (adjacent, not competing on retrieval):** Suralink, CaseWare, Thomson Reuters/CCH

## Open decisions before building v1

1. In-house controller vs. outsourced-firm GTM model (see fork above).
2. First integration scope: QBO or Xero first, and which of Shopify/Amazon/Etsy for the
   multi-channel piece.
3. Pricing structure for the seasonal audit-mode upsell (tier bump vs. one-time fee).

## Build platform: Butterbase

Building on Butterbase (butterbase.ai) — an AI-optimized Backend-as-a-Service: Postgres, auth,
row-level security, typed CRUD APIs (REST/GraphQL), S3-compatible storage, serverless TS/JS
functions, native RAG, and an LLM gateway. Designed to be driven primarily by an AI coding
assistant via its MCP server, or via CLI/REST API — the web dashboard exists for account/app
management and monitoring but schema definition, RLS policies, and data operations are
documented as MCP/CLI/API operations, not dashboard-only actions.