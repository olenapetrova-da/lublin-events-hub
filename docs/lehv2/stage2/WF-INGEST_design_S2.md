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

### Long‑running events switch
The ingestion routine always materializes canonical events; the **filter** (exclude long‑running when `lr=0`) is applied at query time in S2‑03.
