# S2-03 — DB queries for Telegram event search (MVP)

This document defines the **canonical SQL query pattern** used by WF-BOT-TG (Stage 2) to fetch search results for the Telegram bot.

Scope of S2-03:
- selecting canonical events for a given `period`, `theme`, `pay`, `lr`
- deterministic ordering
- pagination using `LIMIT/OFFSET`

Out of scope:
- updating `user_state` (handled in S2-02 / WF-BOT-TG)
- enrichment, full-text search, personalization

---

## Source-of-truth inputs

Telegram payload contract defines the allowed codes:

- `period`: `today | tomorrow | weekend | week`
- `theme`: `all | teatr | film | koncert | spotkanie | warsztat | wystawa | wycieczka | sport | inne`
- `pay`: `all | free | paid | unknown`
- `lr`: `0 | 1`
  - `lr=0` (default): exclude long‑running events (`range_days >= 21`)
  - `lr=1`: include long‑running events

The query reads these values from `public.user_state` for a given `chat_id`.

---

## Tables and columns used (S2 baseline)

Primary dataset (already aggregated, one row = one Telegram line):
- `public.events`
  - `event_id` (text)
  - `date` (date)
  - `title_display` (text)
  - `earliest_time` (time, nullable)
  - `times_text` (text, nullable)
  - `venue_best` (text, nullable)
  - `pay_best` (text, NOT NULL, default `unknown`)
  - `primary_url` (text, nullable)
  - `range_days` (int, NOT NULL)

Theme filter (many-to-many):
- `public.event_tags(event_id, tag_id)`
- `public.tags(tag_id, kind, code, enabled, ...)`
  - theme tags are rows where `kind = 'theme'` and `code` matches `user_state.theme`

State:
- `public.user_state(chat_id, period, theme, pay, lr, offset, anchor_date, ...)`

---

## Date window rules (period → start/end)

The search window is derived from:
- `user_state.period`
- `user_state.anchor_date` (Warsaw local date **frozen** for the current session)

Rules:
- `today`: `[anchor_date, anchor_date]`
- `tomorrow`: `[anchor_date+1, anchor_date+1]`
- `week`: `[anchor_date, anchor_date+6]`
- `weekend`: upcoming Saturday+Sunday relative to `anchor_date`
  - if requested on Sunday, it uses **next** Saturday+Sunday (not the current day)

Important: `anchor_date` must be set whenever `period` is set (enforced by DB constraint).

---

## Filters

Applied to `public.events`:

- Theme
  - if `theme = 'all'`: no filter
  - else: `EXISTS` join to `event_tags → tags` where `tags.kind='theme' AND tags.code=theme AND tags.enabled=true`

- Payment
  - if `pay = 'all'`: no filter
  - else: `events.pay_best = pay`

- Long-running toggle (`lr`)
  - if `lr = 0`: exclude events where `events.range_days >= 21`
  - if `lr = 1`: include all

---

## Ordering

Must match UX contract:

1) `date ASC`
2) `earliest_time ASC NULLS LAST`
3) `title_display ASC`
4) `event_id ASC` (tie-breaker for deterministic pagination)

---

## Pagination and has_more

Pagination is classic `LIMIT/OFFSET`:
- `OFFSET` comes from `user_state.offset`
- `page_size` is 10 in MVP
- “Pokaż więcej” increments `offset` by 10 (handled outside this query)

To compute `has_more` without a separate COUNT:
- overfetch `page_size + 1`
- `has_more = (fetched_rows > page_size)`
- return only the first `page_size` rows

If the query returns **zero rows**, WF-BOT-TG should treat `has_more=false`.

---

## SQL file to use

Use this file:
- `db/queries/s2_03_tg_event_search.sql`

The recommended query (“Query A”) takes only:
- `$1 chat_id`
- `$2 page_size`

### n8n usage pattern

In an n8n Postgres node you can:

1) Load state and update state (S2-02 logic) **before** searching:
   - ensure `user_state.period` + `anchor_date` are set
   - ensure `offset` is already correct for the current request

2) Run the search query with `chat_id` and `page_size`.

If your Postgres node supports bind parameters, map them as:
- `$1 = <chat_id>`
- `$2 = 10`

If it does not, you can inline them carefully (example only — adjust to your actual n8n JSON paths):

```sql
-- Replace CHAT_ID_EXPR with your n8n expression that yields chat id as text.
-- Keep page_size = 10 for MVP.

WITH state AS (
  SELECT * FROM public.user_state WHERE chat_id = '{{ CHAT_ID_EXPR }}' LIMIT 1
)
-- ... then copy the rest of Query A from the SQL file ...
```

---

## Manual acceptance checks (SQL editor)

1) With a user_state row where `period` is NULL → query returns 0 rows.
2) Set `period='week'` and `anchor_date=today` → results fall within `[today, today+6]`.
3) Set `period='weekend'` and `anchor_date` = a Sunday → weekend starts on next Saturday.
4) Set `theme` to a specific code (e.g. `film`) → results only include events tagged with that theme.
5) Set `pay='free'` → results only include `pay_best='free'`.
6) Toggle `lr` from 0 to 1 → long-running events (`range_days>=21`) appear only when `lr=1`.
7) Pagination: increase `offset` by 10 → results shift, ordering remains stable.

