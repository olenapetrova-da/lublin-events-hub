# LEHv2 – Minimal runtime with n8n Cloud + Supabase

## 1. Purpose

Describe the minimal, production-usable runtime for LEHv2:

- Data: Cloudflare Workers Hub → n8n ingestion → Supabase (PostgreSQL).
- UX: Telegram bot (button-only) via n8n.
- Ops: daily ingestion + simple monitoring, low budget, low maintenance.

This replaces the LEHv1 Make.com-based minimal runtime
documented in `docs/architecture/overview-minimal-make-ops.md`.

---

## 2. Structure view (components)

### Sources

- **Cloudflare Workers – per-source adapters**
  - `official` adapter for lublin.eu.
  - `zoom` adapter for zoom.lublin.pl.
  - Future adapters for other sources.

- **Hub Worker**
  - Merges per-source outputs.
  - Dedupes showtimes.
  - Emits JSON `events[]` when called with `sheet=0`. (ADR-0004)

### Integration / Orchestration

- **n8n Cloud**
  - `WF-INGEST` – daily ingestion from Hub → Supabase.
  - `WF-BOT-TG` – Telegram bot (button-only).
  - Later: `WF-ADMIN` (diagnostics) and `WF-ENRICH` (LLM enrichment).

### Database

- **Supabase (PostgreSQL)**
  - Minimal schema v1:
    - `events` – event-level info (id, title, url, source, etc.).
    - `showtimes` – date/time instances (event_id, date, time, venue, payment, _EndDate).
    - `user_state` – per-chat state for Telegram bot.
  - Future: enrichment tables (audience, activity type, etc.).

### User interface

- **Telegram bot**
  - Public bot for Lublin residents.
  - Button-only flow:
    - choose period → category → payment → see events → More / Back.

---

## 3. Runtime view (happy path)

### A) Ingestion (daily)

1. `WF-INGEST` (Cron in n8n Cloud) calls the Hub with:
   - `sheet=0`, `group_times=1`,
   - date window (today + N days, e.g. 7–14),
   - optional `pages` and `limit` parameters.
2. Hub returns JSON `events[]` including `Date`, `Time`, `_EndDate`, `Source`, `Payment for Entry`, etc.
3. n8n:
   - parses the JSON,
   - applies data model rules from ADR-0004/0005/0009 (date/time, `_EndDate`, source),
   - upserts into Supabase tables:
     - `events` (stable `event_id`),
     - `showtimes` (per date/time/venue row).
4. Ingestion logs:
   - total events / showtimes,
   - per-source counts and telemetry,
   - status (`ok` / `partial` / `error`).

Partial data (due to adapter budget limits) is acceptable; daily runs achieve eventual completeness (ADR-0010).

### B) User request (Telegram bot)

1. User sends `/start` or taps a button in Telegram.
2. `WF-BOT-TG` (Telegram Trigger in n8n) receives the update.
3. Workflow reads/writes `user_state` in Supabase:
   - `period` (today / weekend / week),
   - `category` (subset of canonical categories),
   - `payment` (any / free),
   - `offset` (for pagination),
   - `step` (where the user is in the flow).
4. On “Show events”:
   - n8n executes SQL query against Supabase:
     - filters by date range (period),
     - optional category,
     - optional payment,
     - orders by date, time, title (ADR-0011, not detailed here),
     - applies `LIMIT` and `OFFSET`.
   - Formats up to N events into lines:
     - `YYYY-MM-DD — Title — Times — Venue — Payment — Source`.
   - Sends a message back via Telegram with:
     - the list of events,
     - “More” and “Back” buttons if relevant.
5. On “More”:
   - `offset` is increased,
   - the same query is re-run with a higher offset,
   - next page of results is sent.

---

## 4. Failure modes (minimal handling)

- **Ingestion failure**:
  - If `WF-INGEST` fails, previous data in Supabase remains.
  - Users still see last successful snapshot.
  - Failure is visible in n8n execution logs.

- **Adapter budget/partial data**:
  - Adapters may stop early due to budget limits (ADR-0010).
  - `WF-INGEST` records telemetry and treats partial results as “ok but incomplete”.
  - Next daily run extends coverage.

- **Database or n8n errors**:
  - If Supabase is temporarily unavailable or SQL fails:
    - `WF-BOT-TG` returns a generic “technical issue, please try again” message.
    - The error is visible in n8n logs.

---

## 5. Scope vs future extensions

**Stage 1 **

- DB schema v1: see docs/lehv2/LEHv2_DB_Schema_v1.md.

**Out of scope for this minimal runtime:**

- Free-text natural-language queries (bot remains button-only).
- Multi-channel clients (WhatsApp, Messenger).
- Deep LLM enrichment (only schema placeholders for future fields).

**Future extensions:**

- `WF-ENRICH` for LLM-based classification of:
  - Category, Audience, Activity type.
- Additional channels reusing the same DB and query workflows.
- Automated metrics / alerting on ingestion health.

---

## 6. Checklist for “minimal runtime done”

- [ ] `WF-INGEST` runs daily and populates Supabase (`events`, `showtimes`).
- [ ] Supabase contains correct, deduplicated events for a 7–14 day horizon.
- [ ] `WF-BOT-TG` responds to `/start` and guides through period → category → payment.
- [ ] Telegram users can see paginated event lists from Supabase.
- [ ] LEHv1 Make.com + Sheets path is no longer required for day-to-day use.
