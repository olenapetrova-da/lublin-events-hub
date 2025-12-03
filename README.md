# AI Agent — Lublin Events

Single source of truth for code, docs, and decisions for the **Lublin Events Hub**.

The project started as a **LEHv1** prototype (Google Sheets + Apps Script + Make.com) and is now evolving into **LEHv2** (n8n Cloud + Supabase + Telegram). The v1 stack is kept in the repo as **legacy** for reference and comparison.

---

## Project status

- **LEHv2 (active)**
  - Stack: **n8n Cloud + Supabase (PostgreSQL) + Telegram bot**.
  - Purpose: production-usable, low-budget events hub that can grow with LLM-based enrichment.
- **LEHv1 (legacy)**
  - Stack: **Google Sheets + Apps Script + Make.com**.
  - Purpose: first end-to-end prototype, kept for history only (no new development planned).

---

## What lives here

### Active for LEHv2

- `workers/`  
  Cloudflare Workers per source (lublin.eu, zoom.lublin.pl, Hub, etc.). These still provide the event data for v2.

- `docs/lehv2/`  
  LEHv2-specific docs:
  - Project scope and roadmap,
  - Setup for n8n Cloud + Supabase,
  - DB schema and mappings,
  - future runbooks for ingestion and bot.

- `integrations/n8n/`  
  n8n artifacts:
  - Exported workflows (JSON) for ingestion, Telegram bot, admin helpers,
  - Short integration notes (how to import, how to test).

- `docs/strategy/`  
  Overall strategy docs (v1, v2, etc.). LEHv2 scope and evolution is referenced from here.

- `docs/architecture/`  
  Big-picture architecture diagrams and descriptions that apply to both v1 and v2 where relevant.

- `docs/adr/`  
  Architecture Decision Records (ADRs) tracking key choices (stack, data model, integration patterns, etc.).

- `prompts/`  
  Prompt packs and “context stamps” used when working with ChatGPT across both versions.

- `CHANGELOG.md`  
  Human-readable changes by version (releases, rc tags, etc.).

- `.env.example`  
  Template for required env vars (never commit real secrets).

### Legacy (LEHv1 — kept for reference)

These folders are not used by the LEHv2 runtime, but remain as documentation of the original implementation.

- `apps_script/`  
  Google Apps Script projects for:
  - refreshing raw events,
  - materializing normalized events in Sheets,
  - the old Query API.

- `sheets/`  
  Google Sheets schema and sample CSVs for the v1 database.

- `integrations/make/`  
  Make.com blueprints (JSON, sanitized) and Postman tests for:
  - Phase A — webhook → 1×HTTP → respond,
  - Phase B — Telegram bot (buttons, one HTTP per request).

- `docs/integrations/make/`  
  Guides and notes for v1 Make.com integrations (Phase A/B).

- `events_html/`  
  Saved HTML snippets from source sites (still useful when maintaining Workers).

- `scripts/ pwsh`  
  PowerShell helpers used during v1 development (may still be helpful for maintenance/automation).

---

## Integrations

### LEHv2 – n8n Cloud + Supabase + Telegram

- **n8n Cloud**
  - Main workflow engine for:
    - daily ingestion from Hub → Supabase,
    - Telegram bot flows (button-based),
    - optional admin/diagnostic workflows.

- **Supabase (PostgreSQL)**
  - Primary database for LEHv2:
    - `events`, `showtimes`, `user_state`, and later enrichment tables.

- **Telegram bot**
  - User interface for Lublin residents:
    - choose period, category, payment,
    - get a paginated list of events from the DB.

LEHv2 integration docs and exported workflows live under:

- `docs/lehv2/`
- `integrations/n8n/`

### LEHv1 – Make.com (legacy)

- Phase A — Webhook only (parse → 1 HTTP → respond)
  - Guide: `docs/integrations/make/phase-a-webhook.md`
  - Blueprint (sanitized):  
    `integrations/make/2025-11-12_leh_webhook_one_http.blueprint.json`

- Phase B — Telegram bot (buttons only; one HTTP per request)
  - Guide: `docs/integrations/make/phase-b-telegram.md`
  - Blueprint (sanitized):  
    `integrations/make/2025-11-20_lublin-events_one-http.blueprint_sanitized.json`

> Sanitization: committed blueprints and test collections must use placeholders (`<MAKE_WEBHOOK_URL>`, `<WEB_APP_URL>`, `<BOT_TOKEN>`). Do not commit real URLs/tokens.

---

## How to work with ChatGPT on this repo

When starting a new ChatGPT conversation about this project, include a short context stamp and then attach or paste relevant files.

Example:

```text
Context
Repo: https://github.com/olenapetrova-da/lublin-events-hub
Branch: main
Release: <tag or short SHA, e.g. v0.3.0-rc.6 or current HEAD>
LEHv2 docs: docs/lehv2/LEHv2_ProjectScope_and_Roadmap.md
Architecture: docs/architecture/<file>.md
Integrations: integrations/n8n/ (for v2), integrations/make/ (legacy)
Focus files: workers/<source>/..., docs/lehv2/LEHv2_DB_Schema_v1.md
Question: <what you want help with>
```

# About

Lublin Events Hub is a personal project to:

- aggregate cultural events in Lublin from multiple sources,
- normalize and classify them in a central database,
- expose them through a simple chatbot interface,
- experiment with AI/agentic enrichment in a controlled, low-budget way.