# Accounting Agent — Categorization Pipeline

---

## Simple overview

```mermaid
flowchart LR
    A([🧾 Transaction\narrives]) --> B[⚡ Auto-categorize\nVendor rules · Memory · AI]
    B -- Confident --> C([📒 Written to\nQuickBooks])
    B -- Uncertain --> D[👤 Human review\nwith AI suggestion]
    D --> C
```

---

## Detailed pipeline

Every transaction runs through a 4-step pipeline. Each step is tried in order; the first one that produces a confident result wins. The further down the pipeline a transaction goes, the more it costs.

---

```mermaid
flowchart TD
    START([🧾 Transaction arrives\nQBO · Shopify · Manual])
    START --> RULE

    subgraph STEP1 ["Step 1 — Vendor Rule (free)"]
        RULE{Vendor name\nmatches a rule?}
    end

    RULE -- Yes --> CAT_RULE([✅ Categorized instantly\nno LLM call · $0.00])

    RULE -- No --> STEP2

    subgraph STEP2 ["Step 2 — RAG Memory (free)"]
        RAG{Similar past\ntransaction found\nwith high confidence?}
    end

    RAG -- Yes --> CAT_RAG([✅ Categorized from memory\nno LLM call · $0.00])

    RAG -- No --> STEP3

    subgraph STEP3 ["Step 3 — LLM (small cost)"]
        LLM[Claude Haiku\ncategorizes transaction]
        LLM --> GATE{HITL gate:\nlow confidence?\nhigh dollar amount?\nunknown vendor?}
    end

    GATE -- No --> CAT_LLM([✅ Categorized by AI\n~$0.001 per transaction])

    GATE -- Yes --> STEP4

    subgraph STEP4 ["Step 4 — Human Review (HITL)"]
        QUEUE[⚑ Flagged for review\njoins review queue]
        QUEUE --> HUMAN[Controller reviews\nin dashboard\nwith AI suggestion shown]
        HUMAN --> DECISION{Accept\nor override?}
    end

    DECISION --> CAT_HUMAN([✅ Categorized by human])

    CAT_RULE & CAT_RAG & CAT_LLM & CAT_HUMAN --> LEARN

    subgraph LEARN ["Memory update (all paths)"]
        LEARN_NODE[Transaction embedded\ninto RAG memory]
        LEARN_NODE --> RULE_CHECK{Was it a\nhuman decision?}
        RULE_CHECK -- Yes + add rule --> NEW_RULE[(New vendor rule saved\nauto-fires next time\nthis vendor appears)]
        RULE_CHECK -- No / skip --> QBO
        NEW_RULE --> QBO
    end

    QBO([📒 Written to QuickBooks Online])
```

---

## What the pipeline costs at scale

| Path | Trigger | LLM cost | Typical share |
|---|---|---|---|
| Vendor rule hit | Exact / prefix / pattern match | $0.00 | ~60% of transactions |
| RAG memory hit | Semantically similar past transaction | $0.00 | ~20% |
| LLM — auto-accepted | AI confident, below HITL threshold | ~$0.001 | ~15% |
| Human review | Low confidence · high amount · unknown vendor | Controller's time | ~5% |

Over time the vendor rule and RAG layers grow, so the LLM and HITL rates shrink — the system gets cheaper and faster the longer it runs.

---

## The three moments that tell the story

**Moment 1 — Instant rule hit**
A Klaviyo charge arrives. The vendor rule fires in milliseconds. No LLM call is made. Zero cost.

**Moment 2 — Ambiguous vendor flagged**
"Luminary Creative Group" has never been seen. RAG finds no confident match. The LLM categorizes it as Advertising (67% confidence). Because the amount is $1,250 and confidence is below the threshold, the HITL gate fires and it lands in the review queue — with the AI's reasoning and top similar past transactions shown to the controller.

**Moment 3 — Human resolves, rule created**
The controller accepts the suggestion and ticks "create vendor rule." The transaction is booked. Next time Luminary Creative Group appears, it hits Step 1 and never reaches the LLM again.
