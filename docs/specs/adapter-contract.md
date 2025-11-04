# Adapter Contract (list + optional enrichment)

## Request params (query)
- `date` (YYYY-MM-DD), `period` (`day|week|range|weekend`), `days` (int)
- `pages` (int, default 3) — max list pages to scan
- `limit` (int, optional) — max items to emit
- `group_times` (0|1) — unify showtimes (hub-compatible)
- `enrich` (0|1) — enable detail fetch for missing fields
- `enrich_max` (int, default 15) — cap detail fetches
- **Budget** (internal): `subreq_budget_max` — hard cap on total subrequests (list + detail)

## Response shape (JSON)
```json
{
  "source": "lublin.eu | zoom.lublin.pl",
  "url": "<list-url>",
  "start": "YYYY-MM-DD",
  "end": "YYYY-MM-DD",
  "pages_scanned": 2,
  "budget_used": 37,
  "has_more": false,
  "stopped_reason": "none | budget | pages | no_more | error",
  "count": 123,
  "events": [
    {
      "Title": "...",
      "Date": "YYYY-MM-DD",
      "Time": "HH:MM or HH:MM–HH:MM",
      "Venue": "...",
      "Category": "raw label(s)",
      "Link": "https://...",
      "Payment for Entry": "Yes|No|"" (per ADR-0007)",
      "Source": "lublin.eu | zoom.lublin.pl",
      "_EndDate": "YYYY-MM-DD (if multi-day; else can be omitted by adapter)"
    }
  ],
  "error": ""  // non-empty only for fatal errors
}

## Rules

- **Budget-first.** Never exceed `subreq_budget_max`. If the next fetch would exceed it, stop and return partials with:
  - `has_more: true`
  - `stopped_reason: "budget"`
  - `pages_scanned`, `budget_used`

- **Enrichment scope.** When `enrich=1`, enrich only fields allowed by ADR-0008 (Payment, Time/Time range, Venue). **No taxonomy/canonical mapping** in adapters.

- **_EndDate handling.** Pass `_EndDate` through when the source provides it. If missing, Apps Script sets `_EndDate = Date` during `refresh()` (ADR-0009).

- **Fatal errors.** If page 1 fails or HTML is fundamentally broken, stop with:
  - `stopped_reason: "error"`
  - non-empty `error` message
  Otherwise continue and return partial results.

- **Deterministic order.** Emit items in stable order (date/time asc) so re-runs are idempotent and downstream dedupe is reliable.

## References
- docs/specs/sources/zoom-lublin.md
