-- db/migrations/2026-01-07_s2_01a_canonical.sql
-- S2-01A: Canonical events + multi-source listings + taxonomy foundation
--
-- This migration:
-- 1) Renames Stage 1 tables: public.events/showtimes -> public.s1_events/s1_showtimes
--    (and renames conflicting constraints so we can recreate public.events)
-- 2) Aligns public.sources column name (label -> name) for Stage 2 docs/ERD
-- 3) Creates Stage 2 tables per S2-01A ERD
-- 4) Adds key constraints + indexes

BEGIN;

SET LOCAL lock_timeout = '10s';
SET LOCAL statement_timeout = '5min';
SET LOCAL search_path = public;

-- ---------------------------------------------------------------------
-- 1) Preserve Stage 1 tables (rename to s1_*) + fix constraint name conflicts
-- ---------------------------------------------------------------------

-- Rename child first (it has FK to events)
ALTER TABLE public.showtimes RENAME TO s1_showtimes;
ALTER TABLE public.events   RENAME TO s1_events;

-- Rename Stage 1 constraints that would conflict with new public.events PK/UK names
ALTER TABLE public.s1_events
  RENAME CONSTRAINT events_pkey TO s1_events_pkey;

ALTER TABLE public.s1_events
  RENAME CONSTRAINT events_uq_source_url TO s1_events_uq_source_url;

ALTER TABLE public.s1_showtimes
  RENAME CONSTRAINT showtimes_pkey TO s1_showtimes_pkey;

ALTER TABLE public.s1_showtimes
  RENAME CONSTRAINT showtimes_uq_event_date_time_venue TO s1_showtimes_uq_event_date_time_venue;

-- Optional: rename the check constraint for clarity (no conflicts expected, but consistent naming)
ALTER TABLE public.s1_showtimes
  RENAME CONSTRAINT showtimes_end_ge_start TO s1_showtimes_end_ge_start;

-- ---------------------------------------------------------------------
-- 2) sources table alignment (Stage 2 expects "name")
--    Keep url/enabled columns (extra fields are fine).
-- ---------------------------------------------------------------------
DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM information_schema.columns
    WHERE table_schema='public' AND table_name='sources' AND column_name='label'
  ) THEN
    ALTER TABLE public.sources RENAME COLUMN label TO name;
  END IF;
END$$;

-- Ensure sources has PK (should already)
-- (No-op if already present; if missing, uncomment)
-- ALTER TABLE public.sources ADD CONSTRAINT sources_pkey PRIMARY KEY (source_id);

-- ---------------------------------------------------------------------
-- 3) Stage 2 tables (create in dependency order)
-- ---------------------------------------------------------------------

-- 3.1 Canonical events (what Telegram prints as 1 line)
CREATE TABLE public.events (
  event_id        text PRIMARY KEY,
  date            date NOT NULL,
  title_display   text NOT NULL,
  title_norm      text NOT NULL,
  earliest_time   time NULL,
  times_text      text NULL,
  venue_best      text NULL,
  pay_best        text NOT NULL DEFAULT 'unknown',
  primary_source  text NOT NULL REFERENCES public.sources(source_id),
  primary_url     text NULL,
  merge_key       text NOT NULL,
  updated_at      timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT events_uq_merge_key UNIQUE (merge_key)
);

CREATE INDEX events_date_idx ON public.events(date);

-- 3.2 Per-source listings (traceability)
CREATE TABLE public.event_listings (
  listing_id  text PRIMARY KEY,
  event_id    text NOT NULL REFERENCES public.events(event_id) ON DELETE CASCADE,
  source      text NOT NULL REFERENCES public.sources(source_id),
  url         text NOT NULL,
  title_raw   text NULL,
  venue_raw   text NULL,
  pay_raw     text NULL,
  times_raw   text NULL,
  updated_at  timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT event_listings_uq_source_url UNIQUE (source, url)
);

CREATE INDEX event_listings_event_id_idx ON public.event_listings(event_id);
CREATE INDEX event_listings_source_idx   ON public.event_listings(source);

-- 3.3 Listing categories (multi-label + missing category sentinel)
-- Convenience choice: store source here (must match event_listings.source by convention).
CREATE TABLE public.event_listing_categories (
  listing_id text NOT NULL REFERENCES public.event_listings(listing_id) ON DELETE CASCADE,
  raw_value  text NOT NULL,
  source     text NOT NULL REFERENCES public.sources(source_id),
  PRIMARY KEY (listing_id, raw_value)
);

CREATE INDEX event_listing_categories_source_raw_idx
  ON public.event_listing_categories (source, raw_value);

-- 3.4 Canonical showtimes (times per canonical event)
CREATE TABLE public.event_showtimes (
  showtime_id text PRIMARY KEY,
  event_id    text NOT NULL REFERENCES public.events(event_id) ON DELETE CASCADE,
  date        date NOT NULL,
  time        time NULL,
  CONSTRAINT event_showtimes_uq_event_date_time UNIQUE NULLS NOT DISTINCT (event_id, date, time)
);

CREATE INDEX event_showtimes_event_id_date_idx ON public.event_showtimes(event_id, date);

-- 3.5 Taxonomy: canonical tags + mapping + backlog + assignments
CREATE TABLE public.tags (
  tag_id    text PRIMARY KEY,
  kind      text NOT NULL,      -- e.g. 'theme'
  code      text NOT NULL,      -- e.g. 'koncert'
  label_pl  text NOT NULL,      -- e.g. 'Koncert'
  enabled   boolean NOT NULL DEFAULT true,
  CONSTRAINT tags_uq_kind_code UNIQUE (kind, code)
);

CREATE TABLE public.event_tags (
  event_id text NOT NULL REFERENCES public.events(event_id) ON DELETE CASCADE,
  tag_id   text NOT NULL REFERENCES public.tags(tag_id) ON DELETE RESTRICT,
  PRIMARY KEY (event_id, tag_id)
);

CREATE INDEX event_tags_tag_id_idx ON public.event_tags(tag_id);

CREATE TABLE public.tag_alias (
  source    text NOT NULL REFERENCES public.sources(source_id),
  raw_value text NOT NULL,
  tag_id    text NOT NULL REFERENCES public.tags(tag_id) ON DELETE RESTRICT,
  enabled   boolean NOT NULL DEFAULT true,
  PRIMARY KEY (source, raw_value)
);

CREATE INDEX tag_alias_tag_id_idx ON public.tag_alias(tag_id);

CREATE TABLE public.tag_unmapped (
  source     text NOT NULL REFERENCES public.sources(source_id),
  raw_value  text NOT NULL,
  seen_at    timestamptz NOT NULL DEFAULT now(),
  sample_url text NULL,
  count_seen int NOT NULL DEFAULT 1,
  PRIMARY KEY (source, raw_value)
);

COMMIT;
