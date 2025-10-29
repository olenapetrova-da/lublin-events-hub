# Architecture — Minimal Make Ops (2025-10-28)

This describes the two paths: **Refresh** (daily) and **Serve** (on-demand).

## Diagram (Mermaid)

```mermaid
flowchart TD
  subgraph Sources
    A1[lublin.eu (official adapter)]
    A2[zoom.lublin.pl (zoom adapter)]
  end

  A1 --> H[hub (merge/dedupe, JSON when sheet=0)]
  A2 --> H

  subgraph AppsScript[Apps Script on Google]
    R[refresh()]
    M[materialize()]
    Q[doGet(e) - Query API]
  end

  H --> R --> S1[(raw_events)]
  S1 --> M --> S2[(events)]
  Q --> S2

  subgraph Make[Make/Telegram]
    T1[Parse user text → params]
    T2[HTTP → Apps Script API]
    T3[Send Message]
  end

  Q <-- JSON --> T2
```

## Components & responsibilities
- **official adapter / zoom adapter**: scrape sources; normalize minimal fields; keep `_EndDate` in zoom.
- **hub**: merge, dedupe showtimes, unify fields; `sheet=0` returns JSON `events[]`.
- **Apps Script**:
  - `refresh()`: call hub once/day for 7 days; write `raw_events` (10 columns).
  - `materialize()`: normalize, map categories, compute IDs; write `events`.
  - `doGet(e)`: filter/sort/paginate `events`; return JSON.
- **Make**: only per-request glue (parse text → HTTP → message).

## I/O shapes

### Hub JSON event (typical)
```json
{
  "Title": "…",
  "Date": "YYYY-MM-DD",
  "Time": "HH:MM or HH:MM–HH:MM",
  "Venue": "…",
  "Category": "raw label(s)",
  "Link": "https://…",
  "Image URL": "https://…",
  "Payment for Entry": "Bezpłatny|Płatny|Yes|No|",
  "Source": "lublin.eu|zoom.lublin.pl",
  "_EndDate": "YYYY-MM-DD"
}
```

### raw_events (staging, 10 columns)
`Title, Date, Time, Venue, Category, Link, Image URL, Payment for Entry, Source, _EndDate`

### events (normalized)
`event_id, title, start_dt, end_dt, venue, payment, categories, source, url`

- `payment`: `free|paid|unknown`
- `categories`: pipe-joined canonicals
- `start_dt/end_dt`: ISO8601 with Europe/Warsaw offset

## Filters (doGet)
Params: `date`, `period (day|week|range|weekend)`, `days`, `payment (any|free|paid)`, `category (aliases ok)`, `limit`, `offset`.

Order:
1. Resolve date window from `date+period` (or `days`).
2. Apply payment filter (if not `any`).
3. Map category aliases → canonicals; filter.
4. Sort by `start_dt`, then `title`.
5. Paginate.

## Error handling
- If hub unreachable: keep last successful `events`; expose `"stale": true` flag in API (optional).
- If category unmapped: append to `taxonomy_unmapped` and render as `other`.
- If time missing: use start-of-day for `start_dt`; end-of-day for `end_dt`.

## Secrets & limits
- Store hub URL and sheet IDs in your Apps Script Properties (not in code).
- Respect hub `limit/pages` to avoid large payloads.
- If needed, add simple backoff/retry in `refresh()`.
