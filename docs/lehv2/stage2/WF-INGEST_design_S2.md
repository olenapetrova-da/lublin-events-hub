# WF-INGEST design (Stage 2 – Hub → PostgreSQL + canonicalization)

Workflow: `WF-INGEST – Hub → DB`  
Scope:
- ingest Hub JSON into **staging** tables (`s1_events`, `s1_showtimes`)
- run **one SQL call** to materialize Stage 2 canonical tables for the window (`public.s2_01a_apply(...)`)
- keep operations low and logic testable in SQL

n8n workflow skeleton (Stage 2)” mirroring the structure from the Stage 1 doc, but updated for “staging upserts + one SQL canonicalization call.

---

## 0) Authority and related documents

If there is any conflict, these documents take precedence:

- Canonical model glossary/ERD  
  - `docs/lehv2/stage2/S2-01A_Glossary_and_ERD.md`

- Telegram UX / payloads  
  - `docs/lehv2/stage2/S2-01_Telegram_UX_MVP_spec_v3.md`  
  - `docs/lehv2/stage2/S2-01_TG_payload_contract.md`

---

## 1) Inputs (Config)

Workflow computes:
- `date` = today in `Europe/Warsaw` (string `YYYY-MM-DD`)
- `days` = window length (manual parameter in the config node)

Hub request uses these values to fetch the window.

---

## 2) High-level flow

### Step A — Fetch Hub events (single HTTP)
- `HTTP – Fetch Hub events` calls Hub once for the window.
- Response is an array of events with aggregated showtimes.

### Step B — Stage 1 writes (staging tables)
Two parallel branches:

**Branch 1: `s1_events`**
- split the events array
- map fields
- compute `event_id`
- upsert into `public.s1_events` by `event_id`

**Branch 2: `s1_showtimes`**
- build showtime rows from the Hub payload
- upsert into `public.s1_showtimes`

Optional cleanup SQL can run inside this branch (e.g., removing obviously broken rows).

### Step C — Barrier / join
Wait for both branches to finish, then continue.

### Step D — Run canonicalization (single SQL call)
Call:
`SELECT public.s2_01a_apply(window_start, window_end);`

where:
- `window_start` is the configured `date`
- `window_end = window_start + (days - 1)`

The function:
- upserts canonical `events`, `event_listings`, `event_showtimes`
- applies taxonomy mapping into `event_tags`
- captures unknown/missing labels into `tag_unmapped`
- applies retention (prunes Stage 2 tables outside the window when configured)

### Step E — Logging
Insert a single `ingest_log` row with:
- window start/end
- counts returned by `s2_01a_apply`
- ok/fail + timestamps

---

## 3) Operational expectations

- Workflow should run daily (Schedule Trigger).
- Failures must be visible (n8n error + missing ingest_log row).
- Canonicalization must run **once** per workflow execution (after both staging branches complete).

---

## 4) Notes

### Timezone
Supabase/Postgres may run in UTC, while the window date is computed in Europe/Warsaw in n8n.  
This is OK as long as `date` is passed explicitly (string → `::date`) and you do not rely on `current_date` inside the workflow.

### Long-running events switch
The ingestion routine always materializes canonical events; the **filter** (exclude long-running when `lr=0`) is applied at query time in S2-03.

### Payment strategy v2 (S2-07A): FREE cheaply, else UNKNOWN
Stage 2 “payment” is intentionally **not enriched** per event in S2-07A.

Key intent:
- detect **FREE** cheaply from list pages:
  - Zoom: wrapper marker (`data-infos-ids`) → Hub emits `"Payment for Entry":"No"` when FREE
  - lublin.eu (OFFICIAL): dual-fetch (default + FREE-filter POST) + URL membership → Hub emits `"Payment for Entry":"No"` when FREE
- everything else remains **UNKNOWN** (Hub emits empty string)

Workflow implications:
- In WF-INGEST mapping, normalize staging payment strictly to:
  - `free` when Hub `"Payment for Entry"` indicates FREE (`"No"`)
  - `unknown` otherwise (including empty/whitespace)
- Do **not** produce `paid` in S2-07A (reserved for later enrichment).

Canonicalization expectation (DB-side):
- `events.pay_best = 'free'` if **any** contributing listing/showtime says free
- else `events.pay_best = 'unknown'`

---

## 5) Ops canary: Zoom adapter (FREE marker health)

### Purpose
Zoom “FREE” detection relies on list-page wrapper markers (`data-infos-ids`). If Zoom changes markup or marker IDs, FREE detection can silently stop. The adapter response includes canary counters to catch this early.

### Health-check request (template)
Use a stable, low-cost request (no enrichment, no `/w-trakcie/`):

`https://zoom-lublin-2hub.elenipster.workers.dev/?date={{$now.setZone('Europe/Warsaw').toFormat('yyyy-LL-dd')}}&period=day&days=7&pages=2&include_in_progress=0&group_times=1&limit=100`

Key fields to monitor:
- `free_detected_count_total`, `free_detected_count_returned`
- `parser_wrapper_events_total`, `parser_card_events_total`
- `events_scanned_total`, `events_after_window_filter`, `events_after_grouping_total`
- `budget_used`, `pages_scanned`, `scanned[]`

### Alarm rules
Trigger an alert if **either** condition is true:

1) **FREE detection died**
- `free_detected_count_total == 0`

2) **Wrapper parsing died (FREE marker can’t be read)**
- `parser_wrapper_events_total == 0` **AND** `parser_card_events_total > 0`

(Reason: card parsing may still work, but FREE markers are on wrapper tags.)

### Investigation steps (when alarm fires)
1) Re-run the same request with a known FREE event slug:
   - add `&debug_slug=<event_ref>`
2) Inspect the event object:
   - expect `__debug_parseMode="wrapper"`
   - expect `__debug_infosRaw` to include marker ID(s) (e.g. `"34"`)
3) If marker IDs changed:
   - temporarily test with `&zoom_free_info_ids=<csv>` (e.g. `34,99`)
   - then update Worker env binding `ZOOM_FREE_INFO_IDS="34,99"` and redeploy if needed
4) If wrapper parsing fails (`__debug_parseMode="card"`):
   - Zoom markup changed; update wrapper-tag detection in the worker
5) Use response counters to localize issues:
   - `events_scanned_total` low → page cap/budget/crawl change
   - `events_after_window_filter` low → window/date mismatch
   - `budget_used` unexpectedly high → regression in fetch/cache behavior

### Optional: n8n canary workflow (recommended)
A tiny separate workflow is enough (no changes to WF-INGEST required):
- Cron daily (e.g. 09:00 Europe/Warsaw)
- HTTP Request → health-check URL above
- Set node → compute `alarm` boolean:
  - `free_detected_count_total==0 OR (wrapper==0 AND card>0)`
- IF → on TRUE send Telegram message to your private chat

Telegram chat_id note:
- message your bot once (e.g. `/start`)
- use Telegram “Get Updates” (or your bot workflow execution) to copy `message.chat.id`

---

## 6) Ops canary: OFFICIAL adapter (FREE filter health)

### Purpose
lublin.eu (OFFICIAL) FREE detection relies on a **POST filter contract** (`bezplatne=1&filtruj=1`) + URL membership matching. If the POST contract changes, FREE detection can silently stop unless monitored.

### Health-check request (template)
Use a low-cost request that primarily validates the POST flow (not the “existence” of free events):

`https://official-lublin-2hub.elenipster.workers.dev/?date={{$now.setZone('Europe/Warsaw').toFormat('yyyy-LL-dd')}}&period=day&days=1&pages=1&include_in_progress=0&group_times=1&limit=200&sheet=0`

Key fields to monitor:
- `free_filter_post_ok_pages`, `free_filter_post_fail_pages`
- `free_filter_post_unapplied_pages`, `free_filter_post_skipped_budget`
- `free_filter_mode`, `free_filter_body_config`
- (secondary) `free_detected_count_total`
- `budget_used`, `pages_scanned`, `scanned[]`

### Alarm rules
Trigger an alert if **any** of these is true:
- `free_filter_post_ok_pages == 0`
- `free_filter_post_fail_pages > 0`
- `free_filter_post_unapplied_pages > 0`
- `free_filter_post_skipped_budget > 0`

Optional “soft” alarm (can be noisy if a day has no free events):
- `free_detected_count_total == 0` for multiple consecutive checks

### Investigation steps (when alarm fires)
1) Confirm the worker `version` in response matches the expected deployed build.
2) Verify the POST contract fields in response:
   - `free_filter_body_config` should match expected (e.g. `bezplatne=1&filtruj=1`)
3) If POST fails or returns empty:
   - re-check request headers + content-type (form-encoded)
   - re-check if the site moved filter parameter names
4) If POST succeeds but FREE count is unexpectedly low:
   - verify URL normalization:
     - compare `_fp_url` paths from default vs free-only lists
     - ensure http/https normalization and trailing slash handling are consistent

### Optional: n8n canary workflow (recommended)
Same pattern as Zoom canary:
- Cron daily (e.g. 09:00 Europe/Warsaw)
- HTTP Request → OFFICIAL health-check URL above
- Set node computes:
  - `alarm = (ok_pages==0) OR (fail_pages>0) OR (unapplied>0) OR (skipped_budget>0)`
- IF → on TRUE send Telegram message

## WF-INGEST run summary telemetry (S2-07A hardening)

WF-INGEST includes a Code node **“Summary – metrics for WF-INGEST”** that emits one JSON object with:
- the **config** used for the run (date/period/days/pages/limit/include_in_progress)
- the **Hub telemetry** from the Hub response (received/deduped/count/events array length/per_source/dedupe_stats)
- the **pipeline telemetry** after mapping (events distinct, showtimes totals, per-source counts)
- optional **DB prune** count if the prune node returns `to_prune`

### Why this exists
Hub `count` is the number of Hub “event objects” returned.
WF-INGEST may generate **more showtime rows than Hub events** when:
- a Hub event has multiple times (split into multiple showtimes)
and may generate **fewer showtime rows** when:
- a Hub event has missing/invalid date/time and is dropped during mapping/normalization (this should be rare; investigate)

### What to watch (manual or alarms)
Treat these as investigation triggers (not strict invariants):
- `hub.events_array_length != hub.count`  → Hub payload shape issue
- `pipeline.events_distinct << hub.count` → mapping is dropping events or event_id collisions
- sudden drop to 0 in per-source `showtimes_per_source[source]` while Hub per_source still reports `got>0`
- `showtimes_distinct_in_run < showtimes_total` (duplicates created inside one run)

### Investigation playbook (fast)
1) Compare `hub.per_source` vs `pipeline.events_per_source` vs `pipeline.showtimes_per_source`
2) If one source drops: inspect mapping rules for that source (date parsing, URL normalization, time split)
3) Re-run the same Hub URL in a browser and verify the event objects contain Date/Link/Source as expected