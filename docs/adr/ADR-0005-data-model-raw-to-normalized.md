# ADR-0005: Data model — `raw_events` (9 cols) → `events` (normalized)
*Status:* Accepted  
*Date:* 2025-10-29

## Context
We need a stable, testable model: ingest raw as-is, then normalize once for serving queries.

## Decision
- **Staging (`raw_events`) — 9 columns**  
  `Title, Date, Time, Venue, Category, Link, Payment for Entry, Source, _EndDate`
- **Normalized (`events`) — 9 columns**  
  `event_id, title, start_dt, end_dt, venue, payment, categories, source, url`

### Normalization rules
- `title/venue`: trimmed strings.  
- `start_dt`: combine `Date + Time` (fallback start-of-day), tz = Europe/Warsaw.  
- `end_dt`: use `_EndDate` (fallback `Date`); if time range exists, use end-time; else end-of-day.  
- `payment`: map `Bezpłatny`→`free`, `Płatny`→`paid`; `No`→`free`, `Yes`→`paid`; empty→`unknown`.  
- `categories`: map raw `Category` via `taxonomy_map` (exact→contains→regex), apply `taxonomy_alias`; join multi-hit with `|` (else `other`).  
- `event_id`: `sha1(source + '|' + normalize(title) + '|' + start_dt + '|' + normalize(venue))`.

## Consequences
- Staging is append-only and easy to debug.  
- Serving table is compact and consistent for the API.  
- Category/payout rules are editable in Sheets without redeploys.
