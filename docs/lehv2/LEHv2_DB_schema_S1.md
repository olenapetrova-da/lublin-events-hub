# LEHv2 DB schema (Stage 1 – draft)

Stage: **Stage 1 – Data backbone (Hub → PostgreSQL)**  
Scope: minimal schema to store events + showtimes coming from the existing Hub JSON, plus a basic `user_state` for the future Telegram bot.  
Runtime DB: **PostgreSQL in Supabase**, `public` schema, no table prefixes.  
Retention: **7-day horizon** – ingestion keeps showtimes for the coming days, with correct handling of multi-day events.

Tables in v1:

- `events`
- `showtimes`
- `sources`
- `user_state`

## ERD

![image.png](image.png)

*(ERD matches the tables below; `showtimes` and `user_state` use surrogate PKs, `events` uses the stable `event_id` from LEHv1, `sources` is a small lookup.)*

---
## Concepts: logical event vs calendar instance

For Stage 1 the schema separates two related but different things:

- **Logical event** – a human-understandable event such as 
  “Kino Bajka: Super pies i kot łotr”, independent of how many days or times it runs.
- **Calendar instance (showtime)** – a concrete occurrence on a specific date, 
  optionally with a specific time and venue.

Tables map to these concepts as follows:

- `events` – one row per logical event **as seen by ingestion**, keyed by `event_id`.
- `showtimes` – one row per calendar instance `(event_id, date, time, venue)`.

**Important nuance (Stage 1):**

- For most sources (e.g. `zoom`) one logical event → one `events` row.
- For some sources (e.g. `official`), the same logical event may have multiple URLs 
  (for different days). In Stage 1 we **do not attempt to merge those URLs** in DB:
  - `events` keeps one row per `(source, url)`,
  - all calendar instances are still represented correctly in `showtimes`.
- Analytics and future enrichment that need “true logical event” grouping can derive it
  by combining `title`, `source`, and possibly other normalized attributes outside this
  minimal Stage 1 schema.


## Data description

### events

One row per **logical event**, independent from specific dates/times.

| Field        | Key | relationship                      | Data type | nulls are allowed | default |
|-------------|-----|------------------------------------|----------|-------------------|---------|
| **event_id** | PK  |                                    | text     | no                |         |
| title       |     |                                    | text     | no                |         |
| source      | FK  | many-to-one → `sources.source_id` | text     | no                |         |
| url         |     |                                    | text     | no                |         |
| category_raw |    |                                    | text     | yes               |         |

**Constraints**

- `PRIMARY KEY (event_id)`
- `FOREIGN KEY (source) REFERENCES sources(source_id)`
- `UNIQUE (source, url)` – prevents duplicate events for the same source page.

**Indexes**

- Implicit index on `event_id` from the primary key.
- Implicit index from `UNIQUE (source, url)`.

**Rationale**

- `event_id` is the **stable ID** reused from LEHv1 / Hub. It is computed by ingestion and does not change over time.
- `title`, `source`, `url` are stable, event-level attributes.
- `category_raw` stores whatever raw category string comes from Hub (`Category` field). Some sources fill it, others leave it empty. Future enrichment (taxonomy/LLM) will use this field but canonical tags will live in separate columns/tables later.
- Stage 1 treats `(source, url)` as the “source-local identity”. This keeps ingestion simple,
  but means that for `official` a single logical exhibition that has several separate URLs
  (one per day) may appear as several `events` rows. This is acceptable for Stage 1 because
  user-facing logic works through `showtimes`, not `events` directly.


---

### showtimes

One row per **(event, date, [time], venue)**.  
Represents the individual showings / dates for an event.

| Field         | Key | relationship                       | Data type | nulls are allowed | default    |
|--------------|-----|-------------------------------------|----------|-------------------|------------|
| **showtime_id** | PK  |                                   | bigint   | no                | identity   |
| event_id     | FK  | many-to-one → `events.event_id`     | text     | no                |            |
| date         |     |                                     | date     | no                |            |
| time         |     |                                     | time     | yes               |            |
| _end_date    |     |                                     | date     | no                |            |
| venue        |     |                                     | text     | yes               |            |
| payment      |     |                                     | text     | no                | 'unknown'  |

**Semantics**

- `date` – calendar date of the showtime (Europe/Warsaw).
- `time` – local start time, or `NULL` for all-day / “no exact time” events.
- `_end_date` – last calendar date the event runs; equals `date` for single-day events.
- `venue` – venue name as a simple text label.
- `payment` – normalized to `'free' | 'paid' | 'unknown'` based on Hub “Payment for Entry”.

**Constraints**

- `PRIMARY KEY (showtime_id)`
- `FOREIGN KEY (event_id) REFERENCES events(event_id)`
- `UNIQUE (event_id, date, time, venue)` – prevents inserting the same showtime twice.

**Indexes**

- Implicit index on `showtime_id` from the primary key.
- B-tree index on `(date, payment)` – supports “future N days, optionally free-only” queries.
- B-tree index on `(event_id)` – supports joins `showtimes → events`.

**Rationale**

- Surrogate PK `showtime_id` keeps references simple if later something needs to refer to a specific showtime (e.g. reservations, logs).
- The `(event_id, date, time, venue)` unique constraint is how we define “duplicate showtime”.
- We store **one row per showtime**, not per event, so multiple dates/times per event are natural.
- `_end_date` is always set by ingestion:
  - if Hub provides `_EndDate`, it is used,
  - otherwise `_end_date = date` (single-day event).
- `payment` is never `NULL`; if ingestion cannot decide, it uses `'unknown'`. This keeps bot filters simple.
- A logical event can have many `showtimes` rows, including:
  - multiple times on the same date,
  - multiple dates in a multi-day run,
  - “all-day” cases with `time IS NULL` and `_end_date > date`.
- Even if `events` has more than one row for a conceptual event (e.g. multiple `official`
  URLs), `showtimes` still correctly represent all calendar instances. Downstream queries
  and bots should primarily reason in terms of `showtimes`, joining back to `events` only
  for event-level attributes (title, URL, category_raw, etc.).


---

### sources

Small lookup table holding metadata for each **Hub source**.

| Field      | Key | relationship | Data type | nulls are allowed | default |
|-----------|-----|--------------|----------|-------------------|---------|
| **source_id** | PK  |              | text     | no                |         |
| label     |     |              | text     | no                |         |
| url       |     |              | text     | no                |         |
| enabled   |     |              | boolean  | no                | true    |

**Semantics**

- `source_id` – short code, e.g. `'zoom'`, `'official'`.
- `label` – human-readable name, e.g. “Zoom Lublin”.
- `url` – base URL of the source.
- `enabled` – whether this source is currently used by the runtime pipelines.

**Constraints**

- `PRIMARY KEY (source_id)`

**Indexes**

- Implicit index on `source_id` from the primary key.

**Rationale**

- A small, strict lookup; no nulls, minimal fields.
- `source_id` doubles as the “code” – no need for a separate `code` column.
- `events.source` references `sources.source_id`, keeping event rows small and consistent.

---

### user_state

Minimal **Telegram user state** for bot flows (Stage 2).  
One row per chat/user.

| Field          | Key | relationship | Data type   | nulls are allowed | default  |
|----------------|-----|--------------|------------|-------------------|----------|
| **user_state_id** | PK  |              | bigint     | no                | identity |
| chat_id        |     |              | text       | no                |          |
| step           |     |              | text       | no                | 'idle'   |
| period         |     |              | text       | yes               |          |
| category       |     |              | text       | yes               |          |
| payment        |     |              | text       | yes               |          |
| offset         |     |              | integer    | no                | 0        |
| updated_at     |     |              | timestamptz| no                | now()    |

**Semantics**

- `chat_id` – identifier from Telegram for this chat.
- `step` – current step in conversation flow (e.g. `'idle'`, `'ask_period'`, `'ask_category'`, etc.).
- `period` – selected period filter (e.g. `'day'`, `'week'`); `NULL` means “default”.
- `category` – selected canonical category filter (e.g. `'kids'`, `'music'`); `NULL` means “no filter”.
- `payment` – selected payment filter, e.g. `'any'`, `'free'`; `NULL` means “no explicit choice”.
- `offset` – pagination offset for list views.
- `updated_at` – last modification timestamp.

**Constraints**

- `PRIMARY KEY (user_state_id)`
- `UNIQUE (chat_id)` – at most one row per chat.

**Indexes**

- Implicit index on `user_state_id`.
- Implicit index on `chat_id` via the unique constraint.

**Rationale**

- Keeps bot state separate from event data.
- Minimal set of fields required for Stage 2 bot (period, category, payment, paging).
- Text values give flexibility to adjust bot flow without schema changes; stricter enums can be added later if needed.

---

## Identifier strategy

- **events.event_id**
  - Stable, text ID computed by the ingestion workflow.
  - Same semantics as the LEHv1 `event_id`, so IDs are preserved across architecture changes.
  - Primary key for joining with `showtimes`.

- **Source event identity**
  - Source-local identity is effectively **`(source, url)`**.
  - Enforced by `UNIQUE (source, url)` on `events`.
  - No separate `source_event_id` column is used in Stage 1.

- **showtimes.showtime_id**
  - Surrogate bigint identity; never used in external contracts.
  - Used internally if any future table needs to point to a specific showtime.

- **user_state.user_state_id**
  - Surrogate bigint identity; app logic uses `chat_id` as the natural key.
  - `UNIQUE (chat_id)` ensures a single row per chat.

---

## Retention and lifecycle (Stage 1 assumptions)

- **Retention horizon:** 7 days starting “today”.
- **Multi-day events:**  
  - Multi-day events that started before today (`date < today`) **must stay visible** as long as they are still running (`_end_date ≥ today`).
- **Practical rule for ingestion workflow:**
  - Keep showtimes where the date range intersects the window `[today, today + 6]`:
    - `date <= today + 6` **and** `_end_date >= today`.
  - Delete or archive showtimes that are **fully in the past** (`_end_date < today`) or **beyond the horizon** (`date > today + 6`).
- New showtimes for the next 7 days are then inserted/merged from Hub JSON.

`events` rows are kept as long as they have at least one relevant `showtime` in the retained window (exact cleanup strategy can be defined in the ingestion spec).

---

## Open points / future extensions (outside Stage 1)

These are intentionally **not** part of the Stage 1 schema but are anticipated:

- Canonical taxonomy (categories, audience, activity types) and mappings.
- Additional fields for enriched metadata (e.g. languages, ticketing links).
- History / archival tables for long-term analytics.
- More detailed user state (e.g. language, home city, notification preferences).

Stage 1 focuses only on the minimal schema needed to:

1. Ingest Hub JSON into PostgreSQL (`events` + `showtimes` + `sources`).
2. Maintain simple bot state (`user_state`) for future Telegram flows.
