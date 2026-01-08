-- Starter raw->theme mappings per source.
-- Idempotent: safe to re-run.
-- Note: '__MISSING__' is intentionally NOT mapped (it must land in tag_unmapped).

BEGIN;

-- Ensure sources exist (adjust names if you already have different ones)
INSERT INTO public.sources (source_id, name)
VALUES
  ('official', 'lublin.eu'),
  ('zoom',     'zoom.lublin.pl')
ON CONFLICT (source_id) DO UPDATE
SET name = EXCLUDED.name;

-- Helper: insert mappings for both sources (official + zoom)
-- We store a few common variants; add more when you see tag_unmapped fill up.

INSERT INTO public.tag_alias (source, raw_value, tag_id, enabled)
VALUES
  -- TEATR
  ('official','teatr','theme:teatr',true),
  ('official','Teatr','theme:teatr',true),
  ('zoom','teatr','theme:teatr',true),
  ('zoom','Teatr','theme:teatr',true),

  -- FILM
  ('official','film','theme:film',true),
  ('official','Film','theme:film',true),
  ('official','kino','theme:film',true),
  ('official','Kino','theme:film',true),
  ('zoom','film','theme:film',true),
  ('zoom','Film','theme:film',true),
  ('zoom','kino','theme:film',true),
  ('zoom','Kino','theme:film',true),

  -- KONCERT (music bucket) — also map 'muzyka' and 'taniec'
  ('official','koncert','theme:koncert',true),
  ('official','Koncert','theme:koncert',true),
  ('official','muzyka','theme:koncert',true),
  ('official','Muzyka','theme:koncert',true),
  ('official','taniec','theme:koncert',true),
  ('official','Taniec','theme:koncert',true),
  ('zoom','koncert','theme:koncert',true),
  ('zoom','Koncert','theme:koncert',true),
  ('zoom','muzyka','theme:koncert',true),
  ('zoom','Muzyka','theme:koncert',true),
  ('zoom','taniec','theme:koncert',true),
  ('zoom','Taniec','theme:koncert',true),

  -- SPOTKANIE
  ('official','spotkanie','theme:spotkanie',true),
  ('official','Spotkanie','theme:spotkanie',true),
  ('zoom','spotkanie','theme:spotkanie',true),
  ('zoom','Spotkanie','theme:spotkanie',true),

  -- WARSZTAT
  ('official','warsztat','theme:warsztat',true),
  ('official','Warsztat','theme:warsztat',true),
  ('official','warsztaty','theme:warsztat',true),
  ('official','Warsztaty','theme:warsztat',true),
  ('zoom','warsztat','theme:warsztat',true),
  ('zoom','Warsztat','theme:warsztat',true),
  ('zoom','warsztaty','theme:warsztat',true),
  ('zoom','Warsztaty','theme:warsztat',true),

  -- WYSTAWA
  ('official','wystawa','theme:wystawa',true),
  ('official','Wystawa','theme:wystawa',true),
  ('zoom','wystawa','theme:wystawa',true),
  ('zoom','Wystawa','theme:wystawa',true),

  -- WYCIECZKA
  ('official','wycieczka','theme:wycieczka',true),
  ('official','Wycieczka','theme:wycieczka',true),
  ('zoom','wycieczka','theme:wycieczka',true),
  ('zoom','Wycieczka','theme:wycieczka',true),

  -- SPORT
  ('official','sport','theme:sport',true),
  ('official','Sport','theme:sport',true),
  ('zoom','sport','theme:sport',true),
  ('zoom','Sport','theme:sport',true),

  -- INNE
  ('official','inne','theme:inne',true),
  ('official','Inne','theme:inne',true),
  ('zoom','inne','theme:inne',true),
  ('zoom','Inne','theme:inne',true)
ON CONFLICT (source, raw_value) DO UPDATE
SET tag_id   = EXCLUDED.tag_id,
    enabled  = EXCLUDED.enabled;

COMMIT;
