-- S2-03 — Telegram bot (MVP) event search query
--
-- Designed for:
--   - n8n Postgres node (query text stored in repo for transparency)
--   - Supabase SQL editor (manual tests)
--
-- Canonical dataset: public.events (one row = one Telegram line)
-- Columns used:
--   event_id (text)
--   date (date)
--   title_display (text)
--   earliest_time (time, nullable)
--   times_text (text, nullable)
--   venue_best (text, nullable)
--   pay_best (text, not null)
--   primary_url (text, nullable)
--   range_days (integer, not null)
--
-- Theme filter uses:
--   public.event_tags(event_id, tag_id)
--   public.tags(tag_id, kind, code, enabled)
--
-- Long-running rule (locked for MVP): range_days >= 21.
-- If lr=0, long-running events are excluded.
--

-- ============================================================================
-- QUERY A (recommended for production)
-- Search by chat_id + page_size, reading filters from public.user_state.
--
-- Inputs:
--   $1 :: text   chat_id
--   $2 :: int    page_size (MVP = 10)
--
-- Output:
--   event_id, date, title_display, times_text, venue_best, primary_url, has_more
--
-- Notes:
--   - has_more is repeated on each row (read it from the first row in n8n).
--   - if there are 0 rows, treat has_more as false.
-- ============================================================================

WITH
state AS (
  SELECT
    us.chat_id,
    us.period,
    us.theme,
    us.pay,
    us.lr,
    us."offset" AS offset_n,
    us.anchor_date
  FROM public.user_state us
  WHERE us.chat_id = $1
  LIMIT 1
),
window AS (
  SELECT
    -- Weekend: upcoming Sat+Sun; if anchor_date is Sunday -> next weekend.
    CASE s.period
      WHEN 'today'    THEN s.anchor_date
      WHEN 'tomorrow' THEN s.anchor_date + 1
      WHEN 'week'     THEN s.anchor_date
      WHEN 'weekend'  THEN s.anchor_date
                       + ((6 - EXTRACT(ISODOW FROM s.anchor_date)::int + 7) % 7)
      ELSE s.anchor_date
    END AS start_date,
    CASE s.period
      WHEN 'today'    THEN s.anchor_date
      WHEN 'tomorrow' THEN s.anchor_date + 1
      WHEN 'week'     THEN s.anchor_date + 6
      WHEN 'weekend'  THEN (s.anchor_date
                       + ((6 - EXTRACT(ISODOW FROM s.anchor_date)::int + 7) % 7)) + 1
      ELSE s.anchor_date
    END AS end_date
  FROM state s
  WHERE s.period IS NOT NULL AND s.anchor_date IS NOT NULL
),
filtered AS (
  SELECT e.*
  FROM public.events e
  CROSS JOIN state s
  CROSS JOIN window w
  WHERE e.date BETWEEN w.start_date AND w.end_date

    -- Payment filter
    AND (s.pay = 'all' OR e.pay_best = s.pay)

    -- Long-running filter
    AND (s.lr = 1 OR e.range_days < 21)

    -- Theme filter (theme tags)
    AND (
      s.theme = 'all'
      OR EXISTS (
        SELECT 1
        FROM public.event_tags et
        JOIN public.tags t
          ON t.tag_id = et.tag_id
        WHERE et.event_id = e.event_id
          AND t.kind = 'theme'
          AND t.code = s.theme
          AND t.enabled IS TRUE
      )
    )
),
ordered_paged AS (
  SELECT
    e.event_id,
    e.date,
    e.title_display,
    e.times_text,
    e.venue_best,
    e.primary_url,
    e.earliest_time
  FROM filtered e
  CROSS JOIN state s
  ORDER BY
    e.date ASC,
    e.earliest_time ASC NULLS LAST,
    e.title_display ASC,
    e.event_id ASC
  OFFSET (SELECT offset_n FROM state)
  LIMIT ($2 + 1)
),
meta AS (
  SELECT (COUNT(*) > $2) AS has_more
  FROM ordered_paged
)
SELECT
  op.event_id,
  op.date,
  op.title_display,
  op.times_text,
  op.venue_best,
  op.primary_url,
  (SELECT has_more FROM meta) AS has_more
FROM ordered_paged op
ORDER BY
  op.date ASC,
  op.earliest_time ASC NULLS LAST,
  op.title_display ASC,
  op.event_id ASC
LIMIT $2;


-- ============================================================================
-- QUERY B (manual testing helper)
-- Same logic, but the parameters are specified inside the SQL in a params CTE.
-- Edit the params values and run the whole block in Supabase SQL editor.
-- ============================================================================

WITH
params AS (
  SELECT
    '2026-01-16'::date    AS anchor_date,
    'week'::text         AS period,     -- today|tomorrow|weekend|week
    'all'::text          AS theme,      -- all|teatr|film|koncert|spotkanie|warsztat|wystawa|wycieczka|sport|inne
    'all'::text          AS pay,        -- all|free|paid|unknown
    0::smallint          AS lr,         -- 0|1
    0::int               AS offset_n,
    10::int              AS page_size
),
window AS (
  SELECT
    CASE p.period
      WHEN 'today'    THEN p.anchor_date
      WHEN 'tomorrow' THEN p.anchor_date + 1
      WHEN 'week'     THEN p.anchor_date
      WHEN 'weekend'  THEN p.anchor_date
                       + ((6 - EXTRACT(ISODOW FROM p.anchor_date)::int + 7) % 7)
      ELSE p.anchor_date
    END AS start_date,
    CASE p.period
      WHEN 'today'    THEN p.anchor_date
      WHEN 'tomorrow' THEN p.anchor_date + 1
      WHEN 'week'     THEN p.anchor_date + 6
      WHEN 'weekend'  THEN (p.anchor_date
                       + ((6 - EXTRACT(ISODOW FROM p.anchor_date)::int + 7) % 7)) + 1
      ELSE p.anchor_date
    END AS end_date
  FROM params p
),
filtered AS (
  SELECT e.*
  FROM public.events e
  CROSS JOIN params p
  CROSS JOIN window w
  WHERE e.date BETWEEN w.start_date AND w.end_date

    AND (p.pay = 'all' OR e.pay_best = p.pay)
    AND (p.lr = 1 OR e.range_days < 21)

    AND (
      p.theme = 'all'
      OR EXISTS (
        SELECT 1
        FROM public.event_tags et
        JOIN public.tags t
          ON t.tag_id = et.tag_id
        WHERE et.event_id = e.event_id
          AND t.kind = 'theme'
          AND t.code = p.theme
          AND t.enabled IS TRUE
      )
    )
),
ordered_paged AS (
  SELECT
    e.event_id,
    e.date,
    e.title_display,
    e.times_text,
    e.venue_best,
    e.primary_url,
    e.earliest_time
  FROM filtered e
  CROSS JOIN params p
  ORDER BY
    e.date ASC,
    e.earliest_time ASC NULLS LAST,
    e.title_display ASC,
    e.event_id ASC
  OFFSET (SELECT offset_n FROM params)
  LIMIT ((SELECT page_size FROM params) + 1)
),
meta AS (
  SELECT (COUNT(*) > (SELECT page_size FROM params)) AS has_more
  FROM ordered_paged
)
SELECT
  op.event_id,
  op.date,
  op.title_display,
  op.times_text,
  op.venue_best,
  op.primary_url,
  (SELECT has_more FROM meta) AS has_more
FROM ordered_paged op
ORDER BY
  op.date ASC,
  op.earliest_time ASC NULLS LAST,
  op.title_display ASC,
  op.event_id ASC
LIMIT (SELECT page_size FROM params);
