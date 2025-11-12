# ADR-0013: Query API contract (doGet)

*Status:* Accepted  
*Date:* 2025-11-12  
*Owner:* Apps Script Web App (`doGet(e)`)

---

## Context

Clients (Telegram/Make and any HTTP consumers) need a **stable JSON** to render lists like: DATE — TITLE — TIMES — {payment, categories, venue}


Internally we already keep:
- `events` — normalized table with DST-correct `start_dt/end_dt` used for filtering/sorting.
- `raw_events` — staging table that preserves the **comma string** of showtimes in `Time`.

We must expose user-friendly fields while keeping filtering/sorting correct and inexpensive.

---

## Decision

Expose a **read-only HTTP GET** API (Apps Script Web App) that:

1) Uses **`events`** for logic (window overlap, filters, sorting).  
2) **Joins** the display showtimes `times` from **`raw_events`** by key `(Source, Link, Date)`.  
3) Returns **display fields** plus **technical fields** in a fixed shape.

### Request (query params)

- `date` `YYYY-MM-DD` (required unless `start` & `end` provided)  
- `period` `day|week|weekend|range` (default `day`)  
- `days` integer (used only with `period=range` when `start/end` absent)  
- `start`, `end` `YYYY-MM-DD` (explicit window; overrides `period/days` when both provided)  
- `payment` `any|free|paid|unknown` (default `any`)  
- `category` comma list; request aliases are mapped via `taxonomy_alias` → **canonical**; event passes if **any** requested canonical appears in its pipe-joined `categories`  
- `source` comma list of hostnames (e.g., `zoom.lublin.pl,lublin.eu`)  
- `limit` int (default `20`, max `100`), `offset` int (default `0`)  
- `tz` optional IANA (default Script Property `TZ="Europe/Warsaw"`)

### Response (JSON)

```json
{
  "ok": true,
  "start": "YYYY-MM-DD",
  "end": "YYYY-MM-DD",
  "total": 42,
  "limit": 20,
  "offset": 0,
  "next_offset": 20,
  "results": [
    {
      "date": "YYYY-MM-DD",
      "title": "…",
      "times": "09:30, 11:30",
      "payment": "free|paid|unknown",
      "categories": "kids|music",
      "venue": "…",
      "source": "zoom.lublin.pl",
      "url": "https://…",

      "event_id": "…",
      "start_dt": "YYYY-MM-DDTHH:MM:SS+01:00",
      "end_dt":   "YYYY-MM-DDTHH:MM:SS+01:00"
    }
  ]
}
```

- **Display fields**: date, title, times, payment, categories, venue, source, url.
- **Technical fields**: event_id, start_dt, end_dt (useful for clients; not required for UI).

### Window & overlap
- day → [date, date]
- week → [date, date+6]
- weekend → Saturday/Sunday containing date
- range or explicit start/end → use those
- **Include** an event if DATE(end_dt) >= start and DATE(start_dt) <= end (inclusive).

### Sorting (API order)
1) Date ascending (from start_dt)
2) Timed first within the same date (time part of start_dt ≠ 00:00:00)
3) Earliest time ascending (HH:MM) for timed items
4) Title A→Z (Polish locale, case-insensitive)

This order matches the current implementation and aligns with ADR-0011 intent while making date the primary key for API lists.

### Pagination
- total counts matches before slicing.
- next_offset = (offset + limit < total) ? offset + limit : null.

### Errors & headers
- **400** for invalid input; **500** for exceptions — both return { ok:false, error:"…" }.
- Always set Content-Type: application/json; charset=utf-8 and Access-Control-Allow-Origin: *.
- On exception, if ALERT_EMAIL Script Property is set, send an alert email.

## Rationale
- Keep user output simple (date, times) without pushing time math to clients.
- Preserve correctness with ISO timestamps + proper timezone offsets for filtering/sorting.
- Zero extra network calls; single batch reads from Sheets; join times in-memory.

## Consequences
- Bots can render **DATE — TITLE — TIMES** immediately.
- Payment may be unknown until weekly enrichment jobs (E-Z1/E-O1) run; contract remains stable.
- Clients can rely on event_id for pagination state or dedupe.

## Alternatives considered
- **Only timestamps, no** times: pushes formatting to clients; rejected for UX simplicity.
-**Return** times **array instead of** string: heavier payload and client changes; may be added later as an **additive** field.
- **Make venue mandatory at list level**: not feasible for Official without enrichment.

## Security & performance
- CORS is open for ease of integration; no PII returned.
- Rate-limiting/auth not included; can be added later if needed.
- One pass load of events, one pass join from raw_events; no per-row calls.

## Compatibility / versioning
- **Additive** changes (new optional fields) are allowed.
- **Breaking** changes (field removal/rename or shape changes) require a new major tag/release and client migration guidance.

## References
- **Specs**: docs/specs/query-api.md
- **Data model**: ADR-0005 (raw→normalized)
- **Ordering principle**: ADR-0011 (Hub ordering policy)
- **Dedupe fallback**: ADR-0012 (without venue)
-  **Implementation**: apps_script/Lublin_events_DB_AppScript/api_doGet.js (v0.3.0-rc.3 @ 141940c):
    - ::contentReference[oaicite:0]{index=0}