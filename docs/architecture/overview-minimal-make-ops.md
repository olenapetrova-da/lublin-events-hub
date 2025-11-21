# Architecture — Minimal Make Ops (big picture)
*Updated:* 2025-11-21

This file is the **single place** for the big-picture diagram and flow. ADRs hold individual decisions; Strategy holds the step-by-step plan.

---

## Diagram (Mermaid)
```mermaid
flowchart TD
  subgraph Sources
    A1[lublin.eu — official adapter]
    A2[zoom.lublin.pl — zoom adapter]
  end

  A1 --> H[hub: merge/dedupe\nJSON when sheet=0]
  A2 --> H

  subgraph AppsScript
    R[refresh]
    M[materialize]
    Q[doGet — Query API]
  end

  H --> R --> S1[raw_events]
  S1 --> M --> S2[events]
  Q --> S2

  subgraph Make_Clients
    subgraph Phase_A_Webhook
      W1[Custom Webhook]
      W2[HTTP → API]
      W3[Webhook Response]
    end
    subgraph Phase_B_Telegram
      B1[Telegram buttons]
      B2[HTTP → API]
      B3[Send Message]
    end
  end

  Q <-->|JSON| W2
  Q <-->|JSON| B2


---

## End-to-end flow

### A) Refresh (daily, zero Make ops)
1. **refresh()** calls hub once (7‑day window, `sheet=0`, `group_times=1`).
2. Write **staging** → `raw_events` (9 columns incl. `_EndDate`).
3. **materialize()** reads `raw_events`, normalizes, writes **`events`**.

### B) Serve (per user request, 1 HTTP in Make)
1. The client (Webhook or Telegram buttons) provides date/period and optional category.  
2. Make performs one GET to the Query API with those params.
3. Apps Script filters `events` (date/period/payment/category), paginates, returns JSON.   
Telegram/Make calls: **parse → 1 HTTP → send**.
4. Apps Script Web App **Query API** reads normalized `events` for logic and attaches display `times` from `raw_events`. 
5. Make formats and **sends message**.

## User path
- **Phase A — Webhook**: parse minimal input → 1 HTTP → respond (no Telegram).
- **Phase B — Telegram bot**: button-only, one HTTP per request, no state/pagination.

All taxonomy and sorting stay in the API; Make only passes params and formats display lines.

---

## Responsibilities
- **Adapters (official, zoom)**: scrape, minimal normalization; zoom carries `_EndDate`.
- **hub**: merge sources, dedupe showtimes; JSON mode when `sheet=0`. When venue is missing on one side, apply fallback dedupe (date/time + title/slug similarity).
- **Apps Script**: refresh/materialize/query; category mapping via Sheets taxonomy.
- **Sheets**: data store (`raw_events` staging → `events` normalized).  
- **Make**: chat glue only (parse/buttons → HTTP → send).

---

### Adapter runtime (budget, enrichment, pagination)

- **Budget:** Each adapter enforces a single subrequest budget shared by list+detail fetches. Default `subreq_budget_max = 45` (example).
- **Pages:** Scan list pages sequentially up to `pages` (default 3). Stop when `pages_scanned == pages`, or when budget is exhausted, or no more items.
- **Enrichment:** If `enrich=1`, adapters may fetch detail pages up to `enrich_max`, but never exceeding the remaining budget.
- **Never crash on budget:** On budget exhaustion, **return partial results** with telemetry — `pages_scanned`, `budget_used`, `has_more=true`, `stopped_reason="budget"`.
- **Deterministic order:** Items are yielded in a stable order (date/time asc). Re-runs for the same window are idempotent.
- **Apps Script tolerance:** `refresh()` accepts partials; daily 7-day refresh achieves eventual completeness without Make ops.

---

## Data model (summary)
- **raw_events (9):** Title, Date, Time, Venue, Category, Link, Payment for Entry, Source, `_EndDate`.
- **events (9):** event_id, title, start_dt, end_dt, venue, payment, categories, source, url.

**Full rules:** see ADR-0005.  
**API contract:** see ADR-0013.

---

## Pointers
- High‑level decision: ADR‑0003.  
- Hub JSON mode: ADR‑0004.  
- Data model details: ADR‑0005.  
- Query API: ADR-0013.  
- Step-by-step plan: `docs/strategy/v4.md`.


---

## Implementer checklist
- [ ] Script Properties: hub URL, sheet ID, timezone.  
- [ ] Time trigger for `refresh()` (daily).  
- [ ] Web App deployed → note URL.  
- [ ] Make scenarios: Phase A (Webhook) and Phase B (Telegram buttons) built.
- [ ] Taxonomy tables maintained; review `taxonomy_unmapped`.
