# Refresh & Materialize Runbook
*Updated:* 2025-11-12

This runbook covers the daily pipeline (**refresh → materialize**) and the operational automation (**OPS-TR1**), plus quick API checks and troubleshooting.

---

## Scope
- **refresh()** — call Hub (JSON mode) for a 7-day window; write **`raw_events` (9 cols)**.
- **materialize()** — transform **`raw_events → events` (9 cols)** with DST-correct ISO timestamps, payment/category mapping, and stable `event_id`.
- **doGet()** — read-only API that serves display fields (`date`, `times`, …) and uses normalized timestamps for filtering/sorting.

**References**
- ADR-0005 (raw → normalized), specs/materialize.md
- ADR-0013 (Query API contract), specs/query-api.md
- Architecture: docs/architecture/overview-minimal-make-ops.md

---

## Daily flow
1) `refresh()` calls Hub for a 7-day window (`sheet=0&group_times=1&pages=3&limit=1000`) and writes **raw_events (9 cols)**.  
2) `materialize()` reads `raw_events` and overwrites **events (9 cols)** per ADR-0005.  
3) `doGet` serves from **events**.

---

## Adapter outcomes & operator actions (quick)

- **stopped_reason="budget"** (`has_more=true`): no action. Next day’s run covers remaining pages in the same 7-day window.
- **stopped_reason="pages"**: expected when the `pages` cap hits; bump `pages` temporarily only if you need faster catch-up.
- **stopped_reason="error"**: check `error` text; try `pages=1` to collect near-term events; open a backlog bug (Area: Workers) with the snippet.
- **Missing `_EndDate`**: expected from some sources; Apps Script defaults `_EndDate = Date` on write.

---

## Zoom source specifics
- Zoom includes `/w-trakcie/` (ongoing) by default when `include_in_progress=1`; this can increase counts even with the same date window.

---

## If an adapter hits budget
- Adapter returns partials with `has_more=true`, `pages_scanned`, `budget_used`, `stopped_reason="budget"`.
- **Action:** none required; optionally bump `pages` for faster catch-up.

---

## If an adapter returns `stopped_reason="error"`
- Read `error` in the payload.
- Quick options: set `pages=1` to bypass the broken page and still collect near-term events; file a backlog bug with the snippet.
- API can serve last good `events`; if last refresh >24h, treat data as stale until OPS-TR1 recovers.

---

## Logs & telemetry
- Hub/refresh log prints: `include_in_progress` and a compact `per_source` summary (e.g., `zoom:58; lublin:51`).
- Adapters/Hub also populate: `pages_scanned`, `budget_used`, `has_more`, `stopped_reason`.
- Apps Script should log: `materialize(): in=<raw_rows> out=<events_rows> unmapped_seen=<n>`.

---

## Daily automation (OPS-TR1)

**Functions:** `runDaily`, `setupDailyTrigger`, `removeAllTriggers`  
**File:** `apps_script/Lublin_events_DB_AppScript/ops_triggers.js`  
**Script Properties:** `SHEET_ID`, `TZ="Europe/Warsaw"`, `ALERT_EMAIL` (optional)

### What `runDaily()` does
- Takes a **script lock** (skips run + emails if locked).
- Calls `refresh()` → `materialize()`.
- Logs one summary line:  OPS runDaily: ok=<true|false> raw=<n> events=<n> ms=<elapsed> at=<YYYY-MM-DD HH:MM TZ>
- Appends a **health** row to `ops_health`:
- `date_utc` — ISO timestamp
- `ran_at_warsaw` — human time in Europe/Warsaw
- `ok` — boolean success
- `raw_rows` — count in `raw_events` (no header)
- `events_rows` — count in `events` (no header)
- `elapsed_ms` — total runtime
- `error` — truncated error text if any

### Triggers UI
- Apps Script → **Triggers** → verify a single **daily** trigger exists (default **07:05 Europe/Warsaw**).

### Reschedule
- Run `removeAllTriggers()` to avoid duplicates.
- Run `setupDailyTrigger(newHour, newMinute)` (e.g., `setupDailyTrigger(7, 5)`).

### Alerts
- On exception (or lock-skip), send email to **`ALERT_EMAIL`** (if set).

### Staleness check (< 24h)
In `ops_health` keep helper cells:

- **H1**: `last_ok`  
- **H2**: =MAX(ARRAYFORMULA(  IF(C2:C=TRUE,    DATEVALUE(LEFT(A2:A,10)) + TIMEVALUE(MID(A2:A,12,8)),  )))
- **I1**: fresh_<24h
- **I2**: =IF((NOW()-H2)*24<24, TRUE, FALSE)

Alternative if column A isn’t recognized as datetime: =MAXIFS(
  ARRAYFORMULA(DATETIMEVALUE(SUBSTITUTE(SUBSTITUTE(A2:A,"Z",""),"T"," "))),
  C2:C, TRUE )
**Expectation**: last ok=TRUE row is <24h old; otherwise check logs and error.

## Verification checklist

- After refresh(): raw_events non-empty; 9-column schema intact.
- After materialize():
    - events row count **equals** raw_events (1:1 transform).
    - ISO timestamps carry the **Europe/Warsaw** offset (e.g., +01:00 in November).
    - Payment normalized to free|paid|unknown (daily runs may be unknown).
    - taxonomy_unmapped grows only when new labels appear; curate via taxonomy_map / taxonomy_alias.
    - Review Hub dedupe_stats; if problematic pairs remain, tune thresholds.
- API doGet:
    - ok=true; each result has date and times.
    - Order: **date ↑ → timed-first → time ↑ → title A→Z**.
    - Weekend window works; filters/pagination behave as documented.

## API checks (doGet)
- Day: /exec?date=YYYY-MM-DD&period=day&limit=3 → ok=true, results[].date, results[].times.
- Weekend: period=weekend covers Sat/Sun around date.
- Filters: payment=free (coverage improves after enrichment), category=kids.
- Pagination: next_offset until the last page.

### Troubleshooting:
- 400 for bad params; 500 logs + email if ALERT_EMAIL set.
- If times missing but event is timed: verify raw_events has (Source, Link, Date) for that event.

## Recovery steps
1) Run refresh() then materialize() manually to restore data.
2) Fix the root cause (adapter error, mapping issue, etc.).
3) If triggers misconfigured: removeAllTriggers() → setupDailyTrigger(...).
4) Confirm staleness helpers (last_ok, fresh_<24h) are green.

## Notes
- All human-readable times are Europe/Warsaw unless stated.
- Apps Script uses batched sheet I/O; no per-row network calls.
- API attaches display times from raw_events; timestamps remain for logic.