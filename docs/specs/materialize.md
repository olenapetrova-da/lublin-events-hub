# Materialize spec — raw_events → events

This document describes the behavior implemented in `apps_script/Lublin_events_DB_AppScript/materialize.js`. It is the operational counterpart to ADR-0005. :contentReference[oaicite:7]{index=7}

## Inputs
- `raw_events` (9 cols): `Title | Date | Time | Venue | Category | Link | Payment for Entry | Source | _EndDate`
- `taxonomy_map` (source, source_key, source_label, match_type, canonical)
- `taxonomy_alias` (alias, canonical)
- `taxonomy_unmapped` (source, raw_label, count) — updated in place

## Outputs
- `events` (9 cols): `event_id | title | start_dt | end_dt | venue | payment | categories | source | url`

## Rules (summary)
- **Timezone:** `Europe/Warsaw`. Use ISO strings with real DST offset (`+01:00`/`+02:00`).  
- **start_dt:** earliest time on `Date` if present else `00:00`.  
- **end_dt:** if there is exactly **one** time **range** on the same day, use its end; otherwise `_EndDate 23:59`.  
- **payment:** `Yes/No/Bezpłatny/Płatny → paid/free/unknown`.  
- **categories:** per-source mapping (**exact → contains → regex**) + alias; else `other`.  
- **unmapped:** upsert with `count = max(existing, runCount)`.  
- **event_id:** `sha1(source|norm(title)|start_dt|norm(venue))`.  
- **I/O:** single batch read & write; overwrite `events`.

## Helper behaviors
- `normalizeForId()` strips diacritics (`ł→l`, `ß→ss`), collapses whitespace, lowercases.  
- `toISO()` formats with correct offset and a colon in the timezone (`+01:00`).  
- `analyzeTimes()` supports single clocks and ranges, accepts `–/—/-` separators. :contentReference[oaicite:8]{index=8}

## Non-goals
- No enrichment (no HTTP).  
- No cross-source dedupe (hub’s job).  
- No multi-row expansion for multi-times (keep single row; union is handled earlier).

## Tests (suggested)
1) Single time `10:00` on same day → `start_dt=10:00`, `end_dt=23:59`.  
2) Single range `10:00–12:00` on same day → `end_dt=12:00`.  
3) No times, multi-day → `start_dt=00:00` (start), `end_dt=23:59` (end).  
4) Payment `Yes/No/Bezpłatny/Płatny/""` → `paid/free/unknown`.  
5) Category tokens map via exact/contains/regex; else log to `taxonomy_unmapped`.  
6) Diacritics in title/venue still produce stable IDs.
