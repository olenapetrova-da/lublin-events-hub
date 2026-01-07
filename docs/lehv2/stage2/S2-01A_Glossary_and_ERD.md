# S2-01A — Glossary & ERD (Canonical events + multi-source listings)

This document is a **reference** for terms used in Stage 2 when we introduce:
- one **canonical event row** used for Telegram search results
- multiple **source listings** per canonical event
- taxonomy foundation for `theme=` filtering

---

## Glossary (terms you can rely on)

### Logical event (real world)
A real-world happening as people describe it (e.g., “Exhibition X”, “Concert Y”).  
**Not** a DB entity in MVP (too hard to identify reliably across days/sources).

### Canonical event (aka *occurrence*, MVP)
**One row = one line in Telegram results.**  
Identity contract (locked): `normalize(title) + date + (earliest_time or "-")`.

Why “occurrence”: in MVP the canonical entity is **date-scoped** (it’s “this title on this date”, not a full multi-day concept).

### Listing (source listing)
One source’s representation of an event (Zoom / Official / future sources):
- has `source`, `url`, `category_raw` (and possibly missing venue/payment until enrichment)
- multiple listings can map to the same canonical event

### Showtime
A date/time instance used to build:
- `earliest_time` (for ordering + identity contract)
- `times_text` (what we print)

In the canonical model, showtimes attach to the **canonical event**.

### Theme tag (canonical theme)
A stable code used by Telegram payloads (examples: `film`, `muzyka`, `teatr`, …).  
Stored as rows in `tags` (`kind='theme'`). **Codes must not change** without payload versioning.

### Alias mapping (raw → canonical)
Rules that map `category_raw` (per source) to a canonical theme tag:
- stored in `tag_alias`
- unknown values are recorded in `tag_unmapped`

### “Winner” / Primary listing
When multiple listings map to one canonical event, we choose one listing as **primary** for:
- `events.title_display`
- `events.primary_url`
- `events.primary_source`
- (and potentially `venue_best`, `pay_best`)

Selection rule (locked):
1) pick listing with **highest completeness score**
2) tie-breaker: `official > zoom > others`
3) final tie-breaker: stable ordering by `source, url`

Completeness score: count of filled fields among:
- venue (known)
- payment (known and not `unknown`)
- has at least one time (or is known to be all-day/ongoing)
(we can refine later; keep simple for MVP)

---

## Canonical data model (Option 2 — clean refactor)

### `sources`
Lookup table for data sources.
- `source_id` (PK, text) — e.g. `official`, `zoom`
- `name` (text)

Relations:
- `sources` 1:N `event_listings`
- `sources` 1:N `event_listing_categories`
- `sources` 1:N `tag_alias`
- `sources` 1:N `tag_unmapped`
- `sources` 1:N `events` (via `events.primary_source`)

### `events` (canonical, used by Telegram)
Represents the canonical “occurrence” (1 row = 1 Telegram line).

Key columns (suggested):
- `event_id` (PK, text) — deterministic hash of the identity contract
- `date` (date) — the occurrence date
- `title_display` (text) — what Telegram prints as the title
- `title_norm` (text) — normalized title used for merge/debug
- `earliest_time` (time, nullable) — `NULL` means “-”
- `times_text` (text) — e.g. `09:30, 11:30` or `-`
- `venue_best` (text, nullable)
- `pay_best` (text, NOT NULL, default `unknown`) — `free|paid|unknown`
- `primary_source` (text, FK to `sources.source_id`)
- `primary_url` (text)
- `merge_key` (text) — human-readable: `title_norm|date|earliest_time_or_dash` (debug aid)
- `updated_at` (timestamptz)

### `event_listings` (per source)
Multiple rows may point to one canonical `events.event_id`.

Key columns (suggested):
- `listing_id` (PK, text) — deterministic hash of `source|url`
- `event_id` (FK to `events.event_id`)
- `source` (FK to `sources.source_id`)
- `url` (text)
- `title_raw` (text)
- `venue_raw` (text, nullable)
- `pay_raw` (text, nullable)
- `times_raw` (text, nullable) — optional debug (raw times string)
- `updated_at` (timestamptz)

### `event_listing_categories` (raw category labels per listing)
Stores **all** category/label strings found on the source page for a given listing.

Key columns (suggested):
- `listing_id` (FK to `event_listings.listing_id`, NOT NULL)
- `source` (FK to `sources.source_id`, NOT NULL) — copied for join convenience; must match the parent listing’s `source`
- `raw_value` (text, NOT NULL) — one raw category label per row

PK: (`listing_id`, `raw_value`)
**Relations**: `event_listings` 1:N `event_listing_categories`, `sources` 1:N `event_listing_categories`

Special case:
- If a source listing has **no** category labels, insert one row with `raw_value='__MISSING__'`.


### `event_showtimes` (canonical showtimes)
Key columns (suggested):
- `showtime_id` (PK)
- `event_id` (FK to `events.event_id`, NOT NULL)
- `date` (date, NOT NULL) — normally equals `events.date`
- `time` (time, nullable) — NULL means “- / unknown time”

Uniqueness (NULL-safe):
- one “unknown time” row per event/day: `UNIQUE(event_id, date) WHERE time IS NULL`
- timed rows unique: `UNIQUE(event_id, date, time) WHERE time IS NOT NULL`

---

## Taxonomy foundation (Theme)
 (Theme)

### `tags`
Canonical tags (for now only `kind='theme'` is needed).

Key columns:
- `tag_id` (PK, text) — e.g. `theme:film`
- `kind` (text) — `theme`
- `code` (text) — payload-safe code: `film`, `muzyka`, …
- `label_pl` (text) — UI label (can change anytime)
- `enabled` (boolean)

### `tag_alias`
Raw-to-canonical mapping:
- `source` (FK to `sources.source_id`, NOT NULL)
- `raw_value` (text, NOT NULL)
- `tag_id` (FK to `tags.tag_id`, NOT NULL)
- `enabled` (boolean)

PK: (`source`, `raw_value`)
**Rule**: one mapping per (`source`, `raw_value`) → one `tag_id`.

### `event_tags`
Many-to-many between canonical events and tags:
- `event_id` (FK to `events.event_id`)
- `tag_id` (FK to `tags.tag_id`)
PK: `(event_id, tag_id)`
**Relations**: `events` 1:N `event_tags`, `tags` 1:N `event_tags`

**Rule**: one canonical event can have multiple theme tags; `event_tags` is the union of tags mapped from all raw category labels present in all its source listings.


### `tag_unmapped`
Capture unknown raw categories for later review:
- `source` (FK to `sources.source_id`, NOT NULL)
- `raw_value` (text, NOT NULL)
- `seen_at` (timestamptz)
- `sample_url` (text, nullable)
- `count_seen` (int)

PK: (`source`, `raw_value`)
**Relation**: `sources` 1:N `tag_unmapped`

**Special case**:
- If a source listing has no category, store `raw_value='__MISSING__'` (so it still appears in `tag_unmapped` as “missing category”).

## Taxonomy application rules (how tags are produced)

These are **soft relations** (query/ETL logic), not foreign keys.

### A) Map raw category labels to canonical theme tags
Input:
- `event_listing_categories` provides raw labels per listing (`listing_id`, `source`, `raw_value`)
- `tag_alias` provides mappings (`source`, `raw_value`) → `tag_id`

Rule:
- For each (`source`, `raw_value`) found in `event_listing_categories`, look up `tag_alias` by the same (`source`, `raw_value`).
- If found, attach the mapped tag to the canonical event via `event_tags`:
  - `event_tags(event_id, tag_id)` where `event_id` comes from the parent `event_listings.event_id`.

### B) Track unmapped and missing categories
Rule:
- If no mapping exists in `tag_alias` for a given (`source`, `raw_value`), upsert into `tag_unmapped`:
  - key: (`source`, `raw_value`)
  - update: `seen_at=now()`, increment `count_seen`, set `sample_url` when available.
- Missing category is represented as `raw_value='__MISSING__'` and is handled the same way.


---

## Notes on keeping the Stage 1 schema “stable”
- Keep `db/baseline/supabase_schema_2025-12-17.sql` unchanged as the Stage 1 snapshot.
- Create a **new migration** for S2-01A (Option 2 refactor).
- After applying the migration, export a **new baseline** file (new date) and commit it too.
- Optionally tag the repo before migration (e.g., `v0.4.1-s1-db-baseline`).

---

## ERD
See: `docs/lehv2/stage2/S2-01A_Canonical_ERD.drawio` (open in draw.io / diagrams.net).
