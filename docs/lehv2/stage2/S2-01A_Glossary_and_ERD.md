# S2-01A — Glossary & ERD (Canonical events + multi-source listings)

This document is a **reference** for Stage 2 terms and the data model when we introduce:
- one **canonical event row** used for Telegram search results
- multiple **source listings** per canonical event
- taxonomy foundation for `theme=` filtering
- a **long‑running events** filter (`lr`) for UX

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
- has `source`, `url`, raw title/venue/payment/times
- can have **zero or many** raw category labels (stored separately)
- multiple listings can map to the same canonical event

### Listing category label (raw)
A single raw label/category extracted from the **source page** for one listing  
(e.g., `Film`, `Wystawa`, `Na żywo`).  
One listing may yield multiple labels; if the source provides no label, we store a special value `__MISSING__`.

### Showtime
A date/time instance used to build:
- `earliest_time` (for ordering + identity contract)
- `times_text` (what we print)

In the canonical model, showtimes attach to the **canonical event**.

### Theme tag (canonical theme)
A stable code used by Telegram payloads (examples: `film`, `koncert`, `teatr`, …).  
Stored as rows in `tags` (`kind='theme'`). **Codes must not change** without payload versioning.

> Important: canonical code is `koncert` (not `muzyka`). “Muzyka”, “Taniec”, etc. from sources map into `koncert`.

### Alias mapping (raw → canonical)
Rules that map source raw category labels to canonical theme tags:
- stored in `tag_alias`
- unknown values are recorded in `tag_unmapped` (including `__MISSING__`)

### Long‑running event (UX filter)
A canonical event whose **originating listing span** is long.  
Rule (locked for now): **long‑running if `range_days >= 21`** (keeps 2–3 day festivals).

Telegram state flag:
- `lr=0` (default): **exclude** long‑running events from results
- `lr=1`: include long‑running events

### User session state (Telegram)

Per-chat session state used by the bot to remember:

- current UX step (`step`)
- selected filters (`period`, `theme`, `pay`, `lr`)
- pagination (`"offset"`)
- a stable anchor for relative windows (`anchor_date`)

This state is stored in the DB table `user_state` and is enforced by a trigger:

- filter change resets `"offset"` to 0
- period change freezes `anchor_date` (Warsaw date) to prevent midnight drift

---

## Data model (tables, keys, relations)

### `sources`
Lookup table for data sources.
- `source_id` (PK, text) — e.g. `official`, `zoom`
- `name` (text, NOT NULL)
- `url` (text, NOT NULL)
- `enabled` (boolean, NOT NULL)

Relations:
- `sources` 1:N `event_listings`
- `sources` 1:N `event_listing_categories`
- `sources` 1:N `tag_alias`
- `sources` 1:N `tag_unmapped`
- `sources` 1:N `events` (via `events.primary_source`)

---

### `events` (canonical, used by Telegram)
Represents the canonical “occurrence” (1 row = 1 Telegram line).

Key columns:
- `event_id` (PK, text) — deterministic hash of the identity contract
- `date` (date, NOT NULL)
- `title_display` (text, NOT NULL)
- `title_norm` (text, NOT NULL) — normalized title used for merge/debug
- `earliest_time` (time, nullable) — `NULL` means “-”
- `times_text` (text, NOT NULL) — e.g. `09:30, 11:30` or `-`
- `venue_best` (text, nullable)
- `pay_best` (text, NOT NULL, default `unknown`) — `free|paid|unknown`
- `primary_source` (text, FK to `sources.source_id`, NOT NULL)
- `primary_url` (text, NOT NULL)
- `merge_key` (text, NOT NULL) — `title_norm|date|earliest_time_or_dash` (debug aid)
- `range_days` (int, NOT NULL, default `1`) — max span in days among contributing listings
- `is_long_running` (boolean, NOT NULL) — derived as `range_days >= 21`
- `updated_at` (timestamptz)

Uniqueness:
- `merge_key` is expected to be unique (identity contract).

Relations:
- `events` 1:N `event_listings`
- `events` 1:N `event_showtimes`
- `events` 1:N `event_tags`

---

### `event_listings` (per source)
Multiple rows may point to one canonical `events.event_id`.

Key columns:
- `listing_id` (PK, text) — deterministic hash of `source|url`
- `event_id` (FK to `events.event_id`, NOT NULL)
- `source` (FK to `sources.source_id`, NOT NULL)
- `url` (text, NOT NULL)
- `title_raw` (text, NOT NULL)
- `venue_raw` (text, nullable)
- `pay_raw` (text, nullable)
- `times_raw` (text, nullable) — raw times string (debug)
- `span_days` (int, NOT NULL, default `1`) — span for THIS listing
- `updated_at` (timestamptz)

Uniqueness:
- unique `(source, url)`.

Relations:
- `event_listings` 1:N `event_listing_categories`

---

### `event_listing_categories` (raw category labels per listing)
Stores **all** category/label strings found on the source page for a given listing.

Key columns:
- `listing_id` (FK to `event_listings.listing_id`, NOT NULL)
- `source` (FK to `sources.source_id`, NOT NULL) — copied for join convenience; must equal the parent listing’s `source`
- `raw_value` (text, NOT NULL) — one raw label per row

PK: `(listing_id, raw_value)`

Special case:
- If a listing has **no** labels, insert one row with `raw_value='__MISSING__'`.

---

### `event_showtimes` (canonical showtimes)
Key columns:
- `showtime_id` (PK)
- `event_id` (FK to `events.event_id`, NOT NULL)
- `date` (date, NOT NULL) — normally equals `events.date`
- `time` (time, nullable) — NULL means “- / unknown time”

Uniqueness (NULL-safe):
- one “unknown time” row per event/day: `UNIQUE(event_id, date) WHERE time IS NULL`
- timed rows unique: `UNIQUE(event_id, date, time) WHERE time IS NOT NULL`

---

### `user_state` (Telegram session state)

Stores one row per chat to support the button-only Telegram UX and pagination.

Key columns:

- `user_state_id` (PK, bigint)
- `chat_id` (text, NOT NULL, UNIQUE)
- `step` (text, NOT NULL) — `main|main2|period|theme|pay`
- `main2` is a “main menu variant after category selection”: once the user selects any category (including `all`), WF-BOT-TG can render a Step2 screen without the “Wybierz kategorię” button.
- `pay` step is reserved for a future pay menu; current MVP uses a pay toggle on Step2 screens.
- `period` (text, nullable) — `today|tomorrow|weekend|week`
- `theme` (text, NOT NULL) — contract code, default `all`
- `pay` (text, NOT NULL) — contract code, default `all` (MVP UI uses only `all` and `free`; other DB-allowed values are reserved)
- `lr` (smallint, NOT NULL) — `0|1`, default `0`
- `"offset"` (int, NOT NULL) — pagination offset, default `0`
- `anchor_date` (date, nullable) — reference date for relative periods
- `updated_at` (timestamptz, NOT NULL)

Constraints:

- `CHECK (period IS NULL OR anchor_date IS NOT NULL)` (stable relative windows)
- allowed-code checks for step/period/theme/pay/lr and `"offset" >= 0`

Relationships:

- none (standalone state table keyed by chat_id)

Future extension:

- optional message editing fields: `last_bot_message_id`, `last_bot_message_at`

---
### `tags`
Canonical tags (for now only `kind='theme'` is needed).

Key columns:
- `tag_id` (PK, text) — e.g. `theme:film`
- `kind` (text, NOT NULL) — `theme`
- `code` (text, NOT NULL) — payload-safe code: `film`, `koncert`, `teatr`, …
- `label_pl` (text, NOT NULL) — UI label (can change anytime)
- `enabled` (boolean, NOT NULL)

Constraints:
- unique `(kind, code)`.

---

### `event_tags`
Many-to-many between canonical events and tags:
- `event_id` (FK to `events.event_id`, NOT NULL)
- `tag_id` (FK to `tags.tag_id`, NOT NULL)

PK: `(event_id, tag_id)`

Rule:
- one canonical event can have **multiple** theme tags, aggregated from **all** raw category labels found across **all** its source listings.

---

### `tag_alias`
Raw-to-canonical mapping:
- `source` (FK to `sources.source_id`, NOT NULL)
- `raw_value` (text, NOT NULL)
- `tag_id` (FK to `tags.tag_id`, NOT NULL)
- `enabled` (boolean, NOT NULL)

PK: (`source`, `raw_value`)

Rule:
- one mapping per (`source`, `raw_value`) → one `tag_id`.

---

### `tag_unmapped`
Capture unknown raw category labels for later review:
- `source` (FK to `sources.source_id`, NOT NULL)
- `raw_value` (text, NOT NULL)
- `seen_at` (timestamptz, NOT NULL)
- `sample_url` (text, nullable)
- `count_seen` (int, NOT NULL)

PK: (`source`, `raw_value`)

Special case:
- Missing category is represented as `raw_value='__MISSING__'` and is handled the same way.

---

## Taxonomy application rules (how tags are produced)

These are **ETL/query rules** (not foreign keys).

### A) Map raw category labels to canonical theme tags
Input:
- `event_listing_categories`: (`listing_id`, `source`, `raw_value`)
- `tag_alias`: (`source`, `raw_value`) → `tag_id`

Rule:
- For each (`source`, `raw_value`) from `event_listing_categories`, look up `tag_alias` by the same (`source`, `raw_value`).
- If found, attach the mapped tag to the canonical event via `event_tags(event_id, tag_id)`,
  where `event_id` comes from the parent `event_listings.event_id`.

### B) Track unmapped and missing categories
Rule:
- If no mapping exists in `tag_alias` for a given (`source`, `raw_value`), upsert into `tag_unmapped`:
  - key: (`source`, `raw_value`)
  - update: `seen_at=now()`, increment `count_seen`, set `sample_url` when available.
- Missing category is represented as `raw_value='__MISSING__'`.

---

## Long‑running events rule (how `lr` affects results)

Definition:
- `range_days` on `events` is the maximum `span_days` across all listings merged into that canonical event.
- `is_long_running = (range_days >= 21)`.

Search behavior (used later in S2‑03 queries):
- If `lr=0` (default): return only events where `is_long_running = false`.
- If `lr=1`: no long‑running filter is applied.

---

## Notes on keeping the Stage 1 schema “stable”
- Keep `db/baseline/supabase_schema_2025-12-17.sql` unchanged as the Stage 1 snapshot.
- Stage 2 uses **new migrations** and uses `s1_*` staging tables plus Stage 2 canonical tables described above.
