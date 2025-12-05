# ADR-0015 – LEHv2 runtime stack: n8n Cloud + Supabase

*Status:* Accepted  
*Date:* 2025-12-01  
*Applies to:* LEHv2

## Context

LEHv1 used:

- Make.com for orchestration and Telegram integration.
- Google Sheets (`raw_events`, `events`) as the primary data store.
- Google Apps Script for refresh/materialize/query.

This was effective for a first prototype, but:

- Per-request cost in Make.com made richer user flows (state, pagination, more filters) expensive to run.
- Google Sheets + Apps Script became a bottleneck for more complex queries and schema evolution.
- The stack was tightly coupled to a specific tool (Make), limiting portability.

LEHv2 has:

- Small, predictable workloads (limited events and user requests).
- A need for direct SQL-level access and more flexible data modeling.
- A requirement to keep DevOps overhead low for a solo developer, with predictable monthly costs.

## Decision

For LEHv2 we will:

1. **Use n8n Cloud (Starter) as the main workflow engine**

   - `WF-INGEST`:
     - Daily ingestion from the Hub (Cloudflare Workers) using JSON mode (`sheet=0`, ADR-0004).
     - Transformation and upsert into Supabase tables (`events`, `showtimes`).
   - `WF-BOT-TG`:
     - Telegram bot with button-only flows for:
       - period,
       - category,
       - payment,
       - pagination (`More` / `Back`).
     - Reads and writes per-chat state in Supabase (`user_state`).
   - Future workflows:
     - `WF-ADMIN` (diagnostics, simple stats),
     - `WF-ENRICH` (LLM-based enrichment).

2. **Use Supabase (PostgreSQL) as the primary database**

   - Replace Sheets `raw_events` / `events` with DB tables:
     - `events` – normalized event-level data (based on ADR-0005).
     - `showtimes` – per date/time instance (supporting multiple showtimes per event).
     - `user_state` – Telegram bot per-chat state.
     - Future tables for enrichment (audience, activity type, etc.).
   - Rely on Supabase for:
     - managed Postgres (backups, scaling),
     - SQL access from n8n.

DB schema v1: docs/lehv2/LEHv2_DB/LEHv2_DB_schema_S1.md

3. **Keep Cloudflare Workers as source adapters and Hub**

   - Per-source adapters (official, zoom, etc.) and Hub are reused from LEHv1.
   - Adapter and Hub contracts (budget, enrichment, `_EndDate`, Source) remain valid (ADR-0004/0006/0008/0009/0010).

4. **Use Telegram as the first and primary user interface**

   - Button-based UX only (no free-text semantic search for now).
   - Additional channels (WhatsApp, Messenger) may be added later, reusing the same DB and core workflows.

LEHv1 stack (Make + Sheets + Apps Script) remains in the repository as **legacy** for reference and documentation, but is not the active runtime.

## Consequences

### Pros

- Lower per-request cost than Make.com for LEHv2’s expected usage.
- Richer, more maintainable data model using SQL:
  - easier filters and joins,
  - easier schema evolution.
- Less custom backend code than building a bespoke API from scratch; n8n provides orchestration and integration.
- Clear separation of concerns:
  - adapters & Hub for scraping/merging,
  - n8n for workflows,
  - Supabase for data,
  - Telegram for UI.

### Cons

- Fixed monthly cost for n8n Cloud (and, eventually, a paid DB tier).
- Two managed services to monitor (n8n Cloud + Supabase) instead of one.
- Migration work from Sheets + Apps Script to DB-based ingestion and query flow.

### Follow-ups

- Mark LEHv1 runtime ADR(s) that describe “Make + Sheets + Apps Script” as **Superseded for LEHv2** but keep them for history.
- Align architecture docs:
  - `docs/architecture/overview-minimal-make-ops.md` → legacy.
  - `docs/architecture/overview-minimal-n8n-ops.md` → active minimal runtime.
- Define:
  - LEHv2 taxonomy/enrichment approach in a dedicated ADR (superseding ADR-0002 for v2).
