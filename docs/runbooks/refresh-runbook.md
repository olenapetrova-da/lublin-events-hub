# Refresh Runbook

## Daily flow
1) Apps Script `refresh()` calls hub once for a 7-day window (`sheet=0&group_times=1&pages=3&limit=1000`).
2) Write `raw_events` (**9 cols**). If `_EndDate` missing, set `_EndDate = Date`.
3) Run `materialize()` → writes `events`.

---

## Adapter outcomes & operator actions (quick)

- **stopped_reason="budget"** (has_more=true): No action. Next day’s 7-day refresh will pick up remaining pages.
- **stopped_reason="pages"**: Expected when `pages` cap is hit; bump `pages` temporarily only if you need faster catch-up.
- **stopped_reason="error"**: Check `error` field; try `pages=1` to collect near-term events; open a bug in Backlog (Area: Workers) with the snippet.
- **Missing _EndDate**: Expected from some sources; Apps Script defaults `_EndDate = Date` on write.

---
## Logs & telemetry
- Hub/refresh log prints: `include_in_progress` and a compact `per_source` summary (e.g., `zoom:58; lublin:51`).
- Adapters/hub should also populate: `pages_scanned`, `budget_used`, `has_more`, `stopped_reason`.

## Zoom source specifics
- Zoom includes `/w-trakcie/` (ongoing) by default when `include_in_progress=1`; this can increase counts even with the same date window.

## If an adapter hits budget
- The adapter returns partial results with `has_more=true`, `pages_scanned`, `budget_used`, `stopped_reason="budget"`.
- **Action:** None required. Tomorrow’s run covers the same 7-day window again; newly published events and remaining pages are picked up.
- Optional: temporarily bump `pages` for that source if you need faster catch-up.

## If an adapter returns `stopped_reason="error"`
- Check `error` text in the response.
- Quick options:
  - Reduce `pages` to 1 to bypass a broken page and still collect near-term events.
  - Open a bug in backlog `Area: Workers` with the response snippet.
- Apps Script will keep the last successful `events` table; consider a `"stale": true` flag in the API if last refresh > 24h.

## Verification checklist
- After `refresh()`: `raw_events` non-empty; columns match the **9-col** spec.
- After `materialize()`: `events` has valid `start_dt/end_dt`, payment normalized to `free|paid|unknown`.
- `taxonomy_unmapped` grows early; curate via `taxonomy_map`/`taxonomy_alias`.