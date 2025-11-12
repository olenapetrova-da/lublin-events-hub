# Lublin Events Hub

A low-ops pipeline that collects events from multiple public sources, normalizes them in Google Sheets, and serves a simple JSON API for bots and apps.

- **Data sources:** zoom.lublin.pl, lublin.eu (Official)
- **Storage:** Google Sheets (staging `raw_events` → normalized `events`)
- **Compute:** Google Apps Script (refresh, materialize, API)
- **Orchestration:** optional CF Workers adapters + Hub for crawling/merge/dedupe
- **API:** Apps Script Web App `doGet` — returns `DATE — TITLE — TIMES — …`

Current release: **v0.3.0-rc.3**

---

## Quick start

1) **Google Sheet**
- Tabs required:
  - `raw_events` (staging; 9 cols): `Title | Date | Time | Venue | Category | Link | Payment for Entry | Source | _EndDate`
  - `events` (normalized; 9 cols): `event_id | title | start_dt | end_dt | venue | payment | categories | source | url`
  - `taxonomy_map` (source mapping), `taxonomy_alias` (input aliases), `taxonomy_unmapped` (log)

2) **Apps Script (Code)**
- `apps_script/Lublin_events_DB_AppScript/refresh.js` — calls the Hub (JSON mode), writes **raw_events**
- `apps_script/Lublin_events_DB_AppScript/materialize.js` — transforms **raw_events → events**
- `apps_script/Lublin_events_DB_AppScript/api_doGet.js` — HTTP API (`doGet`) that reads **events** and joins `times` from **raw_events**

3) **Script Properties**
- `SHEET_ID` (spreadsheet ID)
- `TZ` = `Europe/Warsaw`
- `ALERT_EMAIL` (optional; exceptions from API are emailed here)

4) **Deploy the API**
- Deploy Apps Script as **Web App** (execute as you; accessible to anyone with the link)
- Keep the `/exec` URL for bots/Make

---

## Query API

**GET**  
`<WEB_APP_URL>/exec?date=YYYY-MM-DD&period=day|week|weekend|range&payment=any|free|paid|unknown&category=kids,music&source=zoom.lublin.pl&limit=20&offset=0`

**Response**
```json
{
  "ok": true,
  "start": "YYYY-MM-DD",
  "end": "YYYY-MM-DD",
  "total": 42,
  "limit": 20,
  "offset": 0,
  "next_offset": 20,
  "results": [{
    "date": "YYYY-MM-DD",
    "title": "…",
    "times": "09:30, 11:30",
    "payment": "free|paid|unknown",
    "categories": "kids|music",
    "venue": "…",
    "source": "zoom.lublin.pl",
    "url": "https://…",

    "event_id": "…",
    "start_dt": "YYYY-MM-DDTHH:MM:SS+01:00",
    "end_dt":   "YYYY-MM-DDTHH:MM:SS+01:00"
  }]
}
```

- **Display fields**: date, title, times, payment, categories, venue, url, source.
- **Tech fields**: event_id, start_dt, end_dt (for stable IDs and overlap/sorting checks).
- **Sorting** (API order): date asc → timed first → earliest time asc → title asc (Polish locale).
- **Payment coverage** grows after enrichment jobs (see below).
- **CORS** is open. Errors are JSON: 400 (bad input) / 500 (exception; emailed to ALERT_EMAIL if set).

More detail: docs/specs/query-api.md.

## Data flow
- **Adapters** (CF Workers) parse lists (and optionally details) from sources.
- **Hub** (CF Worker) merges, dedupes cross-source (fallback dedupe when Official lacks Venue), and emits JSON for Apps Script.
- **Apps Script** 
    - refresh() → calls the Hub for a 7-day window (sheet=0&group_times=1), writes raw_events (9 cols).
    - materialize() → builds events (9 cols) with DST-correct ISO timestamps, payment/category mapping, and stable event_id.
    - doGet() → serves JSON from events, attaching display times from **raw_events`.

**Architecture & runbook**:
- docs/architecture/overview-minimal-make-ops.md
- docs/runbooks/refresh-runbook.md

## Columns
**Staging** — raw_events (9 cols)
- Title, Date (YYYY-MM-DD), Time (comma string), Venue, Category (raw), Link, Payment for Entry (Yes/No/""), Source, _EndDate (YYYY-MM-DD)
**Normalized** — events (9 cols)
- event_id, title, start_dt, end_dt, venue, payment (free|paid|unknown), categories (pipe-joined canonicals), source, url

**Transform rules**: docs/adr/ADR-0005-data-model-raw-to-normalized.md
**Materialize spec**: docs/specs/materialize.md

## Automations
- **Daily**: refresh() → materialize() (Apps Script time trigger).
- **Weekly / On-demand enrichment**:
    - E-Z1 (Zoom): run Hub with enrich=1&enrich_max=25; patch Payment (and missing Time/Venue) into raw_events; re-materialize.
    - E-O1 (Official): same as above for lublin.eu.
    - Payment mapping is performed in materialize(); acquisition happens in enrichment runs.

Tasks live in Notion backlog; see also ADRs below.

## ADRs (selected)
- ADR-0005 — Data model: raw → normalized
- ADR-0006 — Enrichment location & limits
- ADR-0007 — Payment value at adapter output
- ADR-0008 — What enrichment can fill
- ADR-0009 — _EndDate & Source policy
- ADR-0010 — Adapter budget & stop policy
- ADR-0011 — Ordering policy
- ADR-0012 — Cross-source dedupe without Venue
- ADR-0013 — Query API contract

## Dev notes
### Repo layout (excerpt)
apps_script/Lublin_events_DB_AppScript/
  refresh.js
  materialize.js
  api_doGet.js
docs/
  adr/
  specs/
  architecture/
  runbooks/
workers/
  shared/lublin-events-hub.js
  zoom-lublin/
  lublin-eu/
sheets/
  schema/
  samples/

### Conventions
- Timezone: Europe/Warsaw. ISO strings carry correct DST (+01:00/+02:00).
- One batch read/write in Apps Script functions; no per-row network calls.
- API adds times from raw_events for display; start_dt/end_dt are for logic only.
- Dedupe belongs in the Hub; materialize() does not dedupe across sources.

## Testing snippets
- API (day): <WEB_APP_URL>/exec?date=2025-11-12&period=day&limit=5
- API (week, free): <WEB_APP_URL>/exec?date=2025-11-12&period=week&payment=free
- API (weekend, kids+music): <WEB_APP_URL>/exec?date=2025-11-12&period=weekend&category=kids,music
- Explicit range + source: <WEB_APP_URL>/exec?start=2025-11-10&end=2025-11-20&source=zoom.lublin.pl 

## Releases
- Tag pre-releases as vX.Y.Z-rc.N while iterating.
- Summarize user-visible changes in GitHub Releases (API shape, new filters, fixes).
- After doGet and daily automation are stable, cut v0.3.0.

## Support & notes
- Errors: the API returns JSON 400/500; when ALERT_EMAIL is set, exceptions trigger an email.
- Payment may be unknown until enrichment runs; category coverage improves as you curate taxonomy_map/taxonomy_alias.
- For Telegram/Make, the normal path is: parse → 1 HTTP to API → send.