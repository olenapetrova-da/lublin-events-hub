-- Seed canonical Theme tags used by Telegram menus (Stage 2).
-- Idempotent: safe to re-run.

BEGIN;

INSERT INTO public.tags (tag_id, kind, code, label_pl, enabled)
VALUES
  ('theme:teatr',     'theme', 'teatr',     'Teatr',      true),
  ('theme:film',      'theme', 'film',      'Film',       true),
  -- Decision: music-related categories use code 'koncert'
  ('theme:koncert',   'theme', 'koncert',   'Muzyka',     true),
  ('theme:spotkanie', 'theme', 'spotkanie', 'Spotkanie',  true),
  ('theme:warsztat',  'theme', 'warsztat',  'Warsztat',   true),
  ('theme:wystawa',   'theme', 'wystawa',   'Wystawa',    true),
  ('theme:wycieczka', 'theme', 'wycieczka', 'Wycieczka',  true),
  ('theme:sport',     'theme', 'sport',     'Sport',      true),
  ('theme:inne',      'theme', 'inne',      'Inne',       true)
ON CONFLICT (tag_id) DO UPDATE
SET kind     = EXCLUDED.kind,
    code     = EXCLUDED.code,
    label_pl = EXCLUDED.label_pl,
    enabled  = EXCLUDED.enabled;

COMMIT;
