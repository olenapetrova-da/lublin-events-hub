-- S2-01A patch: support "exclude long-running events" toggle
-- Long-running definition: range_days >= 21 (i.e., end_date - start_date >= 21)

BEGIN;

SET LOCAL lock_timeout = '10s';
SET LOCAL statement_timeout = '10min';
SET LOCAL search_path = public, extensions;

-- 1) Add the new column to canonical events
ALTER TABLE public.events
  ADD COLUMN IF NOT EXISTS range_days int NOT NULL DEFAULT 0;

-- Optional but useful for filtering in S2-03
CREATE INDEX IF NOT EXISTS events_date_range_days_idx
  ON public.events (date, range_days);

-- 2) Patch the canonicalization routine to populate events.range_days
-- NOTE: This replaces the existing 3-arg function but keeps its logic unchanged
-- except for computing/storing range_days.
CREATE OR REPLACE FUNCTION public.s2_01a_apply(p_start date, p_end date, p_prune_outside boolean)
RETURNS jsonb
LANGUAGE plpgsql
AS $$
DECLARE
  v_now timestamptz := now();
  v_events_pruned int := 0;
  v_events_upserted int := 0;
  v_listings_upserted int := 0;
  v_cats_inserted int := 0;
  v_tags_inserted int := 0;
  v_unmapped_upserted int := 0;
  v_showtimes_inserted int := 0;
BEGIN
  IF p_start IS NULL OR p_end IS NULL OR p_start > p_end THEN
    RAISE EXCEPTION 'Invalid window: start=% end=%', p_start, p_end;
  END IF;

  -- Retention: keep ONLY the current horizon in Stage 2
  IF p_prune_outside THEN
    DELETE FROM public.events
    WHERE date < p_start OR date > p_end;
  END IF;

  -- A) Expand Stage1 showtimes into per-day rows in [p_start, p_end]
  CREATE TEMP TABLE tmp_rows ON COMMIT DROP AS
  SELECT
    e.event_id                                  AS s1_event_id,
    e.title                                     AS title_raw,
    public.leh_normalize_title(e.title)         AS title_norm,
    e.source                                    AS source,
    e.url                                       AS url,
    e.category_raw                              AS category_raw,
    st.venue                                    AS venue,
    st.payment                                  AS payment,
    st."time"                                   AS time,
    gs::date                                    AS occ_date,
    (st._end_date - st.date)                    AS range_days_src
  FROM public.s1_events e
  JOIN public.s1_showtimes st
    ON st.event_id = e.event_id
  JOIN LATERAL generate_series(st.date, st._end_date, interval '1 day') gs
    ON true
  WHERE gs::date BETWEEN p_start AND p_end;

  -- B) Build canonical occurrences (1 row = 1 Telegram line)
  CREATE TEMP TABLE tmp_occ ON COMMIT DROP AS
  SELECT
    title_norm,
    occ_date                                   AS date,
    MIN(time) FILTER (WHERE time IS NOT NULL)  AS earliest_time,
    CASE
      WHEN MIN(time) FILTER (WHERE time IS NOT NULL) IS NULL THEN '-'
      ELSE to_char(MIN(time) FILTER (WHERE time IS NOT NULL), 'HH24:MI')
    END                                        AS earliest_time_or_dash,
    COALESCE(
      string_agg(DISTINCT to_char(time,'HH24:MI'), ', ' ORDER BY to_char(time,'HH24:MI'))
        FILTER (WHERE time IS NOT NULL),
      '-'
    )                                          AS times_text,
    MAX(range_days_src)                        AS range_days
  FROM tmp_rows
  GROUP BY title_norm, occ_date;

  ALTER TABLE tmp_occ ADD COLUMN merge_key text;
  UPDATE tmp_occ
    SET merge_key = title_norm || '|' || date::text || '|' || earliest_time_or_dash;

  ALTER TABLE tmp_occ ADD COLUMN event_id text;
  UPDATE tmp_occ
    SET event_id = 'ev:' || public.leh_sha1_hex(merge_key);

  -- C) Build listings per occurrence per (source,url)
  CREATE TEMP TABLE tmp_listings ON COMMIT DROP AS
  SELECT
    o.event_id,
    o.date,
    r.source,
    r.url,
    ('ls:' || public.leh_sha1_hex(r.source || '|' || r.url || '|' || o.event_id)) AS listing_id,
    MAX(r.title_raw)                                                             AS title_raw,
    MAX(r.category_raw)                                                          AS category_raw,
    MAX(r.venue) FILTER (WHERE r.venue IS NOT NULL AND btrim(r.venue) <> '')     AS venue_raw,
    CASE
      WHEN bool_or(r.payment = 'paid') THEN 'paid'
      WHEN bool_or(r.payment = 'free') THEN 'free'
      ELSE 'unknown'
    END                                                                          AS pay_raw,
    COALESCE(
      string_agg(DISTINCT to_char(r.time,'HH24:MI'), ', ' ORDER BY to_char(r.time,'HH24:MI'))
        FILTER (WHERE r.time IS NOT NULL),
      '-'
    )                                                                            AS times_raw
  FROM tmp_rows r
  JOIN tmp_occ o
    ON o.title_norm = r.title_norm AND o.date = r.occ_date
  GROUP BY o.event_id, o.date, r.source, r.url;

  ALTER TABLE tmp_listings ADD COLUMN completeness_score int;
  UPDATE tmp_listings
    SET completeness_score =
      (CASE WHEN venue_raw IS NOT NULL AND btrim(venue_raw) <> '' THEN 1 ELSE 0 END) +
      (CASE WHEN pay_raw <> 'unknown' THEN 1 ELSE 0 END) +
      (CASE WHEN times_raw <> '-' THEN 1 ELSE 0 END);

  -- D) Winner listing per canonical event
  CREATE TEMP TABLE tmp_winner ON COMMIT DROP AS
  SELECT DISTINCT ON (event_id)
    event_id,
    source AS primary_source,
    url    AS primary_url,
    title_raw AS title_display,
    venue_raw AS venue_best,
    pay_raw   AS pay_best
  FROM tmp_listings
  ORDER BY
    event_id,
    completeness_score DESC,
    public.leh_source_priority(source) ASC,
    source ASC,
    url ASC;

  -- E) Prune canonical events inside the window that no longer exist
  DELETE FROM public.events e
  WHERE e.date BETWEEN p_start AND p_end
    AND NOT EXISTS (SELECT 1 FROM tmp_occ o WHERE o.event_id = e.event_id);

  GET DIAGNOSTICS v_events_pruned = ROW_COUNT;

  -- F) Upsert canonical events (now includes range_days)
  INSERT INTO public.events (
    event_id, date, title_display, title_norm,
    earliest_time, times_text, venue_best, pay_best,
    primary_source, primary_url, merge_key, range_days, updated_at
  )
  SELECT
    o.event_id, o.date,
    w.title_display,
    o.title_norm,
    o.earliest_time,
    o.times_text,
    w.venue_best,
    COALESCE(w.pay_best,'unknown'),
    w.primary_source,
    w.primary_url,
    o.merge_key,
    COALESCE(o.range_days, 0),
    v_now
  FROM tmp_occ o
  JOIN tmp_winner w USING (event_id)
  ON CONFLICT (event_id) DO UPDATE SET
    date           = EXCLUDED.date,
    title_display  = EXCLUDED.title_display,
    title_norm     = EXCLUDED.title_norm,
    earliest_time  = EXCLUDED.earliest_time,
    times_text     = EXCLUDED.times_text,
    venue_best     = EXCLUDED.venue_best,
    pay_best       = EXCLUDED.pay_best,
    primary_source = EXCLUDED.primary_source,
    primary_url    = EXCLUDED.primary_url,
    merge_key      = EXCLUDED.merge_key,
    range_days     = EXCLUDED.range_days,
    updated_at     = v_now;

  GET DIAGNOSTICS v_events_upserted = ROW_COUNT;

  -- G) Upsert listings
  INSERT INTO public.event_listings (
    listing_id, event_id, source, url,
    title_raw, venue_raw, pay_raw, times_raw, updated_at
  )
  SELECT
    listing_id, event_id, source, url,
    title_raw, venue_raw, pay_raw, times_raw, v_now
  FROM tmp_listings
  ON CONFLICT (listing_id) DO UPDATE SET
    event_id   = EXCLUDED.event_id,
    source     = EXCLUDED.source,
    url        = EXCLUDED.url,
    title_raw  = EXCLUDED.title_raw,
    venue_raw  = EXCLUDED.venue_raw,
    pay_raw    = EXCLUDED.pay_raw,
    times_raw  = EXCLUDED.times_raw,
    updated_at = v_now;

  GET DIAGNOSTICS v_listings_upserted = ROW_COUNT;

  -- H) Refresh listing categories
  DELETE FROM public.event_listing_categories c
  WHERE EXISTS (SELECT 1 FROM tmp_listings tl WHERE tl.listing_id = c.listing_id);

  CREATE TEMP TABLE tmp_cats ON COMMIT DROP AS
  SELECT
    tl.listing_id,
    tl.source,
    btrim(v) AS raw_value
  FROM tmp_listings tl
  CROSS JOIN LATERAL regexp_split_to_table(
    CASE
      WHEN tl.category_raw IS NULL OR btrim(tl.category_raw) = '' THEN '__MISSING__'
      ELSE tl.category_raw
    END,
    '\\s*[;,|]\\s*'
  ) v
  WHERE btrim(v) <> '';

  INSERT INTO public.event_listing_categories (listing_id, raw_value, source)
  SELECT listing_id, raw_value, source
  FROM tmp_cats
  ON CONFLICT (listing_id, raw_value) DO NOTHING;

  GET DIAGNOSTICS v_cats_inserted = ROW_COUNT;

  -- I) Rebuild event_tags from alias mapping
  DELETE FROM public.event_tags et
  WHERE EXISTS (SELECT 1 FROM tmp_occ o WHERE o.event_id = et.event_id);

  INSERT INTO public.event_tags (event_id, tag_id)
  SELECT DISTINCT
    tl.event_id,
    a.tag_id
  FROM tmp_listings tl
  JOIN tmp_cats c
    ON c.listing_id = tl.listing_id AND c.source = tl.source
  JOIN public.tag_alias a
    ON a.source = c.source AND a.raw_value = c.raw_value AND a.enabled = true
  ON CONFLICT (event_id, tag_id) DO NOTHING;

  GET DIAGNOSTICS v_tags_inserted = ROW_COUNT;

  -- J) Record unmapped raw categories
  INSERT INTO public.tag_unmapped (source, raw_value, seen_at, sample_url, count_seen)
  SELECT
    c.source,
    c.raw_value,
    v_now,
    MIN(tl.url) AS sample_url,
    COUNT(*)    AS count_seen
  FROM tmp_cats c
  JOIN tmp_listings tl ON tl.listing_id = c.listing_id
  LEFT JOIN public.tag_alias a
    ON a.source = c.source AND a.raw_value = c.raw_value AND a.enabled = true
  WHERE a.raw_value IS NULL
  GROUP BY c.source, c.raw_value
  ON CONFLICT (source, raw_value) DO UPDATE SET
    seen_at    = EXCLUDED.seen_at,
    sample_url = COALESCE(public.tag_unmapped.sample_url, EXCLUDED.sample_url),
    count_seen = public.tag_unmapped.count_seen + EXCLUDED.count_seen;

  GET DIAGNOSTICS v_unmapped_upserted = ROW_COUNT;

  -- K) Rebuild canonical showtimes
  DELETE FROM public.event_showtimes st
  WHERE EXISTS (SELECT 1 FROM tmp_occ o WHERE o.event_id = st.event_id);

  INSERT INTO public.event_showtimes (showtime_id, event_id, date, time)
  SELECT
    'st:' || public.leh_sha1_hex(o.event_id || '|' || o.date::text || '|' || COALESCE(to_char(r.time,'HH24:MI'), '-')) AS showtime_id,
    o.event_id,
    o.date,
    r.time
  FROM tmp_rows r
  JOIN tmp_occ o
    ON o.title_norm = r.title_norm AND o.date = r.occ_date
  GROUP BY o.event_id, o.date, r.time;

  GET DIAGNOSTICS v_showtimes_inserted = ROW_COUNT;

  RETURN jsonb_build_object(
    'window_start', p_start,
    'window_end', p_end,
    'prune_outside', p_prune_outside,
    'events_pruned', v_events_pruned,
    'events_upserted', v_events_upserted,
    'listings_upserted', v_listings_upserted,
    'listing_categories_inserted', v_cats_inserted,
    'event_tags_inserted', v_tags_inserted,
    'tag_unmapped_upserted', v_unmapped_upserted,
    'showtimes_inserted', v_showtimes_inserted
  );
END;
$$;

-- keep the 2-arg wrapper as-is (prunes outside window automatically)
CREATE OR REPLACE FUNCTION public.s2_01a_apply(p_start date, p_end date)
RETURNS jsonb
LANGUAGE sql
AS $$
  SELECT public.s2_01a_apply($1, $2, true);
$$;

COMMIT;
