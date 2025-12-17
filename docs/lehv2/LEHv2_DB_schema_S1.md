# LEHv2 DB schema (Stage 1 – draft)

Stage: **Stage 1 – Data backbone (Hub → PostgreSQL)**  
Scope: minimal schema to store events + showtimes coming from the existing Hub JSON, plus a basic `user_state` for the future Telegram bot.  
Runtime DB: **PostgreSQL in Supabase**, `public` schema, no table prefixes.  
Retention: **7-day horizon** – ingestion keeps showtimes for the coming days, with correct handling of multi-day events.

## Tables in v1:

- `events`
- `showtimes`
- `sources`
- `user_state`
- `ingest_log`

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

- Some sources may publish multiple URLs for the same logical event (e.g. one page per day).
- Stage 1 merges those into a single logical event by relying on Hub `event_ref`:
  - WF-INGEST computes `event_id = sha1(source + "|" + event_ref)` and upserts `events` by `event_id`.
  - Distinct occurrences are represented as distinct rows in `showtimes` (date/time/venue).
- `events.url` stores a full URL for user click-through and may be overwritten by the latest/“best” URL.


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

- `event_id` is the **stable ID** computed by ingestion from `(source, event_ref)` (where `event_ref` is provided by the Hub and stays stable for the same logical event even if the source uses multiple URLs).
- `title` is event-level text and may change slightly over time.
- `url` is a representative source page URL kept for the user; it may change between runs.
- `category_raw` stores whatever raw category string comes from the Hub; canonical tags will live in separate columns/tables later.
- `(source, url)` is kept as an additional uniqueness **guardrail**, but it is not the identity key (identity is `event_id`).


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
- `UNIQUE NULLS NOT DISTINCT (event_id, date, time, venue)`

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

### ingest_log

Purpose: one row per WF-INGEST run (success or failure), to answer:
- last run time
- counts per run
- per-source diagnostics
- error details (if any)

| column          | type         | nullable | default                 | notes |
|----------------|--------------|----------|-------------------------|------|
| ingest_log_id  | bigint       | no       | identity                | primary key |
| run_ts         | timestamptz  | no       | now()                   | run timestamp |
| workflow       | text         | no       | 'WF-INGEST'             | workflow name |
| execution_id   | text         | yes      |                         | n8n execution id (if available) |
| ok             | boolean      | no       |                         | true/false |
| status         | text         | no       |                         | e.g. 'ok', 'partial', 'error' |
| events_count   | integer      | yes      |                         | total events processed/inserted (your metric definition) |
| showtimes_count| integer      | yes      |                         | total showtimes processed/inserted |
| per_source     | jsonb        | yes      |                         | JSON **object** (not array). Recommended shape: {"sources":[...hub.per_source...]} |
| config         | jsonb        | yes      |                         | run config (date/period/days/pages/limit/etc) |
| summary        | jsonb        | yes      |                         | any computed summary metrics |
| error          | text         | yes      |                         | error message/details for failures |

**Constraints / indexes** :
- PK: ingest_log_pkey(ingest_log_id)


## Identifier strategy

- **events.event_id**
  - `events.event_id` is the stable primary identifier.
  - `event_id` is derived from `(source, event_ref)` where `event_ref` is provided by the Hub and is stable across “one URL per day” pages for the same logical event.
  - `events.url` stores a full URL for user click-through. If multiple URLs exist for the same logical event, the stored `url` can be overwritten by the latest/“best” one.
  - `UNIQUE (source, url)` remains as a guardrail, but it is not the logical identity.
  - Primary key for joining with `showtimes`.

- **Source event identity**
  - Source-local logical identity is **`(source, event_ref)`** (Hub field).
  - `event_id` is derived deterministically from `(source, event_ref)` (example: `sha1(source + "|" + event_ref)`).
  - `UNIQUE (source, url)` remains a guardrail against exact duplicate pages, but URL is not the logical identity.

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
