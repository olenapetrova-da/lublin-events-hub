-- S2-02 — Finalize public.user_state (Telegram session state)
-- Implements ADR-0016-user-state-session-invariants (2026-01-13)

BEGIN;

-- 1) Rename legacy columns to Stage 2 contract naming (if they exist)
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema='public' AND table_name='user_state' AND column_name='category'
  ) THEN
    EXECUTE 'ALTER TABLE public.user_state RENAME COLUMN category TO theme';
  END IF;

  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema='public' AND table_name='user_state' AND column_name='payment'
  ) THEN
    EXECUTE 'ALTER TABLE public.user_state RENAME COLUMN payment TO pay';
  END IF;

  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema='public' AND table_name='user_state' AND column_name='page_offset'
  ) THEN
    EXECUTE 'ALTER TABLE public.user_state RENAME COLUMN page_offset TO "offset"';
  END IF;
END $$;

-- 2) Add new Stage 2 fields (idempotent)
ALTER TABLE public.user_state
  ADD COLUMN IF NOT EXISTS lr smallint NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS anchor_date date;

-- 3) Normalize existing data to satisfy new constraints
-- Step: legacy default was 'idle' → move to 'main'
UPDATE public.user_state
SET step = 'main'
WHERE step IS NULL OR step NOT IN ('main','period','theme','pay');

-- Period: keep only allowed codes; otherwise reset
UPDATE public.user_state
SET period = NULL
WHERE period IS NOT NULL AND period NOT IN ('today','tomorrow','weekend','week');

-- Theme: default to 'all' unless it is an allowed code
UPDATE public.user_state
SET theme = 'all'
WHERE theme IS NULL OR theme NOT IN (
  'all','teatr','film','koncert','spotkanie','warsztat','wystawa','wycieczka','sport','inne'
);

-- Pay: default to 'all' unless it is an allowed code
UPDATE public.user_state
SET pay = 'all'
WHERE pay IS NULL OR pay NOT IN ('all','free','paid','unknown');

-- lr: enforce {0,1}
UPDATE public.user_state
SET lr = 0
WHERE lr IS NULL OR lr NOT IN (0,1);

-- offset: enforce non-negative integer
UPDATE public.user_state
SET "offset" = 0
WHERE "offset" IS NULL OR "offset" < 0;

-- anchor_date: if period is set, ensure anchor_date is non-null (best-effort for pre-existing rows)
UPDATE public.user_state
SET anchor_date = (now() AT TIME ZONE 'Europe/Warsaw')::date
WHERE period IS NOT NULL AND anchor_date IS NULL;

-- if period is NULL, anchor_date must be NULL
UPDATE public.user_state
SET anchor_date = NULL
WHERE period IS NULL AND anchor_date IS NOT NULL;

-- 4) Align defaults + NOT NULL where required by MVP
ALTER TABLE public.user_state
  ALTER COLUMN step SET DEFAULT 'main',
  ALTER COLUMN theme SET DEFAULT 'all',
  ALTER COLUMN theme SET NOT NULL,
  ALTER COLUMN pay SET DEFAULT 'all',
  ALTER COLUMN pay SET NOT NULL,
  ALTER COLUMN lr SET DEFAULT 0,
  ALTER COLUMN lr SET NOT NULL,
  ALTER COLUMN "offset" SET DEFAULT 0,
  ALTER COLUMN "offset" SET NOT NULL;

-- 5) Add DB constraints (drop/recreate to keep migration re-runnable)
ALTER TABLE public.user_state
  DROP CONSTRAINT IF EXISTS user_state_step_chk,
  DROP CONSTRAINT IF EXISTS user_state_period_chk,
  DROP CONSTRAINT IF EXISTS user_state_theme_chk,
  DROP CONSTRAINT IF EXISTS user_state_pay_chk,
  DROP CONSTRAINT IF EXISTS user_state_lr_chk,
  DROP CONSTRAINT IF EXISTS user_state_offset_chk,
  DROP CONSTRAINT IF EXISTS user_state_anchor_date_chk;

ALTER TABLE public.user_state
  ADD CONSTRAINT user_state_step_chk
    CHECK (step IN ('main','period','theme','pay')),
  ADD CONSTRAINT user_state_period_chk
    CHECK (period IS NULL OR period IN ('today','tomorrow','weekend','week')),
  ADD CONSTRAINT user_state_theme_chk
    CHECK (theme IN ('all','teatr','film','koncert','spotkanie','warsztat','wystawa','wycieczka','sport','inne')),
  ADD CONSTRAINT user_state_pay_chk
    CHECK (pay IN ('all','free','paid','unknown')),
  ADD CONSTRAINT user_state_lr_chk
    CHECK (lr IN (0,1)),
  ADD CONSTRAINT user_state_offset_chk
    CHECK ("offset" >= 0),
  ADD CONSTRAINT user_state_anchor_date_chk
    CHECK (period IS NULL OR anchor_date IS NOT NULL);

-- 6) Trigger: keep updated_at fresh; reset offset on filter changes; set anchor_date on period changes
CREATE OR REPLACE FUNCTION public.tg_user_state_invariants()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  warsaw_today date;
BEGIN
  warsaw_today := (now() AT TIME ZONE 'Europe/Warsaw')::date;

  -- always refresh
  NEW.updated_at := now();

  IF TG_OP = 'INSERT' THEN
    -- If period is set during insert, anchor_date must be frozen.
    IF NEW.period IS NULL THEN
      NEW.anchor_date := NULL;
    ELSE
      NEW.anchor_date := COALESCE(NEW.anchor_date, warsaw_today);
      NEW."offset" := 0;
    END IF;
    RETURN NEW;
  END IF;

  -- Any filter change resets pagination
  IF (NEW.period IS DISTINCT FROM OLD.period)
     OR (NEW.theme IS DISTINCT FROM OLD.theme)
     OR (NEW.pay   IS DISTINCT FROM OLD.pay)
     OR (NEW.lr    IS DISTINCT FROM OLD.lr) THEN
    NEW."offset" := 0;
  END IF;

  -- Period changes freeze a new anchor_date; clearing period clears anchor_date
  IF NEW.period IS DISTINCT FROM OLD.period THEN
    IF NEW.period IS NULL THEN
      NEW.anchor_date := NULL;
    ELSE
      NEW.anchor_date := warsaw_today;
    END IF;
  ELSE
    -- Defensive: if period is set but anchor_date got lost, restore it
    IF NEW.period IS NOT NULL AND NEW.anchor_date IS NULL THEN
      NEW.anchor_date := warsaw_today;
    END IF;
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_user_state_invariants ON public.user_state;
CREATE TRIGGER trg_user_state_invariants
BEFORE INSERT OR UPDATE ON public.user_state
FOR EACH ROW
EXECUTE FUNCTION public.tg_user_state_invariants();

COMMIT;
