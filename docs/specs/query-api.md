# Query API (doGet) — spec

**Purpose.** Serve user-facing JSON for bots/clients. Show **display fields** users need (`date`, `title`, `times`, `payment`, `categories`, `venue`, `url`, `source`) while using normalized timestamps for filtering/sorting.

**Owner:** Apps Script Web App (`doGet(e)`).

**Status:** Implemented in `api_doGet.js` (release `v0.3.0-rc.3`, commit `141940c`).

---

## Inputs (Sheets)

- **events** (9 cols) — normalized, produced by `materialize()`  
  `event_id | title | start_dt | end_dt | venue | payment | categories | source | url`  
  `start_dt/end_dt` are ISO-8601 strings with the **Europe/Warsaw** offset.

- **raw_events** (9 cols) — staging, produced by `refresh()`  
  `Title | Date | Time | Venue | Category | Link | Payment for Entry | Source | _EndDate`  
  `Time` is the **comma string** of showtimes for display (e.g., `"09:30, 11:30"`).

- **taxonomy_alias** — request-time alias mapping  
  `alias | canonical` (lowercase values).

> `events` is used for logic (filtering/sorting). `raw_events` is used only to attach `times` for display.

---

## Request (query params)

| Param     | Type / Allowed                     | Default | Notes |
|-----------|------------------------------------|---------|-------|
| `date`    | `YYYY-MM-DD`                       | —       | Required unless `start` **and** `end` are given. |
| `period`  | `day \| week \| weekend \| range`  | `day`   | When `range`, see `days`. Ignored if `start`+`end` provided. |
| `days`    | integer                             | —       | Used only with `period=range` if `start`/`end` missing. |
| `start`   | `YYYY-MM-DD`                       | —       | Explicit start date; use with `end`. |
| `end`     | `YYYY-MM-DD`                       | —       | Explicit end date; use with `start`. |
| `payment` | `any \| free \| paid \| unknown`   | `any`   | Filter by normalized payment from `events`. |
| `category`| comma list                          | —       | Request-time aliases are mapped via `taxonomy_alias` to canonicals. Match if **any** requested canonical appears in the event’s `categories` pipe list. |
| `source`  | comma list of hostnames            | —       | e.g., `zoom.lublin.pl,lublin.eu`. |
| `limit`   | integer                             | `20`    | `1..100`. |
| `offset`  | integer                             | `0`     | `>=0`. |
| `tz`      | IANA tz                             | `TZ` SP | Optional display override. Logic uses stored ISO strings. |

> `TZ` Script Property should be `"Europe/Warsaw"`.

---

## Response (JSON shape)

### JSON
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

- **Display fields** are what clients render.
- **Tech fields** (event_id, start_dt, end_dt) are included for clients that need stable IDs or overlap/sorting verification.

### Errors:
- **400**: { "ok": false, "error": "message" } — bad or missing params.
- **500**: { "ok": false, "error": "message" } — unexpected exception (emails ALERT_EMAIL if set).

### Headers:
- Content-Type: application/json; charset=utf-8
- Access-Control-Allow-Origin: *

## Behavior
1) **Window computation**
- day → [date, date]
- week → [date, date+6]
- weekend → Saturday/Sunday window containing date
- range → if start and end present, use them; else use [date, date+(days-1)]

All comparisons are inclusive on dates.

2) **Load & join**
- Read **all** rows from events once.
- Build a timesIndex from raw_events keyed by (Source, Link, Date) → Time (comma string).
- For each result row, attach:
    - date = start_dt date part (YYYY-MM-DD)
    - times = timesIndex[source,url,date] if found; otherwise:

if start_dt has a non-midnight time, use that single time ("HH:MM"), else empty.

3) **Filtering**
- **Overlap rule (date parts)**: include if DATE(end_dt) >= start and DATE(start_dt) <= end.
- **Payment**: apply unless payment=any.
- **Category**:
    - Split request category by comma → trim/lowercase → map via taxonomy_alias to canonical set.
    - Keep an event if any requested canonical is a substring token in the event’s categories (pipe list).
- **Source**: if provided, keep events whose source hostname is in the request set.

4) **Sorting (matches implementation)**
- **Date** (from start_dt) ascending
- **Timed first** within the same date (time part of start_dt ≠ 00:00:00)
- **Earliest time** (HH:MM from start_dt) ascending for timed items
- **Title** A→Z (Polish locale, case-insensitive)

This replicates ADR-0011 intent and current code behavior.

5) **Pagination**
- total = count after filtering, before slicing.
- Slice by limit/offset.
- next_offset = (offset + limit < total) ? offset + limit : null.

6) **Logging & alerts**
- Log a single line per request, e.g.:
doGet window=2025-11-12..2025-11-18 pay=any cat=[kids] src=[] total=42 page=20/0
- On exception, send an email to Script Property ALERT_EMAIL (if set) with the error/stack.

## Examples
- Day: ...?date=2025-11-12&period=day&limit=5
- Week (free): ...?date=2025-11-12&period=week&payment=free
- Weekend (kids+music): ...?date=2025-11-12&period=weekend&category=kids,music
- Explicit range + source: ...?start=2025-11-10&end=2025-11-20&source=zoom.lublin.pl
- Pagination: ...?date=2025-11-12&period=day&limit=5&offset=5

## Notes & constraints
- API is **read-only**. Freshness is provided by the daily refresh() → materialize() pipeline.
- Payment coverage is initially limited (unknown) until weekly enrichment jobs (E-Z1 / E-O1) improve it.
- No schema changes are implied by this API.
- All operations are in-memory; avoid per-row calls.

## Compatibility / versioning
- Additive changes only (e.g., new fields) are allowed.
- Breaking changes (field removal/rename, response structure) require a new major tag and client migration.