# LEH v2 – Project Scope and Roadmap

## 0. Summary

LEH v2 is a small, low-budget application that aggregates events in Lublin from multiple web sources, normalizes them into a PostgreSQL database, and exposes them via a button-driven chatbot (Telegram first, later another channel such as WhatsApp or Facebook Messenger). The system must be cheap to run, simple enough for a solo developer to maintain, and designed so that LLM-based enrichment can be added in a controlled way.

The initial milestone (this roadmap Stages 1–2) delivers a production-usable bot on top of n8n + PostgreSQL, with data ingested from existing Cloudflare Workers and with a clear place to plug in an enrichment agent later.

---

## 1. Scope

### 1.1 Business goal

- Help residents of Lublin quickly find relevant events by:
  - date / period,
  - category,
  - payment (free vs paid),
  - with later extensions for audience and activity type.
- Run on a modern stack (n8n + PostgreSQL, not Google Sheets).
- Demonstrate practical experience with AI/agentic enrichment without committing to high, uncontrolled LLM costs.

### 1.2 Functional scope (v2 overall)

1. **Data ingestion**
   - Pull normalized JSON events from the existing Hub (Cloudflare Workers).
   - Deduplicate and persist events into PostgreSQL.
   - Keep only a rolling horizon (e.g. next 7–14 days) to limit volume.

2. **Data model**
   - Represent:
     - events (title, description, source, URL),
     - showtimes (date/time instances, venue, payment),
     - tags/labels (category, audience, activity type) with many-to-many relationships.
   - Store enrichment results so LLMs are called only on *new or changed* events.

3. **Query API (internal)**
   - n8n workflows that query PostgreSQL by:
     - period (day, weekend, week),
     - category,
     - payment (free / any),
     - later: audience and activity type.
   - Sorting: date ↑, time ↑, title ↑ (consistent with v1 ADRs).

4. **Chatbot interface**
   - Telegram bot as the first channel:
     - Button-based flows only (no natural-language questions).
     - Back and More (pagination) flows with minimal state.
     - Simple handling of free-text:
       - recognise “thank you” and reply accordingly,
       - otherwise respond with short instruction and show buttons again.

5. **Enrichment agent (later stage)**
   - LLM-powered classifier that:
     - derives Category, Audience, Activity type from event text,
     - avoids complex regex and brittle rule sets.
   - Runs as part of ingestion in a controlled, budget-capped way.

6. **Operations & observability**
   - Daily scheduled ingestion.
   - Basic metrics:
     - number of events in DB,
     - last successful ingestion time,
     - error logging in n8n.
   - Simple admin flow to inspect stats (e.g. via Telegram command).

### 1.3 Non-functional scope

- **Scale**: up to ~150 events/day from current sources + up to ~200/day from future sources, i.e. ≤ ~350/day in peak scenarios. :contentReference[oaicite:0]{index=0}
- **Users**: up to ~50 users/week, up to 5 requests per user session (production target). :contentReference[oaicite:1]{index=1}
- **Latency**: acceptable if the bot returns results within a few seconds per request.
- **Availability**: “best effort” for a solo project, but designed so that:
  - ingestion failure does not break the bot (bot can still serve last known data),
  - single failed source does not break others.

### 1.4 Out of scope (for now)

- Free-text semantic search (“something nice for kids Saturday afternoon”).
- Multi-language UX beyond Polish/English button labels.
- Payments, ticket sales, or reservations.
- Complex admin UI (web dashboard); admin is via DB and simple bot commands.
- Full-blown multi-agent orchestration; enrichment is a single, focused LLM agent.

---

## 2. Assumptions and constraints

### 2.1 Volumes and usage

- Events:
  - Today + short horizon (e.g. next 7–14 days) with up to ~350 events/day across all sources. :contentReference[oaicite:2]{index=2}
  - Historical events may be archived or dropped to keep tables small.
- Users:
  - Production: up to ~50 users/week, ~250 requests/week. :contentReference[oaicite:3]{index=3}
  - Development/testing: your own traffic will exceed this but will still be small in absolute terms.

### 2.2 Budget and tooling

- You pay personally; users do not pay.
- You already pay for **ChatGPT Plus** and **do not want multiple expensive tools**.
- You accept paying for **one integration platform** (n8n) and **one database**, but need to keep total monthly costs low.

**Hosting options (decision in Stage 0):**

- **Option A – Managed n8n + managed PostgreSQL (recommended for v2)**
  - n8n Cloud on a low tier.
  - PostgreSQL on a managed platform (e.g. Supabase, Render, Railway) using free or low tier.
  - Pros: minimal DevOps, faster delivery, simpler backups, less risk of “stuck in technical issues”.
  - Cons: higher monthly cost than a single VPS.

- **Option B – Self-hosted n8n + PostgreSQL on one VPS**
  - One small VPS (e.g. 2GB RAM) running Docker: n8n + Postgres.
  - Pros: single, predictable low monthly cost; full control.
  - Cons: you are responsible for upgrades, monitoring, disk space, security.

The roadmap assumes **Option A** for simplicity. If you choose Option B, the functional design stays the same, only infra tasks change.

### 2.3 LLM usage constraints

- Purpose:
  - Enrich events with Category, Audience, Activity type.
  - Optionally classify user messages as “thank you” vs “other” (this can be done rule-based, without LLM).
- There will be **no free-text Q&A**; bot remains button-driven.
- Budget:
  - LLM cost must remain below your “single-tool” monthly budget and will be tuned after we measure real volumes.
  - Strategy:
    - call LLM *once* per new event,
    - cache and store enrichment results in DB,
    - run pilot on a subset of events first.

---

## 3. Architecture baseline

### 3.1 Components

1. **Source adapters (existing)**
   - Cloudflare Workers for lublin.eu, zoom.lublin.pl, etc.
   - Hub Worker that merges and normalizes events into JSON.

2. **Integration / Orchestration**
   - n8n workflows:
     - Daily ingestion (Hub → PostgreSQL),
     - Bot flows (Telegram now, other channels later),
     - Admin/maintenance flows (optional).

3. **Database**
   - PostgreSQL schema (v1 minimal):
     - `events` – event-level data (id, title, description, source, URL, etc.).
     - `showtimes` – date/time instances with venue and payment info.
     - `tags` / `event_tags` – labels for category, audience, activity type.
     - `user_state` – per-chat state for the bot (period, category, payment, offset, last query).

4. **LLM Enrichment (later)**
   - A dedicated workflow that:
     - pulls unclassified events from DB,
     - calls LLM to derive labels,
     - writes labels back to DB,
     - tracks usage for cost control.

5. **Chatbot**
   - Telegram bot using n8n’s Telegram nodes.
   - Later: another channel (WhatsApp or Facebook Messenger) reusing the same DB and query flows.

### 3.2 n8n workflows (target list)

1. **WF-INGEST** – Daily ingestion:
   - Trigger: Cron (daily).
   - HTTP: call Hub with date/period params.
   - Transform: split JSON, normalize.
   - DB: upsert into `events` and `showtimes`.
   - Log: write summary to log and/or a small log table.

2. **WF-BOT-TG** – Telegram bot:
   - Trigger: Telegram updates.
   - Route:
     - `/start`,
     - period selection,
     - category selection,
     - payment selection,
     - “Show results”,
     - “More” (pagination),
     - “Back”,
     - free text (“thank you” vs “other”).
   - DB: read/write `user_state`; read events.
   - Response: send formatted messages with reply keyboards.

3. **WF-ADMIN** – optional admin/test:
   - Trigger: HTTP or Telegram command.
   - DB: simple queries for counts, last ingestion time.
   - Response: text summary.

4. **WF-ENRICH** – enrichment (later stage):
   - Trigger: scheduled (e.g. after ingestion) or manual.
   - DB: select events without enrichment.
   - LLM: classify and return labels.
   - DB: write labels and mark as enriched.

---

## 4. Roadmap and stages

### Stage 0 – Setup & hosting decision

**Goal:** Choose hosting model, spin up n8n and PostgreSQL, and connect them.

**Tasks:**

1. Decide between **Option A (managed)** and **Option B (self-hosted)**.
2. Create n8n instance (cloud workspace or self-hosted).
3. Create PostgreSQL database (managed or on the same VPS).
4. Set up secure access:
   - DB credentials stored as n8n credentials.
   - Telegram bot token stored in n8n credentials.
5. Create a minimal test workflow:
   - Insert/select a row in PostgreSQL,
   - Confirm connectivity and auth.

**Done when:**

- You can run a simple n8n workflow that writes to and reads from PostgreSQL.
- You can receive a test update from Telegram in n8n (for later reuse).

---

### Stage 1 – Data backbone (Hub → PostgreSQL)

**Goal:** PostgreSQL holds a clean, up-to-date snapshot of events for the next few days, populated from the existing Hub JSON. No Google Sheets in the runtime path.

**Functional scope:**

- Single daily ingestion pipeline:
  - call Hub,
  - dedupe if needed,
  - write events and showtimes into DB.

**Tasks:**

1. **DB schema v1**
   - Design and create:
     - `events` (id, source, source_event_id, title, url, raw_text, created_at, updated_at).
     - `showtimes` (id, event_id, start_date, start_time, venue, payment, created_at).
   - Optional: `sources` table for source metadata.
   
   Done: 
   - docs/lehv2/LEHv2_DB_schema_S1.md
   - docs/lehv2/LEHv2_Hub_to_DB_Mapping_S1.md

2. **WF-INGEST implementation**
   - Cron trigger once per day (configurable time).
   - HTTP call to Hub:
     - period = day/week with horizon, e.g. today + 7 days.
   - Transform and dedupe:
     - split JSON into items,
     - ensure stable `event_id`/`source_event_id`.
   - DB upsert:
     - `events`: upsert on `source` + `source_event_id`.
     - `showtimes`: remove stale showtimes for the horizon and insert fresh ones.
   - Logging:
     - store aggregated counts in logs and/or a simple `ingest_log` table:
       - run id, timestamp, total events, showtimes, per-source counts, status.

3. **Manual checks**
   - Run ingestion manually.
   - Query DB directly (via DBeaver/psql) to confirm:
     - event counts per date,
     - a few specific events match Hub output.

4. **Enrichment preparation (no LLM yet)**
   - Add empty columns or tables for tags:
     - optionally `events.category`, `events.audience`, `events.activity_type` or separate `tags` tables.
   - Decide conventions for labels (canonical values).

**Done when:**

- One command/button in n8n manually re-runs ingestion and logs a summary.
- DB contains correct events and showtimes for the next 7–14 days.
- Schema is ready to store enrichment labels later.

---

### Stage 2 – Telegram bot MVP on new stack

**Goal:** Working Telegram bot backed by PostgreSQL + n8n, with the same core behaviour as v1 (date/period, category, payment, pagination), button-based only.

**User flows:**

1. `/start`:
   - Show welcome message and main menu:
     - choose period (Today / Tomorrow / Weekend / Week).
2. Choose period:
   - Save period in `user_state`.
   - Show category menu (small curated list).
3. Choose category:
   - Save category in `user_state`.
   - Show payment options (Free / Any).
4. Choose payment:
   - Save payment in `user_state`.
   - Trigger query and send first page of results (up to 10 events).
   - Show buttons:
     - “More” (if more pages),
     - “Back” (to category or period menu).
5. “More”:
   - Read `user_state.offset`,
   - Fetch next page,
   - Update offset, send next events.
6. “Back”:
   - Move one step back in the flow (e.g. from payment → category, or category → period).
7. Free-text:
   - If matches “thank you” patterns → friendly reply.
   - Else → short hint + show main menu again.

**Tasks:**

1. **Finalize `user_state` design**
   - Table: `user_state` with columns:
     - `chat_id`, `step`, `period`, `category`, `payment`, `offset`, `updated_at`.

2. **Implement WF-BOT-TG**
   - Telegram Trigger → main Router node:
     - branch on:
       - `/start`,
       - callback buttons (period/category/payment/more/back),
       - generic text.
   - Nodes to:
     - read/update `user_state`,
     - build SQL queries based on state,
     - format result list:
       - `date – category/audience – title – times – venue – payment – link`,
       - up to 10 rows per page, simple grouping if needed.
   - Keyboard design:
     - reply keyboards or inline keyboards for:
       - period,
       - category,
       - payment,
       - navigation (“More”, “Back”, “Menu”).

3. **PostgreSQL queries**
   - Implement queries for:
     - filtered event list by period/category/payment,
     - count of matching events (for pagination).
   - Optimise later if needed (indexes on date/category/payment).

4. **Error handling**
   - For DB or internal errors:
     - log the error,
     - send generic “technical issue, please try again later” message.

5. **Testing**
   - Local functional testing for:
     - each flow step,
     - pagination edge cases (0 events, 1 page, 2+ pages),
     - changes in filters (period/category/payment).
   - Smoke tests for 2–3 days in a row after enabling schedule.

**Done when:**

- Real Telegram users can get event lists for a chosen period + category + payment from PostgreSQL.
- Google Sheets is no longer needed to run the bot.
- The flows are stable enough for real-world usage with a small number of users.

---

### Stage 3 – LLM-based enrichment (pilot)

**Goal:** Automatically fill in Category, Audience, Activity type for events using an LLM, under strict budget control.

**Scope:**

- Run enrichment after ingestion (or separately on demand).
- Only classify *new* or *changed* events.
- Start with one or two sources to measure quality and cost.

**Tasks (high level):**

1. Define label sets:
   - explicit list of allowed values for:
     - Category,
     - Audience,
     - Activity type.
2. Design LLM prompt and output format.
3. Implement WF-ENRICH:
   - select events without labels,
   - batch them if it reduces token usage,
   - call LLM,
   - write labels to DB.
4. Add monitoring:
   - count of enriched events per run,
   - approximate token usage per run (estimated),
   - sample manual review.

**Done when:**

- Most events get useful labels automatically.
- Manual adjustments are limited to weird edge cases.
- Measured cost stays within your acceptable budget.

---

### Stage 4 – Second channel (WhatsApp or Facebook Messenger)

**Goal:** Reuse the same DB and core logic to expose the bot via a higher-value channel (WhatsApp or Facebook Messenger).

**Scope (high level):**

- Choose one channel (based on your priorities).
- Implement channel-specific trigger and response nodes in n8n.
- Map the existing state machine to the new channel:
  - same `user_state` table,
  - same query workflow,
  - adjusted button/interaction model if needed.

---

### Stage 5 – Operations hardening

**Goal:** Make the system more robust for long-term solo maintenance.

**Scope (examples):**

- Better monitoring and alerts:
  - notify you when ingestion fails,
  - notify when number of events for a day drops unexpectedly.
- Backups and retention:
  - schedule DB backups or snapshots,
  - define retention rules for old events.
- Documentation and runbooks:
  - simple guides for:
    - adding a new source,
    - disabling a broken source,
    - running enrichment manually.

---

## 5. Rough sizing and cost drivers

### 5.1 n8n workload

With your clarified volumes:

- **Ingestion**
  - Once per day:
    - 1 HTTP call to Hub,
    - ~350 items processed,
    - 1–2 DB upsert operations per item.
  - This is well within the limits of a low-tier n8n instance.

- **Bot traffic**
  - Production: ~250 requests/week (~36/day) from up to 50 users. :contentReference[oaicite:4]{index=4}
  - Each request involves:
    - 6–10 n8n nodes on average,
    - 1–2 DB queries.
  - Total node executions remain small compared to typical SaaS limits.

### 5.2 LLM usage

- Classification will be called:
  - once per new event,
  - optionally re-run if source text changes significantly.
- Upper bound:
  - at ~350 events/day, you enrich at most that number per day. :contentReference[oaicite:5]{index=5}
- With a compact prompt and a small model, this is expected to stay **below** the integration tool cost, but you will validate this during Stage 3 and can turn it off or restrict it if needed.

### 5.3 Main cost drivers (ordered)

1. Platform subscription (n8n Cloud **or** VPS).
2. LLM tokens for enrichment (only if Stage 3 is enabled).
3. Your time maintaining scrapers and handling changes in source sites.

---

## 6. Current milestone

For now, **Stages 1–2 are the active scope**:

- Stage 0–2 define the first end-to-end version on the new stack:
  - Hub → n8n ingestion → PostgreSQL → n8n Telegram bot.
- Later stages (3–5) are placeholders:
  - they show how enrichment, second channel, and operations hardening can be added without redesigning the core.
