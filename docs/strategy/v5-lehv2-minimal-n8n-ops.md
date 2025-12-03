# Strategy v5 — LEHv2 (n8n + Supabase + Telegram)

> Status (2025-12): **Active — LEHv2**  
> This strategy describes the LEHv2 implementation based on n8n Cloud + Supabase + Telegram.  
> LEHv1 (Make + Google Sheets + Apps Script) strategy is in `docs/strategy/v4.md` (legacy).  
> Detailed scope and stages: `docs/lehv2/LEHv2_ProjectScope_and_Roadmap.md`.

---

## 1. Context

LEHv1 proved that:

- Cloudflare Workers adapters + Hub can reliably fetch and normalize events for Lublin.
- A daily refresh + normalized table + simple Query API is enough for an end-to-end flow.
- Make.com + Sheets + Apps Script work, but:
  - per-request cost and quotas make richer user flows expensive,
  - Sheets + Apps Script limit query flexibility and future evolution.

LEHv2 keeps the **same external goal** (a practical events hub for Lublin residents) but changes the runtime:

- Replace Make + Sheets + Apps Script with:
  - **n8n Cloud (Starter)** for workflows.
  - **Supabase (PostgreSQL)** for the database.
  - **Telegram bot** as the main UI.

Cloudflare Workers (source adapters + Hub) remain as the ingestion entry point.

---

## 2. Objectives for LEHv2 (MVP)

### 2.1 Primary objective

Deliver a **minimal, production-usable runtime** that:

- Ingests events daily from the existing Hub into Supabase with predictable cost.
- Lets users query events via a Telegram bot using **only buttons**:
  - period (today / weekend / week),
  - category (curated subset),
  - payment (any / free),
  - simple pagination (“More”).
- Can evolve towards richer capabilities (more filters, enrichment, more channels) without redoing the foundation.

### 2.2 Non-goals for MVP

Intentionally **out of scope** for this version:

- Free-text natural-language queries.
- Web UI or other chat channels (WhatsApp, Messenger).
- Full LLM-driven enrichment pipeline (only placeholders and simple manual mapping for now).
- Complex admin dashboards; we rely on n8n’s UI + simple SQL for diagnostics.

---

## 3. Stack and responsibilities

### 3.1 Cloudflare Workers (unchanged from LEHv1)

- **Per-source adapters** (official, zoom, etc.):
  - Scrape list pages; optionally enrich via detail pages (`enrich=1`, `enrich_max`).
  - Emit normalized fields including `Payment for Entry`, `Date`, `_EndDate`, `Source`, `Time`.
  - Respect budget and stop policy (ADR-0010).

- **Hub Worker**:
  - Merge per-source outputs, dedupe showtimes.
  - Apply hub ordering policy (timed first, then ongoing) and cross-source fallback dedupe (ADR-0011, ADR-0012).
  - Emit JSON `events[]` in `sheet=0` mode for ingestion.

### 3.2 n8n Cloud

- **WF-INGEST (daily)**:
  - Trigger: Cron (Europe/Warsaw), once per day.
  - Call: Hub Worker with `sheet=0`, `group_times=1`, limited horizon (e.g. 7–14 days).
  - Normalize and upsert into Supabase tables:
    - `events` (event-level data, IDs, URLs, source).
    - `showtimes` (per date/time/venue instance, payment).
  - Log basic telemetry (per-source counts, total showtimes).

- **WF-BOT-TG (Telegram bot)**:
  - Trigger: Telegram new message/update.
  - Manage `user_state` in Supabase for each `chat_id`:
    - `step`, `period`, `category`, `payment`, `offset`, timestamps.
  - For “Show events”:
    - Query Supabase with appropriate filters and sorting.
    - Render a list like `DATE — TITLE — TIMES — VENUE`.
    - Provide “More” / “Back” buttons.

---

## 4. Data model (LEHv2 view)

Conceptually reuse ADR-0005 “raw_events → events”, but implement it in PostgreSQL instead of Sheets.

Minimal schema v1:

- **events**
  - `event_id` (stable ID, same recipe as in LEHv1).
  - `title`
  - `source` (hostname)
  - `url`
  - optional denormalized fields (e.g. first date, first venue) for convenience.

- **showtimes**
  - `event_id` (FK to `events`)
  - `date` (local date, Europe/Warsaw)
  - `time` (nullable; `HH:MM` text or time type)
  - `_end_date` (local date, for multi-day events)
  - `venue` (text)
  - `payment` (`free|paid|unknown`)
  - other simple attributes as needed.

- **user_state**
  - `chat_id`
  - `step` (enum-like text)
  - `period` (`today|weekend|week|range`)
  - `category`
  - `payment` (`any|free`)
  - `offset` (integer)
  - `updated_at`

LLM-based enrichment (categories, audience, etc.) will be added later via additional tables and workflows; the core MVP does not depend on it.

---

## 5. Strategy for stages

Stages here align with `LEHv2_ProjectScope_and_Roadmap.md`, but phrased from a strategic view.

### Stage 0 — Environment & decisions (done)

- Choose Option A (managed n8n + managed Postgres).
- Create Supabase project and basic test table.
- Create n8n workspace, Postgres credentials, and a “ping” workflow.
- Freeze ADRs and architecture boundaries between:
  - adapters + Hub,
  - ingestion,
  - DB,
  - bot.

### Stage 1 — Data backbone (WF-INGEST + Supabase schema)

Goal: **DB contains correct events and showtimes, refreshed daily.**

- Finalize LEHv2 DB schema v1 (events, showtimes, user_state placeholder).
- Implement `WF-INGEST`:
  - call Hub (JSON, 7–14 day horizon),
  - apply core transformation rules (date/time, `_EndDate`, payment mapping),
  - upsert into Supabase.
- Add minimal ingestion log/telemetry and daily Cron schedule.

Definition of done:

- Manual SQL queries return sane data for a chosen date.
- n8n executions show successful daily runs with reasonable counts.

### Stage 2 — Telegram bot MVP (WF-BOT-TG)

Goal: **End-to-end button-only bot using the DB, no Sheets.**

- Finalize user journey:
  - `/start` → main menu → period → category → payment → show events.
- Implement `user_state` handling in Supabase from n8n.
- Implement SQL queries for filtered event lists + pagination.
- Implement “More” and “Back” behaviour.

Definition of done:

- A real user (you) can:
  - start the bot,
  - choose filters,
  - see events,
  - page through results,
  - restart/change filters.

### Stage 3+ — Enhancements (post-MVP)

Not part of this minimal strategy, but anticipated:

- Additional filters (age group, type of event) once data supports it.
- LLM-based classification/enrichment in a controlled, low-budget way.
- Additional client channels reusing the same DB and workflows.

---

## 6. Constraints and trade-offs

- **Budget / cost**
  - n8n Cloud Starter and Supabase free/low tier must be enough for:
    - daily ingestion for 7–14 day horizon,
    - realistic Telegram usage (solo project).
  - No heavy polling or chatty workflows; keep:
    - one HTTP to Hub per ingestion run,
    - one SQL query per user action, plus minimal state updates.

- **Simplicity**
  - No custom backend API for LEHv2 MVP; n8n + SQL is enough.
  - No advanced stateful bot logic beyond simple step + offset.

- **Durability**
  - DB is the single source of truth for events and showtimes; Telegram and n8n can be re-bound without rebuilding data.
  - ADRs document decisions so future you can revisit trade-offs.

---

## 7. Versioning and documentation

- Tag this strategy as **v5** once the LEHv2 minimal runtime is implemented.
- Keep `v4.md` as the **LEHv1 strategy** with a clear legacy banner.
- For implementation details, prefer:
  - ADRs under `docs/adr/` (decisions),
  - `docs/architecture/overview-minimal-n8n-ops.md` (current architecture),
  - `docs/lehv2/LEHv2_ProjectScope_and_Roadmap.md` (plan + stages).

Updates to this strategy doc should be **additive** (clarifying constraints, updating stages), not silently rewriting past decisions.
