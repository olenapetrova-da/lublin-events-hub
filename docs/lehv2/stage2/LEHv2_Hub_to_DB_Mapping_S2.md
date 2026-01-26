# LEHv2 Hub → DB Mapping (Stage 2)

Stage: **Stage 2 — Canonical events + multi‑source listings + taxonomy foundation**  
Primary goal: support Telegram UX queries (period/theme/pay/long‑running toggle) with a data model that is:
- deduplicated at “1 canonical line per day” level
- traceable back to sources (URLs)
- robust to missing/partial source data
- cheap to maintain (one HTTP to Hub + staging upserts + one SQL canonicalization call)

This document is the Stage‑2 successor of:
- `LEHv2_Hub_to_DB_Mapping_S1.md` (Stage 1 mapping)

## What changed vs Stage 1 (read this first)

Stage 1 mapped Hub fields directly into two tables: `events` + `showtimes`.  
Stage 2 splits the pipeline into **two phases**:

1) **Hub → staging (`s1_events`, `s1_showtimes`)**  
   This phase stores source‑shaped data with minimal transforms.

2) **SQL canonicalization (`public.s2_01a_apply(...)`) → canonical tables**  
   This phase produces what the bot queries:
   - canonical `events` (1 row = 1 Telegram line)
   - `event_showtimes` (canonical showtimes)
   - `event_listings` (per source URL per canonical event)
   - `event_listing_categories` (all raw categories/labels per listing)
   - taxonomy application (`tags`, `event_tags`, `tag_alias`, `tag_unmapped`)

Important implications:
- **Canonical identity is not the Hub event_id.** Stage 2 uses a deterministic identity contract:
  `normalize(title) + date + earliest_time_or_dash`.
- **The same source URL can produce multiple canonical days**, so Stage 2 treats a listing as:
  **(source, url, canonical event_id)**, not just (source, url).
- **Missing categories are tracked** using a special raw value `__MISSING__`.
- **Long‑running events** are supported as a UX filter (toggle): long‑running if `range_days >= 21`.

---

## 1. Hub call used for ingestion

Stage 2 ingestion still uses **one Hub call** per run (same operational principle as Stage 1).

Typical request parameters (conceptual):
- `date` — window start (computed in Europe/Warsaw)
- `days` — number of days in the window (configurable)
- response: JSON array of events (each with showtime/time info)

Notes:
- In Stage 2, `date/days` define the **canonicalization window**.
- Staging tables may contain rows with spans outside the window; canonical tables are pruned to the window.

---

## 2. Identifier and source mapping

### 2.1 Source codes (`public.sources`)
We maintain stable source identifiers such as:
- `official` — lublin.eu
- `zoom` — zoom.lublin.pl

Stage 2 uses source codes in:
- staging rows (`s1_events.source`, `s1_showtimes` joins through event_id)
- listings (`event_listings.source`)
- category capture (`event_listing_categories.source`)
- taxonomy mapping (`tag_alias.source`, `tag_unmapped.source`)
- canonical “best fields” provenance (`events.primary_source`)

### 2.2 Identifiers (Stage 2)
Stage 2 uses **three** identifiers:

1) **Staging event id**: `s1_events.event_id`  
   Comes from the Hub payload. It is stable for a given source row and used to join staging tables.

2) **Canonical event id**: `events.event_id`  
   Generated deterministically from the identity contract:
   - `title_norm = normalize(title)`
   - `date = canonical day within the window`
   - `earliest_time_or_dash = earliest showtime on that day, or "-" if unknown`
   - `merge_key = title_norm | date | earliest_time_or_dash`
   - `event_id = deterministic hash(merge_key)`

   Why: venue may be missing on list pages; we cannot use venue for identity in MVP.

3) **Listing id**: `event_listings.listing_id`  
   A listing is **one source URL attached to one canonical event**.
   It is uniquely identified by:
   - `(source, url, event_id)` (because the same URL can map to multiple canonical days/events)

   This keeps traceability correct for multi‑day pages and avoids losing per‑day associations.

### 2.3 “Logical event” vs canonical event vs listing (Stage 2 view)
- **Logical event** (real world): may span many days; too hard to reliably identify across sources in MVP.
- **Canonical event** (Stage 2): **date‑scoped occurrence** (what the bot prints as one line).
- **Listing**: a single source’s page entry (URL) attached to a canonical event/day.

---

## 3. Field mapping: Hub → staging (Phase 1)

This is “Stage 1 mapping logic”, but the targets are renamed to `s1_*`.

### 3.1 `s1_events`
One row per Hub event object.

Recommended columns (conceptual):
- `event_id` — from Hub
- `source` — stable code (`official`, `zoom`, …)
- `url` — canonical URL to source page
- `title` — title text as given by source
- `category_raw` — raw category/label string (nullable; may be missing)

Transforms:
- Trim whitespace.
- Preserve original strings as‑is; do **not** attempt taxonomy mapping here.

### 3.2 `s1_showtimes`
One row per (staging event_id, date span, optional time).

Recommended columns (conceptual):
- `event_id` — same as in `s1_events`
- `date` — start date (date)
- `_end_date` — end date inclusive (date)
- `time` — nullable (time)
- `venue` — nullable (text)
- `payment` — nullable / enum-ish (`free|paid|unknown`)

#### 3.2.1 Common transforms
- Dates: parse to `date` type.
- End date:
  - if the source provides an end date → store it
  - else → `_end_date = date` (single day)
- Time:
  - parse `HH:MM` if present
  - store NULL if time is absent/unknown
- Venue/payment:
  - keep nullable; canonicalization later decides “best” values.

#### 3.2.2 Multi-showtime logic (splitting `Time`)
If a source provides multiple times in one field:
- split into multiple `s1_showtimes` rows
- keep the same `date/_end_date/venue/payment`
- example: `11:30, 13:30, 15:30` → three rows

#### 3.2.3 Source-specific note: multi‑URL patterns (example: `official`)
Some sources use **one URL for a multi‑day span**.
Stage 2 supports this by:
- allowing `_end_date > date` in staging
- generating per‑day canonical events in the window
- attaching the same `(source,url)` to multiple canonical events via `(source,url,event_id)` uniqueness

---

## 4. Field mapping: staging → canonical tables (Phase 2 / SQL)

The canonicalization routine `public.s2_01a_apply(window_start, window_end)` performs:

### 4.1 Span expansion (staging → per-day rows)
For each `s1_showtimes` row with `[date .. _end_date]`:
- generate one “occurrence day” for each day in the span that falls within the window

Result:
- multi‑day events appear as per‑day canonical events (Telegram UX friendly)

### 4.2 Canonical events: `events`
For each `(title_norm, occ_date)` in the window:
- compute `earliest_time` (min non‑NULL time)
- compute `times_text` (sorted list of times or `-`)
- compute deterministic `event_id` from the identity contract
- choose “best fields” from listings:
  - title_display (from winner listing)
  - venue_best/payment_best (from winner listing)

**Winner rule (locked):** completeness score (venue/payment/time present), tie‑breaker official > zoom.

Long‑running fields:
- `range_days`: maximum span length (days) among contributing listings
- `is_long_running`: `range_days >= 21`
These enable the Telegram filter `lr`.

### 4.3 Canonical showtimes: `event_showtimes`
Insert showtime rows per canonical `event_id`:
- one row for each distinct time on that day
- if no time is known: one row with `time = NULL` (to represent “-”)

Uniqueness (NULL-safe) should ensure:
- at most one NULL-time showtime per `(event_id, date)`
- timed showtimes unique per `(event_id, date, time)`

### 4.4 Listings: `event_listings`
For each canonical event and each contributing source URL:
- insert/update a listing row identified by `(source, url, event_id)`
- store raw fields:
  - `title_raw`
  - `venue_raw`
  - `pay_raw`
  - `times_raw` (raw string)
- store `span_days` for this listing (from staging span)

This guarantees traceability: each canonical event has ≥1 listing.

### 4.5 Raw categories per listing: `event_listing_categories`
Category capture rules:
- If the source provides **multiple** labels for a listing:
  - insert one row per label as `(listing_id, raw_value)`
- If category is missing/NULL/empty:
  - insert exactly one row with `raw_value='__MISSING__'`

Convenience column:
- `source` is stored in `event_listing_categories` to simplify joins;
  it must match the parent listing’s `source`.

### 4.6 Taxonomy application (`tags`, `event_tags`, `tag_alias`, `tag_unmapped`)
- `tag_alias` provides mapping: `(source, raw_value) → tag_id`
- For each captured `(source, raw_value)` from `event_listing_categories`:
  - if mapped → attach `event_tags(event_id, tag_id)`
  - else → upsert into `tag_unmapped(source, raw_value)` and increment counters

Special cases:
- `__MISSING__` is treated like a normal raw_value and can appear in `tag_unmapped`.
- Canonical theme code for music is `koncert` (not `muzyka`).

---

## 5. Payment mapping (Stage 2)

Staging stores payment raw per showtime row.
Canonicalization produces:
- listing-level `pay_raw` (aggregated across times)
- canonical `events.pay_best` from the winner listing

Allowed values:
- `free`, `paid`, `unknown`

Zoom list-page marker → Hub "Payment for Entry"="No"; otherwise empty → DB `unknown`

If multiple values exist across showtimes, the conservative rule is:
- `paid` wins over `free` (because user expects “paid” if any paid instance exists),
- otherwise `free`, else `unknown`.

(If you later want source priority to affect pay, apply it only as a tie‑breaker after completeness.)

---

## 6. Retention and lifecycle (Stage 2)

Stage 2 canonical tables are kept to a moving window:
- `s2_01a_apply` prunes canonical data outside the window (Stage 2 retention)
- staging tables may keep more history (optional), but canonical tables remain “current horizon only”

This keeps:
- bot queries fast
- DB size bounded
- user experience aligned with “current events”

---

## 7. Out of scope / future extensions

- “True logical event” entity (cross‑day/cross‑source identity)
- full-text search
- LLM enrichment (venue normalization, dedupe improvements, tagging assistance)
- personalized ranking

---

## 8. Appendix: Example mapping (Stage 2)

### 8.1 Single-day event with two showtimes
Input (staging):
- `s1_events`: one row (source, url, title, category_raw)
- `s1_showtimes`: two rows with same `date=_end_date`, times `09:30` and `11:30`

Output (canonical):
- `events`: one row for that date, `earliest_time=09:30`, `times_text='09:30, 11:30'`
- `event_showtimes`: two rows with those times
- `event_listings`: one row per source URL attached to that canonical event
- `event_listing_categories`: one row per raw label (or `__MISSING__`)
- taxonomy: `event_tags` inserted where alias exists; else `tag_unmapped`

### 8.2 Multi-day exhibition without time (long-running)
Input (staging):
- `s1_showtimes`: `date=2025-01-22`, `_end_date=2028-02-28`, `time=NULL`

Output (canonical, within window):
- for each day in the window: one canonical `events` row with `times_text='-'`, `earliest_time=NULL`
- `range_days` is large, so `is_long_running=true`
- Telegram filter:
  - `lr=0` excludes it from results
  - `lr=1` includes it
