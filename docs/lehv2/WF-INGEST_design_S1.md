# WF-INGEST design (Stage 1 – Hub → PostgreSQL)

Status: draft for Stage 1  
Workflow: `WF-INGEST – Hub → DB`  
Scope: ingestion from Hub JSON into `public.events` and `public.showtimes` in Supabase, with a 7-day rolling horizon and minimal logging.

---

## 0. Authority and related documents

This document does not redefine schema or mapping. It only describes how the n8n workflow uses them.

If there is any conflict, these documents take precedence:

- **Schema and constraints**  
  - `docs/lehv2/LEHv2_DB_schema_S1.md`  
  - `db/schema_stage1.sql`

- **Hub → DB mapping and retention rules**  
  - `docs/lehv2/LEHv2_Hub_to_DB_Mapping_S1.md`

- **Runtime / stack decisions**  
  - `docs/adr/ADR-0015-lehv2-runtime-stack-n8n-supabase.md`

`WF-INGEST` must implement those contracts as they are, without redefining them here.

---

## 1. Responsibilities and overview

### 1.1 Responsibility

`WF-INGEST` is responsible for:

- Once per day:
  - calling the Hub JSON API in “DB ingestion mode”,
  - transforming Hub events into DB records,
  - enforcing the 7-day rolling horizon in `showtimes`;
- producing a small per-run summary that can be inspected in n8n and (optionally) stored in DB.
- WF-INGEST treats “same logical event, multiple URLs” cases as one logical event by relying on Hub `event_ref`:
  - it computes `event_id = sha1(source + "|" + event_ref)` and upserts `events` by `event_id`.
  - DB-level dedupe of calendar instances is done at the `showtimes` level (see `UNIQUE NULLS NOT DISTINCT (event_id, date, time, venue)`).

It does not:

- crawl event sources directly,
- perform taxonomy/category canonicalisation,
- serve data to consumers (that will be covered by the Query/API layer in later stages).

### 1.2 High-level phases

Conceptually the workflow has these phases:

1. Trigger and configuration (compute date window, set Hub params).  
2. Fetch Hub JSON (one HTTP GET).  
3. Transform to `events` (event-level records).  
4. Transform to `showtimes` (flat rows per date/time/venue).  
5. Retention (delete showtimes outside the current window).  
6. Upsert into DB (`events` first, `showtimes` second).  
7. Logging and summary.

The rest of this document explains what each phase must do, referencing the existing mapping and schema docs.

---

## 2. Hub contract (how WF-INGEST calls the Hub)

### 2.1 Endpoint and core parameters

`WF-INGEST` calls the Hub worker over HTTP GET using the “DB ingestion” contract described in `LEHv2_Hub_to_DB_Mapping_S1.md`.

Key requirements:

- Response format:
  - top-level JSON with an `events` array and metadata (for example `date`, `period`, `days`, `per_source`, `dedupe_stats`);
- ingestion always uses:
  - `sheet=0`
  - `group_times=1`

These two flags are mandatory and are not configurable in Stage 1.

### 2.2 Date and horizon parameters

`WF-INGEST` computes its own ingestion window:

- `today` – the workflow date (Europe/Warsaw).  
- `window_start = today`.  
- `window_end = today + 6` (inclusive).

Hub parameters are set so that it returns events for this full window. For Stage 1:

- `date = today` (computed in workflow, Europe/Warsaw),  
- `period = "week"`,  
- `days = 7`,  
- `sheet = 0`,  
- `group_times = 1`.

Additional parameters (constants you can tune without changing the contract):

- `pages` (for pagination inside Hub, e.g. 3),  
- `limit` (max events, e.g. 1000),  
- `include_in_progress` (whether to include long-running events that started earlier but are still ongoing).

The exact values of `pages`, `limit`, `include_in_progress` should be centralised in a single configuration node so they can be adjusted later without editing many nodes.

### 2.3 Error handling at the boundary

`WF-INGEST` treats Hub as a single upstream dependency:

- If HTTP status is not `200`, or JSON cannot be parsed:
  - mark the run as failed,
  - do not alter the DB in this run,
  - produce a summary with `status = "error"` and a short message, if possible.
- If the response is valid JSON but `events` is empty:
  - treat as a successful run with zero events,
  - still enforce retention for the date window.

---

## 3. Mapping to DB (events and showtimes)

The detailed field-by-field mapping is defined in `LEHv2_Hub_to_DB_Mapping_S1.md`. `WF-INGEST` does not introduce any new mapping rules; it simply implements that document.

### 3.1 Mapping to `public.events`

`WF-INGEST` must:

- read each Hub event from the `events` array;  
- transform it into an object matching the `public.events` schema and mapping rules in:
  - `LEHv2_DB_schema_S1.md` (events table definition),
  - `LEHv2_Hub_to_DB_Mapping_S1.md` (which Hub fields feed which columns).

Important points to respect:

- `event_id`:
  - must be deterministic and stable across days,
  - must merge “same logical event, multiple URLs” pages within the same source,
  - is computed from Hub `event_ref` and mapped `source` (example: `sha1(source + "|" + event_ref)`).
- `source`:
  - must contain the short source code defined in `public.sources` (for example `zoom`, `official`),
  - must follow the mapping from Hub `Source` values to these codes as defined in the mapping doc.
- `url`, `title`, `category_raw`:
  - must be taken from the fields specified in the mapping doc, with minimal trimming / normalisation as described there.

Upsert semantics:

- Insert/update into `public.events` using the constraints from `schema_stage1.sql`:
  - upsert by primary key on `event_id` (event_id comes from `sha1(source + "|" + event_ref)`),
  - `UNIQUE (source, url)` is a guardrail (URL is user-facing, not the logical identity key).
- On conflict on `event_id`:
  - do not create duplicates,
  - update mutable fields (like `title`, `category_raw`, `url`) according to the chosen implementation.

### 3.2 Mapping to `public.showtimes`

`WF-INGEST` must also:

- take the same set of Hub events,  
- produce one or more “showtime” rows per event according to the rules in `LEHv2_Hub_to_DB_Mapping_S1.md`.

Key points (all details in mapping doc):

- For each event, use the Hub date/time fields:
  - `Date`, `Time`, `_EndDate`, `Venue`, `"Payment for Entry"`.
- Generate rows according to the three cases defined in the mapping doc:
  - events with specific times (one row per time),
  - multi-day all-day events (no time, `_EndDate > Date`),
  - single-day no-time events (no time, `_EndDate == Date` or missing).
- Compute:
  - `date`,
  - `time` (or `NULL`),
  - `_end_date`,
  - `venue`,
  - `payment` (for example mapping Yes/No/empty → `paid`/`free`/`unknown`).

`WF-INGEST` must respect the constraints on `public.showtimes` from `schema_stage1.sql`, in particular:

- foreign key to `events(event_id)`,  
- uniqueness on `UNIQUE NULLS NOT DISTINCT (event_id, date, time, venue)`.

On conflict on `(event_id, date, time, venue)`:

- do nothing (ignore duplicate),
- optionally increase a “conflict count” metric for diagnostics (see logging section).

---

## 4. Retention rules (7-day window)

The retention concept and conditions are defined in `LEHv2_Hub_to_DB_Mapping_S1.md`. `WF-INGEST` must implement them at DB level.

### 4.1 Concept

Only showtimes that intersect the current 7-day horizon are kept.

Given:

- `window_start = today`,  
- `window_end = today + 6`,

we want to:

- keep rows whose `[date, _end_date]` range intersects `[window_start, window_end]`,  
- delete rows that are either:
  - fully in the past (end before `window_start`), or
  - beyond the horizon (start after `window_end`).

### 4.2 Implementation

`WF-INGEST` includes a dedicated retention step that:

- receives `window_start` and `window_end` (computed in the config phase),  
- executes a single delete command on `public.showtimes` with conditions equivalent to:
  - rows with `_end_date < window_start`, and  
  - rows with `date > window_end`.

The exact SQL lives in `schema_stage1.sql` / mapping doc or in a runbook; `WF-INGEST` just needs to call it once per run.

Ordering:

- For Stage 1, retention is applied before inserting/upserting new showtimes for the current run (simple mental model: “clean, then insert fresh window”).

The retention step should return or expose the number of deleted rows so it can be included in the per-run summary.

### 4.3 Timezone

`WF-INGEST` must:

- compute `today` in Europe/Warsaw, aligned with how Hub interprets the `date` parameter,  
- treat retention strictly at date level; time-of-day is not part of the retention decision.

---

## 5. Logging and diagnostics

`WF-INGEST` needs minimal, but structured, diagnostics.

### 5.1 Summary object (always present)

At the end of each successful run, `WF-INGEST` must construct a summary object including at least:

- `run_at` – timestamp of the run (UTC or Warsaw; chosen once and used consistently),  
- `window_start` – date (same as `today`),  
- `window_end` – date (`today + 6`),  
- `hub_events_count` – number of events read from Hub,  
- `events_upserted` – number of events inserted/updated,  
- `showtimes_inserted` – number of showtime rows inserted in this run,  
- `showtimes_deleted` – number of showtimes removed by the retention step.

Optional fields (for later, but can be included now if easy):

- `showtimes_conflicts` – number of attempted inserts that hit the `(event_id, date, time, venue)` unique constraint,  
- `per_source` – counts per source code (for example `{ zoom: 120, official: 40 }`),  
- `status` – `"ok"` or `"error"`,  
- `message` – short free-text message (for example “OK”, or first error message when run fails early).

For failed runs:

- If possible, `WF-INGEST` should still produce a partial summary with at least:
  - `run_at`,
  - `window_start`, `window_end`,
  - `status = "error"`,
  - a short `message`.

In all cases, the n8n execution log is the primary source of detailed diagnostics.

### 7.2 ingest_log table (implemented)

We write one row to public.ingest_log per WF-INGEST run.

Required fields:
- run_ts (now)
- workflow = 'WF-INGEST'
- ok (true/false)
- status ('ok' | 'partial' | 'error')

Recommended payload fields:
- events_count, showtimes_count
- per_source: store as JSON object, not array (e.g. {"sources": <hub.per_source array>})
- config: the Hub request config used for this run
- summary: computed metrics (whatever you want to trend later)
- error: on failures, store the error message/stack snippet

### 7.3 Error handling (WF-INGEST_ERROR_LOG)

A separate workflow uses Error Trigger to log failures from WF-INGEST into ingest_log (ok=false, status='error', error populated) and optionally notify (e.g., Telegram/email).

Note: Error Trigger runs only for automatic executions (Schedule), not manual runs.
---

## 6. n8n workflow skeleton

This section describes the structure of the actual n8n workflow. It is a design reference for implementation in Stage 1, not a separate document.

Node names are indicative; exact names/types can differ as long as behaviour stays the same.

1. **Trigger – Cron / Manual**  
   - Cron: daily at chosen Warsaw time, disabled until S1-07.  
   - Manual: used for S1-05 and S1-06 tests.

2. **Config – Compute window & Hub params**  
   - Compute:
     - `today` (Warsaw),
     - `window_start = today`,
     - `window_end = today + 6`.  
   - Set Hub parameters (`date`, `period`, `days`, `sheet`, `group_times`, `pages`, `limit`, `include_in_progress`).  
   - Allow manual override for `date` (optional, for testing).

3. **HTTP – Fetch Hub events**  
   - One GET call to Hub with parameters from the config node.  
   - Output: parsed JSON with `events` array and metadata.

4. **IF / Error handling (optional but recommended)**  
   - Check HTTP status and presence of `events`.  
   - If error:
     - construct a summary with `status = "error"`,
     - stop the workflow without touching DB.

5. **Map Hub → events**  
   - Node that:
     - takes `events` from the Hub response,
     - computes `event_id` as specified in the mapping doc,
     - maps fields into objects matching `public.events` columns.

6. **Map Hub → showtimes**  
   - Node that:
     - uses the same Hub events (and their `event_id`s),
     - generates one or more showtime objects per event according to mapping rules.

7. **DB – Retention (prune showtimes)**  
   - Node that:
     - uses `window_start` and `window_end`,
     - deletes showtime rows outside the horizon as defined in the mapping doc,
     - exposes the number of deleted rows.

8. **DB – Upsert events**  
   - Node that:
     - batch-upserts objects from “Map Hub → events” into `public.events`,
     - respects constraints defined in `schema_stage1.sql`.

9. **DB – Insert showtimes**  
   - Node that:
     - batch-inserts objects from “Map Hub → showtimes” into `public.showtimes`,
     - ignores uniqueness conflicts on `(event_id, date, time, venue)`.

10. **Build summary**  
    - Node that:
      - collects counts from previous nodes (Hub events, events upserted, showtimes inserted, showtimes deleted),  
      - adds `run_at`, `window_start`, `window_end`,  
      - sets `status` and `message`,  
      - outputs a single summary object.

11. **DB – insert ingest_log row (ok)**  
    - Only used if the optional `public.ingestion_log` table is created later.  
    - Inserts the summary into that table.  
    - Not required for Stage 1 completion.

12. **Final summary node**  
    - Last node in the workflow, exposing the summary object for quick inspection in n8n UI.

---

## 7. Notes on further detail

If needed, a more detailed node-by-node diagram (with input/output shapes, field lists, and example items) can be added later either:

- as a new section in this document (for example “Appendix A – Node reference”), or  
- as a separate file (for example `docs/lehv2/WF-INGEST_nodes_S1.md`) if it grows large.

For Stage 1, this design plus the authoritative mapping/schema docs should be sufficient to implement the workflow without duplicating low-level definitions.
