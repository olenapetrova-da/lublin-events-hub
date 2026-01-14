# LEHv2 DB schema (Stage 2 — canonical events + multi-source listings + taxonomy)

Stage 2 extends the Stage 1 ingestion schema with **canonical, user-facing events** (what the Telegram bot prints as one line),
while preserving **traceability back to sources** via per-source listings and raw category labels.

> **Keep the Stage 1 snapshot SQL unchanged:** `db/baseline/supabase_schema_2025-12-17.sql`  
> Stage 2 is applied via migrations (S2-01A).

---

## Tables in Stage 2

### Staging (written by WF-INGEST)
- `s1_events` — one row per Hub “event” (source page / logical item), minimal normalization.
- `s1_showtimes` — one row per Hub showtime/date range, minimal normalization.
- `ingest_log` — one row per WF-INGEST run (diagnostics).
- `sources` — lookup table of sources (metadata + enable flag).
- `user_state` — Telegram user session state (WF-BOT-TG; filters + pagination per chat).

### Canonical (queried by the bot)
- `events` — one row per **canonical event occurrence** (one Telegram output line).
- `event_showtimes` — times per canonical event/day (used to render `times_text` and filtering by time presence).
- `event_listings` — one row per **(canonical event occurrence, source URL)** (traceability).
- `event_listing_categories` — raw category labels per listing (supports multiple labels and missing labels).
- `tags` — canonical tags (currently: `kind='theme'`).
- `event_tags` — canonical event ↔ tag assignments (many-to-many).
- `tag_alias` — mapping of `(source, raw_value)` → canonical tag.
- `tag_unmapped` — unknown raw values (including “missing category”) captured for later mapping.

---

## ERD
See Stage 2 ERD and glossary:
- `docs/lehv2/stage2/S2-01A_Glossary_and_ERD.md`
- `docs/lehv2/stage2/diagrams/S2-01_Telegram_UX-and-ERD.drawio.xml`

---

## Concepts: staging vs canonical vs listings

- **Staging row** (`s1_events` + `s1_showtimes`): “what sources publish” with minimal transformation.
- **Canonical event occurrence** (`events`): the deduplicated, user-facing item for a specific date (and earliest time if any).
- **Listing** (`event_listings`): a concrete “this source URL said something about this canonical event occurrence”.
- **Raw categories/labels** (`event_listing_categories`): every label a source page provides for a listing (or `__MISSING__`).
- **Canonical tags** (`tags`, `event_tags`): normalized taxonomy used for filtering (Telegram themes).

---

## Data description

### sources

Lookup table holding metadata for each source.

| Field        | Key | relationship | Data type | nulls are allowed | default |
|-------------|-----|--------------|----------|-------------------|---------|
| **source_id** | PK  |              | text     | no                |         |
| name        |     |              | text     | no                |         |
| url         |     |              | text     | no                |         |
| enabled     |     |              | boolean  | no                | true    |

**Semantics**
- `source_id` – short code, e.g. `'zoom'`, `'official'`.
- `name` – human-readable name.
- `url` – base URL of the source.
- `enabled=false` lets you disable ingestion/query for a source without schema changes.

---

### s1_events

One row per Hub “event” (source page / logical item).

| Field         | Key | relationship                      | Data type | nulls are allowed | default |
|--------------|-----|------------------------------------|----------|-------------------|---------|
| **event_id**  | PK  |                                    | text     | no                |         |
| title        |     |                                    | text     | no                |         |
| source       | FK  | many-to-one → `sources.source_id` | text     | no                |         |
| url          |     |                                    | text     | no                |         |
| category_raw |     |                                    | text     | yes               |         |

**Constraints**
- `PRIMARY KEY (event_id)`
- `UNIQUE (source, url)` guardrail against duplicate pages.

**Semantics**
- Stage 1 is intentionally close to the Hub payload.
- `category_raw` is a single raw value from the listing page (may be NULL).  
  Stage 2 captures *all* labels per listing in `event_listing_categories`.

---

### s1_showtimes

One row per **(s1 event, date range, optional time, optional venue)**.

| Field           | Key | relationship                       | Data type | nulls are allowed | default    |
|----------------|-----|-------------------------------------|----------|-------------------|------------|
| **showtime_id** | PK  |                                     | bigint   | no                | identity   |
| event_id       | FK  | many-to-one → `s1_events.event_id`  | text     | no                |            |
| date           |     |                                     | date     | no                |            |
| time           |     |                                     | time     | yes               |            |
| _end_date      |     |                                     | date     | no                |            |
| venue          |     |                                     | text     | yes               |            |
| payment        |     |                                     | text     | no                | 'unknown'  |

**Constraints**
- `_end_date >= date` (check).
- `UNIQUE NULLS NOT DISTINCT (event_id, date, time, venue)` (Stage 1 de-dupe for repeated Hub rows).

**Semantics**
- Multi-day events are represented as a date range: `[date, _end_date]`.
- All-day cases may have `time IS NULL`.
- `payment` is never NULL; unknown cases use `'unknown'`.

---

### ingest_log

One row per WF-INGEST run (success or failure) for operational traceability.

| column           | type        | nullable | default     | notes |
|-----------------|-------------|----------|-------------|------|
| ingest_log_id   | bigint      | no       | identity    | primary key |
| run_at          | timestamptz | no       | now()       | run timestamp |
| workflow        | text        | no       | 'WF-INGEST' | workflow name |
| execution_id    | text        | yes      |             | n8n execution id (if available) |
| ok              | boolean     | no       |             | true/false |
| status          | text        | no       |             | e.g. 'ok', 'partial', 'error' |
| events_distinct | integer     | yes      |             | metric from ingestion |
| showtimes_total | integer     | yes      |             | metric from ingestion |
| per_source      | jsonb       | yes      |             | per-source diagnostics |
| config          | jsonb       | yes      |             | run config (date/days/etc) |
| summary         | jsonb       | yes      |             | computed summary metrics |
| error           | text        | yes      |             | error details |

**Constraints / indexes**
- `PRIMARY KEY (ingest_log_id)`

---

### user_state

Telegram bot session state stored per chat.

Written by WF-BOT-TG; read by bot logic and S2-03 queries.

| Field | Key | relationship | Data type | nulls are allowed | default |
| --- | --- | --- | --- | --- | --- |
| **user_state_id** | PK |  | bigint | no | identity |
| chat_id | UQ |  | text | no |  |
| step |  |  | text | no | 'main' |
| period |  |  | text | yes |  |
| theme |  |  | text | no | 'all' |
| pay |  |  | text | no | 'all' |
| lr |  |  | smallint | no | 0 |
| offset |  |  | integer | no | 0 |
| anchor_date |  |  | date | yes |  |
| updated_at |  |  | timestamptz | no | now() |

**Constraints / indexes**

- `PRIMARY KEY (user_state_id)`
- `UNIQUE (chat_id)`
- `CHECK (step IN ('main','period','theme','pay'))`
- `CHECK (period IS NULL OR period IN ('today','tomorrow','weekend','week'))`
- `CHECK (theme IN ('all','teatr','film','koncert','spotkanie','warsztat','wystawa','wycieczka','sport','inne'))`
- `CHECK (pay IN ('all','free','paid','unknown'))`
- `CHECK (lr IN (0,1))`
- `CHECK ("offset" >= 0)`
- `CHECK (period IS NULL OR anchor_date IS NOT NULL)` (stable relative windows)

**Semantics**

- `chat_id` is stored as **text** for MVP compatibility (n8n payloads are strings). Uniqueness is enforced by `UNIQUE(chat_id)`.
- `period` may be NULL until the user selects it.
- `anchor_date` freezes the reference date for relative periods to prevent result drift after midnight.
- `offset` is a reserved SQL keyword; in SQL always reference it as `"offset"`.

### Design notes

- **Stable relative windows:** S2-03 queries MUST compute `today/tomorrow/weekend/week` relative to `anchor_date` (Warsaw date), not `now()`.
- **DB-enforced invariants (trigger `tg_user_state_invariants`)**
    - any change to filters (`period`, `theme`, `pay`, `lr`) resets `"offset"` to 0
    - any update refreshes `updated_at`
    - when `period` changes: set `anchor_date` to Warsaw “today”; if `period` is cleared → clear `anchor_date`
- **Message editing deferred:** we do not store Telegram `message_id` fields in MVP. If needed later, add optional columns like `last_bot_message_id` / `last_bot_message_at`.

---

### events (Stage 2 canonical)

One row per **canonical event occurrence** (what the Telegram bot prints as 1 line).  
Deduplication identity is `merge_key = normalize(title) + date + earliest_time_or_dash`.

| Field            | Key | relationship                      | Data type   | nulls are allowed | default |
|-----------------|-----|------------------------------------|------------|-------------------|---------|
| **event_id**     | PK  |                                    | text       | no                |         |
| date            |     |                                    | date       | no                |         |
| title_display   |     |                                    | text       | no                |         |
| title_norm      |     |                                    | text       | no                |         |
| earliest_time   |     |                                    | time       | yes               |         |
| times_text      |     |                                    | text       | yes               |         |
| venue_best      |     |                                    | text       | yes               |         |
| pay_best        |     |                                    | text       | no                | 'unknown' |
| primary_source  | FK  | many-to-one → `sources.source_id` | text       | no                |         |
| primary_url     |     |                                    | text       | yes               |         |
| merge_key       |     |                                    | text       | no                |         |
| range_days      |     |                                    | integer    | no                |         |
| is_long_running |     |                                    | boolean    | no                |         |
| updated_at      |     |                                    | timestamptz| no                | now()   |

**Constraints / indexes**
- `PRIMARY KEY (event_id)`
- `UNIQUE (merge_key)`
- Index: `events_date_idx` on `(date)`

**Semantics**
- **Best fields winner rule:** pick values from the listing with best completeness (venue/payment/time present), tie-breaker by source priority (official > zoom).
- `range_days` is the original run length in days derived from Stage 1 date ranges (e.g. `_end_date - date + 1`, max over the underlying source rows).
- `is_long_running` is derived from `range_days` (currently: `range_days >= 21`).
- `primary_source/primary_url` point to the “winner” listing for click-through.

---

### event_showtimes

One row per **(canonical event occurrence, time)**.  
This is the normalized representation of times for a canonical event/day.

| Field          | Key | relationship                       | Data type | nulls are allowed | default |
|---------------|-----|-------------------------------------|----------|-------------------|---------|
| **showtime_id**| PK  |                                     | text     | no                |         |
| event_id      | FK  | many-to-one → `events.event_id`     | text     | no                |         |
| date          |     |                                     | date     | no                |         |
| time          |     |                                     | time     | yes               |         |

**Constraints / indexes**
- `UNIQUE NULLS NOT DISTINCT (event_id, date, time)`
- Index: `(event_id, date)`

**Semantics**
- Deterministic `showtime_id` (hash of `(event_id, date, time_or_dash)`).
- Time may be NULL for “all-day / time unknown” cases.

---

### event_listings

One row per **(canonical event occurrence, source URL)**.
Preserves traceability to the source page and raw fields.

| Field          | Key | relationship                      | Data type   | nulls are allowed | default |
|---------------|-----|------------------------------------|------------|-------------------|---------|
| **listing_id** | PK  |                                    | text       | no                |         |
| event_id      | FK  | many-to-one → `events.event_id`    | text       | no                |         |
| source        | FK  | many-to-one → `sources.source_id` | text       | no                |         |
| url           |     |                                    | text       | no                |         |
| title_raw     |     |                                    | text       | yes               |         |
| venue_raw     |     |                                    | text       | yes               |         |
| pay_raw       |     |                                    | text       | yes               |         |
| times_raw     |     |                                    | text       | yes               |         |
| updated_at    |     |                                    | timestamptz| no                | now()   |

**Constraints / indexes**
- `PRIMARY KEY (listing_id)`
- Guardrail uniqueness: `UNIQUE (source, url, event_id)`
- Index: `event_listings_event_id_idx` on `(event_id)`
- Index: `event_listings_source_idx` on `(source)`

**Semantics**
- Deterministic `listing_id` (hash of `(source, url, event_id)`), so the **same URL** can appear for multiple canonical dates.
- Raw fields are kept even if canonical “best” fields choose another listing.

---

### event_listing_categories

Stores **all raw category labels** attached to a listing.
Supports multiple labels and the “missing category” case.

| Field       | Key | relationship                           | Data type | nulls are allowed | default |
|------------|-----|-----------------------------------------|----------|-------------------|---------|
| listing_id | FK  | many-to-one → `event_listings.listing_id` | text   | no                |         |
| raw_value  |     |                                         | text     | no                |         |
| source     | FK  | many-to-one → `sources.source_id`        | text     | no                |         |

**Constraints / indexes**
- `PRIMARY KEY (listing_id, raw_value)`
- Index: `(source, raw_value)` to support alias/unmapped review

**Semantics**
- If a listing has no category on the source page, insert `raw_value='__MISSING__'`.
- If a listing has multiple labels, insert one row per label.

---

### tags

Canonical tags (taxonomy). Currently used for Telegram “themes”.

| Field        | Key | relationship | Data type | nulls are allowed | default |
|-------------|-----|--------------|----------|-------------------|---------|
| **tag_id**   | PK  |              | text     | no                |         |
| kind        |     |              | text     | no                |         |
| code        |     |              | text     | no                |         |
| label_pl    |     |              | text     | no                |         |
| enabled     |     |              | boolean  | no                | true    |

**Constraints**
- `UNIQUE (kind, code)`

**Semantics**
- `kind='theme'` for Telegram category filters.
- `code` is the stable identifier used by queries/contracts (example: `'koncert'`).

---

### event_tags

Many-to-many relation between canonical events and canonical tags.

| Field   | Key | relationship                 | Data type | nulls are allowed | default |
|--------|-----|-------------------------------|----------|-------------------|---------|
| event_id | FK | many-to-one → `events.event_id` | text   | no                |         |
| tag_id  | FK | many-to-one → `tags.tag_id`     | text   | no                |         |

**Constraints / indexes**
- `PRIMARY KEY (event_id, tag_id)`
- Index: `event_tags_tag_id_idx` on `(tag_id)`

---

### tag_alias

Mapping table: when a source uses a raw label, map it to a canonical tag.

| Field     | Key | relationship                      | Data type | nulls are allowed | default |
|----------|-----|------------------------------------|----------|-------------------|---------|
| source   | FK  | many-to-one → `sources.source_id` | text     | no                |         |
| raw_value|     |                                    | text     | no                |         |
| tag_id   | FK  | many-to-one → `tags.tag_id`        | text     | no                |         |
| enabled  |     |                                    | boolean  | no                | true    |

**Constraints / indexes**
- `PRIMARY KEY (source, raw_value)`
- Index: `tag_alias_tag_id_idx` on `(tag_id)`

---

### tag_unmapped

Captures unknown raw labels for later review (including the “missing category” sentinel).

| Field      | Key | relationship                      | Data type   | nulls are allowed | default |
|-----------|-----|------------------------------------|------------|-------------------|---------|
| source    | FK  | many-to-one → `sources.source_id` | text       | no                |         |
| raw_value |     |                                    | text       | no                |         |
| seen_at   |     |                                    | timestamptz| no                | now()   |
| sample_url|     |                                    | text       | yes               |         |
| count_seen|     |                                    | integer    | no                | 1       |

**Constraints**
- `PRIMARY KEY (source, raw_value)`


---

## Taxonomy application rules (how tags are produced)

Given a listing `L` in `event_listings`:

1. Extract all raw labels into `event_listing_categories`:
   - if no label exists on the source page, insert one row with `raw_value='__MISSING__'`.
2. For each `(source, raw_value)`:
   - if an enabled row exists in `tag_alias`, attach `event_tags(event_id, tag_id)`.
   - otherwise upsert `(source, raw_value)` into `tag_unmapped` with `count_seen += 1` and a `sample_url`.

This allows you to:
- filter users by canonical themes (`event_tags`), and
- continuously improve mappings by reviewing `tag_unmapped`.

---

## Identifier strategy (Stage 2)

- **Canonical identity (events.merge_key → events.event_id)**
  - `merge_key = normalize(title) + '|' + date + '|' + earliest_time_or_dash`
  - `event_id = 'ev:' || sha1(merge_key)`
  - This intentionally avoids venue in identity because venue may require enrichment.

- **Listings identity (event_listings.listing_id)**
  - `listing_id = 'ls:' || sha1(source + '|' + url + '|' + event_id)`
  - Allows the same URL to be associated with multiple canonical dates (multi-day pages).

- **Canonical showtime identity (event_showtimes.showtime_id)**
  - `showtime_id = 'st:' || sha1(event_id + '|' + date + '|' + time_or_dash)`
  - `UNIQUE NULLS NOT DISTINCT (event_id, date, time)` ensures no duplicate “time slots”.

---

## Retention and lifecycle (Stage 2)

- **Staging retention** (`s1_*`):
  - can be broader (depends on your ingestion strategy), but the canonicalization routine only reads rows intersecting the requested window.

- **Canonical retention** (`events`, `event_listings`, `event_showtimes`, `event_tags`, `event_listing_categories`):
  - expected to be pruned automatically outside the active window (e.g. today..today+N) to keep the DB small and bot queries fast.
  - long-running events are not dropped; they are flagged with `is_long_running=true` and filtered by user choice.



---
## Open points / future extensions (outside S2-01A)

- Optional (future): store Telegram message ids for message editing (last_bot_message_id, last_bot_message_at).
- Search/query patterns + pagination (S2-03).
- Enrichment (venue normalization, geocoding, organizer, etc.).
- Multi-tag types beyond `kind='theme'` (e.g. audience, language, format).
