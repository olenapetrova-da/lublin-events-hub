# ADR-0005: Data model — raw_events → events
*Status:* Accepted  
*Date:* 2025-11-10

## Context
We ingest multiple sources into a staging sheet (`raw_events`) and then transform to a normalized table (`events`) used by the API and clients. The transform must be idempotent, fast (single batch read/write), and timezone-correct (Europe/Warsaw, with DST).

## Raw schema (staging)
**Sheet:** `raw_events`  
**Columns (9):**  
`Title | Date | Time | Venue | Category | Link | Payment for Entry | Source | _EndDate`

Notes:
- `Date`, `_EndDate`: `YYYY-MM-DD` (hub/refresh ensures `_EndDate` exists; if missing, use `Date`).  
- `Payment for Entry`: adapters output `Yes|No|""` (or Polish labels from old payloads). No crawling here.  
- `Category`: raw labels (no taxonomy yet).  
- List pages may omit `Venue` and `Payment`. Enrichment is **off** for daily runs (see ADR-0006/0008/0010).

## Normalized schema (serving)
**Sheet:** `events`  
**Columns (9):**  
`event_id | title | start_dt | end_dt | venue | payment | categories | source | url`

- **event_id** = `sha1( source + '|' + normalize(title) + '|' + start_dt + '|' + normalize(venue) )`.  
- **start_dt / end_dt**: ISO 8601 with `Europe/Warsaw` offset (`+01:00` or `+02:00` depending on date).  
- **payment** ∈ `{free|paid|unknown}`.  
- **categories**: pipe-joined canonical labels `a|b|c`.  
- **source**: hostname (e.g., `zoom.lublin.pl`, `lublin.eu`).  
- **url**: original event link.

## Transform rules (materialize)
Authoritative implementation: `apps_script/Lublin_events_DB_AppScript/materialize.js`. :contentReference[oaicite:1]{index=1}

1) **Times → start_dt / end_dt**
   - Parse `Time` as tokens split by `, ; |`. Recognize either a **single clock time** (`HH:MM`) or a **single range** (`HH:MM–HH:MM`).  
   - **start_dt** = `Date` + **earliest** `HH:MM` if present; otherwise `Date 00:00`.  
   - **end_dt**:
     - If `Date == _EndDate` **and** there is **exactly one** time **range**, use that range’s **end** time.  
     - Otherwise set to `_EndDate 23:59`. :contentReference[oaicite:2]{index=2}

2) **Payment mapping (adapter → normalized)**
   - Map case-insensitively:  
     - `Yes` or tokens like `płat…` → **paid**  
     - `No` or tokens like `bezpłat…` → **free**  
     - else → **unknown**.  
   - This is a pure transform; **acquisition** of payment via detail pages is handled by separate enrichment tasks. :contentReference[oaicite:3]{index=3}

3) **Category mapping**
   - Split raw `Category` by `, ; |` into tokens.  
   - Lookup order (merge source-specific and wildcard `*` buckets): **exact → contains → regex**; then apply `taxonomy_alias` (alias → canonical).  
   - De-dupe, sort A→Z, join with `|`. If no hit → **`other`**.  
   - For unmapped tokens, upsert to `taxonomy_unmapped` with policy `count = max(existing, runCount)` (idempotent). :contentReference[oaicite:4]{index=4}

4) **IDs & normalization**
   - `normalize(title/venue)` removes diacritics (e.g., `ł→l`), collapses spaces, lowercases; ensures stable `event_id`. :contentReference[oaicite:5]{index=5}

5) **I/O & idempotency**
   - One batch read of all needed sheets; one batch write that **overwrites** `events`.  
   - No per-row network calls; no schema changes. :contentReference[oaicite:6]{index=6}

## Consequences
- Deterministic, DST-correct timestamps; stable IDs.  
- Payment remains **unknown** when not present in `raw_events` (daily runs). Weekly/on-demand enrichment tasks improve coverage.  
- Taxonomy remains table-driven and auditable.

## References
- ADR-0006, ADR-0007, ADR-0008, ADR-0009, ADR-0010, ADR-0011, ADR-0012  
- `apps_script/Lublin_events_DB_AppScript/materialize.js` (implementation)
