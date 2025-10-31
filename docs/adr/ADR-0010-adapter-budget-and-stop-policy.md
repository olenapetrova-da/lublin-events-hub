# ADR-0010: Adapter budget & stop policy
*Status:* Accepted
*Date:* 2025-10-31

## Context
Cloudflare Workers have subrequest limits. We must avoid timeouts and still return usable partial results.

## Decision
- **Budget enforcement:** Each adapter enforces a shared subrequest budget (`subreq_budget_max`) across list and detail fetches.
- **Stop conditions:** Stop when (a) budget exhausted, (b) `pages` reached, or (c) no more items.
- **Partial OK:** On stop, return collected items and telemetry — `pages_scanned`, `budget_used`, `has_more` (bool), `stopped_reason` (`budget|pages|no_more|error`).
- **No crash on budget:** Budget exhaustion is **not** an error case.
- **Determinism:** Emit items in stable order (date/time asc) to make re-runs idempotent.

## Consequences
- Apps Script `refresh()` can tolerate partials and achieve eventual completeness with the daily 7-day window.
- Operators can see exactly why a run stopped and how far it got.

## References
- ADR-0006 (enrichment location & limits)
- ADR-0008 (enrichment fields)
- ADR-0009 (_EndDate & Source)
- `docs/specs/adapter-contract.md` (telemetry fields, #rules)
