# LEHv2 Hub → DB Mapping (Stage 1)

Stage: **Stage 1 – Data backbone (Hub → PostgreSQL)**  
Goal: define how Hub JSON (`sheet=0`, `group_times=1`) is mapped into the Stage 1 DB schema:

- `public.events`
- `public.showtimes`
- `public.sources`

User state (`public.user_state`) is not populated from Hub and is out of scope here.

Reference DB schema:  
`docs/lehv2/LEHv2_DB_schema_S1.md`  
Reference SQL:  
`db/schema_stage1.sql`

---

## 1. Hub call used for ingestion

Stage 1 ingestion (WF-INGEST) calls the Hub Worker in **JSON mode** with:

- `sheet=0` (JSON, not sheets)
- `group_times=1` (aggregate showtimes by event)
- 7-day horizon starting at `date=today`

Canonical example URL (for tests):

GET https://<HUB_WORKER_URL>/
    ?date=2025-12-06
    &period=week
    &days=7
    &sheet=0
    &group_times=1
    &pages=3
    &limit=1000
    &include_in_progress=1

The exact date and horizon can change, but **WF-INGEST must always use**:

- `sheet=0`
- `group_times=1`

The Hub response has a top-level structure similar to:

{
  "date": "2025-12-06",
  "period": "week",
  "days": 7,
  "count": 123,
  "events": [
    {
      "Title": "Kino Bajka: ...",
      "Date": "2025-12-10",
      "Time": "09:30, 11:00",
      "Venue": "Kino Bajka",
      "Category": "Film",
      "Link": "https://zoom.lublin.pl/...",
      "Payment for Entry": "No",
      "Source": "zoom.lublin.pl",
      "_EndDate": "2025-12-10",

      "_via": ["zoom.lublin.pl"],
      "_fp_url": "/wydarzenie/...",
      "_norm_title": { },
      "_slug_tokens": { },
      "Sources": "zoom.lublin.pl"
    }
  ],
  "per_source": [],
  "dedupe_stats": { }
}

For Stage 1 DB mapping we only use these **event-level fields**:

- `Title`
- `Date`
- `Time`
- `_EndDate`
- `Venue`
- `Category`
- `Link`
- `"Payment for Entry"`
- `Source`

Internal helper fields like `_via`, `_fp_url`, `_norm_title`, `_slug_tokens`, `Sources`, and envelope fields like `per_source`, `dedupe_stats` are ignored.

---

## 2. Identifier and source mapping

### 2.1 Source codes (`public.sources` and `events.source`)

Each Hub `Source` (domain) maps to a short code used in the DB:

| Hub `Source` value     | `sources.source_id` (code) | Example `label`      | Example `url`                 |
|------------------------|----------------------------|----------------------|-------------------------------|
| "zoom.lublin.pl"       | 'zoom'                    | Zoom Lublin          | https://zoom.lublin.pl       |
| "lublin.eu"            | 'official'                | Lublin.eu – kultura  | https://lublin.eu/kultura/   |
| (future sources…)      | e.g. 'fb'                 | …                    | …                             |

`public.sources` is **not** filled from Hub; rows are inserted once per source, manually or via a small bootstrap script, before WF-INGEST starts.

In `public.events`:

- `events.source` stores the **code** ('zoom', 'official'), not the full domain.
- `events.source` has a FK to `sources.source_id`.

### 2.2 Event identifiers

For each Hub event, the ingestion workflow computes:

- `events.event_id` – stable text ID, same semantics as LEHv1 (`event_id` in the Google Sheets / Apps Script version).
- `events` has:
  - `PRIMARY KEY (event_id)`
  - `UNIQUE (source, url)`

This means:

- `event_id` is the **primary key** used to join with `showtimes`.
- `(source, url)` is the **source-local identity**:
  - If the same source tries to insert an event with the same URL twice, Postgres will reject the duplicate.

No separate `source_event_id` column is used in Stage 1.

---

## 3. Field mapping: Hub → DB

### 3.1 events

For each element `e` in `response.events`:

| Hub field | DB table | Column        | Transform / rule                                                                 |
|-----------|----------|---------------|----------------------------------------------------------------------------------|
| `Title`   | `events` | `title`       | Trim whitespace; store as-is (source language).                                 |
| `Source`  | `events` | `source`      | Map domain to code: "zoom.lublin.pl" → 'zoom'; "lublin.eu" → 'official'.        |
| `Link`    | `events` | `url`         | Trim; store exact URL.                                                          |
| `Category`| `events` | `category_raw`| Trim; store raw category string; may be empty or missing → NULL.                |

Derived field:

| Derived   | DB table | Column    | How defined                                                                 |
|-----------|----------|-----------|-----------------------------------------------------------------------------|
| `event_id`| `events` | `event_id`| Computed in WF-INGEST, using the same recipe as LEHv1 (Apps Script).       |

Insert/upsert logic (conceptual):

1. Compute `source_code` from `e.Source`.
2. Ensure a row exists in `public.sources` for `source_code`.
3. Compute `event_id` from Hub event `e`.
4. Upsert into `public.events`:

   - `event_id`
   - `title`
   - `source` (code)
   - `url`
   - `category_raw`

Collision rules are determined by the upsert strategy, but DB constraints guarantee:

- Only one row per `event_id`.
- Only one row per `(source, url)`.

### 3.2 showtimes

The Hub event fields used for showtimes are:

- `Date` (string YYYY-MM-DD)
- `Time` (string: empty or "HH:MM" or "HH:MM, HH:MM, ..." with commas)
- `_EndDate` (string YYYY-MM-DD, may equal `Date` or be later)
- `Venue`
- `"Payment for Entry"`

The DB wants **one row per `(event_id, date, time, venue)`** in `public.showtimes`:

- `showtime_id bigserial PRIMARY KEY`
- `event_id text NOT NULL`
- `date date NOT NULL`
- `time time NULL`
- `_end_date date NOT NULL`
- `venue text NULL`
- `payment text NOT NULL DEFAULT 'unknown'`
- `UNIQUE (event_id, date, time, venue)`

#### 3.2.1 Common transforms

For each event `e`:

- `date`:
  - Parse `e.Date` (string) → `date`.
- `_end_date`:
  - If `_EndDate` present and non-empty: parse `e._EndDate` → `date`.
  - Else: `_end_date = date`.
- `venue`:
  - Trim `e.Venue`.
  - If empty string → NULL.
- `payment`:
  - Map from `"Payment for Entry"` (see section 4).

#### 3.2.2 Multi-showtime logic (splitting `Time`)

Case A – event with times (normal showtimes)

- Condition: `e.Time` is non-empty after trimming.
- Steps:

  1. Split `e.Time` on comma:

     - `rawTimes = e.Time.split(",")`
     - `times = rawTimes.map(trim).filter(isValidHHMM)`

  2. For each `t` in `times`, insert one row into `public.showtimes`:

     - `event_id = <computed event_id for e>`
     - `date = parsed e.Date`
     - `time = parse t as time (HH:MM)`
     - `_end_date = date` (single-day showtime)
     - `venue = parsed venue`
     - `payment = mapped payment`

Case B – multi-day all-day ranges (no time)

- Condition: `Time` is empty AND `_EndDate > Date`.
- Insert **one** row:

  - `event_id = <event_id>`
  - `date = parsed Date`
  - `time = NULL`
  - `_end_date = parsed _EndDate`
  - `venue` / `payment` as above.

Case C – single-day no-time events

- Condition: `Time` is empty AND `_EndDate == Date` (or `_EndDate` missing).
- Insert **one** row:

  - `event_id = <event_id>`
  - `date = parsed Date`
  - `time = NULL`
  - `_end_date = date`
  - `venue` / `payment` as above.

Because `UNIQUE (event_id, date, time, venue)` is enforced in the DB, if the Hub ever returns an exact duplicate showtime for the same event, the insert will fail (and WF-INGEST can either ignore the conflict or handle it explicitly).

### 3.3 sources

`public.sources` is a small lookup table with:

- `source_id text PRIMARY KEY`
- `label text NOT NULL`
- `url text NOT NULL`
- `enabled boolean NOT NULL DEFAULT true`

It is **not populated from Hub**. Instead:

- Rows are created once per source, e.g.:

insert into public.sources (source_id, label, url)
values
  ('zoom',     'Zoom Lublin',        'https://zoom.lublin.pl'),
  ('official', 'Lublin.eu – kultura','https://lublin.eu/kultura/');

WF-INGEST then:

- Uses `events.source` to reference `sources.source_id`.
- Does not change `sources` during normal runs.

---

## 4. Payment mapping

Hub `"Payment for Entry"` field is a string:

- "Yes"
- "No"
- "" (empty) or missing

`public.showtimes.payment` is normalized:

- 'free'
- 'paid'
- 'unknown' (default)

Mapping rules:

| Hub `"Payment for Entry"` | `showtimes.payment` |
|---------------------------|---------------------|
| "Yes"                     | 'paid'              |
| "No"                      | 'free'              |
| "" or missing             | 'unknown'           |

Notes:

- `payment` in DB is **never NULL** (column is `NOT NULL DEFAULT 'unknown'`).
- WF-INGEST always writes one of the three values above.

---

## 5. Retention and lifecycle (how mapping fits into Stage 1 rules)

Stage 1 retention rules (implemented in WF-INGEST, not in DB):

- Let `today` be the date on the Hub call.
- We keep showtimes where the date range intersects `[today, today + 6]`:

  - Keep if: `date <= today + 6` AND `_end_date >= today`.
  - Delete or archive if:
    - the event is fully past: `_end_date < today`, or
    - the event starts after the window: `date > today + 6`.

Workflow sketch:

1. Call Hub with `date=today`, `days=7`, `sheet=0`, `group_times=1`.
2. Compute the keep window `[today, today+6]`.
3. Optionally prune `showtimes` outside the window (based on `date` and `_end_date`).
4. For each Hub event:
   - Upsert into `events`.
   - Insert/update `showtimes` based on the mapping rules.
5. Optionally clean up `events` that no longer have any `showtimes` in the window.

Retention logic uses `date` + `_end_date` from the mapping above, so multi-day events that **started earlier** (`date < today`) but are still running (`_end_date >= today`) stay visible.

---

## 6. Out of scope / future extensions

Not covered in this Stage 1 mapping:

- Canonical taxonomy (categories, audience, activity type) and their mapping from `category_raw` + title.
- Additional enrichment such as languages, ticket links, tags.
- History tables or longer-term analytics.
- Any direct mapping to `user_state` (bot state is managed separately by Stage 2 workflows).

Stage 1 focuses on:

1. A reliable, well-defined mapping from Hub JSON to `events` + `showtimes` + `sources`.
2. A DB snapshot that is always consistent with what Hub would show for the next 7 days.

## 7. Appendix: Example mapping

### 7.1 Example 1 – single-day event with two showtimes

**Hub event (as returned in `events[]`):**

{
  "Title": "Kino Bajka: Super pies i kot łotr",
  "Date": "2025-12-10",
  "Time": "09:30, 11:00",
  "Venue": "Kino Bajka",
  "Category": "Film",
  "Link": "https://zoom.lublin.pl/wydarzenie/super-pies-i-kot-lotr/",
  "Payment for Entry": "No",
  "Source": "zoom.lublin.pl",
  "_EndDate": "2025-12-10"
}

For illustration, assume WF-INGEST computes:

- `event_id = 'ex_1'`
- `Source "zoom.lublin.pl"` → code `'zoom'`

**Row in `public.events`:**

| column       | value                                                            |
|-------------|------------------------------------------------------------------|
| event_id    | ex_1                                                             |
| title       | Kino Bajka: Super pies i kot łotr                                |
| source      | zoom                                                             |
| url         | https://zoom.lublin.pl/wydarzenie/super-pies-i-kot-lotr/        |
| category_raw| Film                                                             |

**Rows in `public.showtimes`:**

`Time` is `"09:30, 11:00"`, so WF-INGEST splits it into two times: `["09:30", "11:00"]`.

| showtime_id | event_id | date       | time     | _end_date  | venue      | payment |
|-------------|----------|-----------|----------|------------|-----------|---------|
| (auto)      | ex_1     | 2025-12-10| 09:30:00 | 2025-12-10 | Kino Bajka| free    |
| (auto)      | ex_1     | 2025-12-10| 11:00:00 | 2025-12-10 | Kino Bajka| free    |

Notes:

- `Payment for Entry = "No"` → `payment = 'free'`.
- `_EndDate = "2025-12-10"` equals `Date`, so `_end_date = date`.
- `showtime_id` values are generated by PostgreSQL (bigserial).

---

### 7.2 Example 2 – multi-day exhibition without time

**Hub event (as returned in `events[]`):**

{
  "Title": "Wystawa: Tajemnice Wzgórza Zamkowego",
  "Date": "2025-12-01",
  "Time": "",
  "Venue": "Muzeum Lubelskie",
  "Category": "Wystawa",
  "Link": "https://lublin.eu/kultura/wydarzenia/tajemnice-wzgorza-zamkowego,12345,w.html",
  "Payment for Entry": "Yes",
  "Source": "lublin.eu",
  "_EndDate": "2025-12-20"
}

Assume:

- `event_id = 'ex_2'`
- `Source "lublin.eu"` → code `'official'`

**Row in `public.events`:**

| column       | value                                                                 |
|-------------|-----------------------------------------------------------------------|
| event_id    | ex_2                                                                  |
| title       | Wystawa: Tajemnice Wzgórza Zamkowego                                  |
| source      | official                                                              |
| url         | https://lublin.eu/kultura/wydarzenia/tajemnice-wzgorza-zamkowego,12345,w.html |
| category_raw| Wystawa                                                               |

**Row in `public.showtimes`:**

`Time` is empty, `_EndDate > Date`, so WF-INGEST treats it as a multi-day, no-time event.

| showtime_id | event_id | date       | time | _end_date  | venue            | payment |
|-------------|----------|-----------|------|------------|------------------|---------|
| (auto)      | ex_2     | 2025-12-01| NULL | 2025-12-20 | Muzeum Lubelskie | paid    |

Notes:

- `Payment for Entry = "Yes"` → `payment = 'paid'`.
- `time` is `NULL` because Hub provided no time.
- If `today = 2025-12-06` and horizon is 7 days (`[2025-12-06, 2025-12-12]`), this row is kept because `_end_date (2025-12-20) >= today (2025-12-06)` and `date (2025-12-01) <= today + 6 (2025-12-12)`.
