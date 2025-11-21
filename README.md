# AI Agent — Lublin Events

Single source of truth for code, docs, and decisions.

## What lives here
- `workers/` — Cloudflare Workers per source (code + README).
- `apps_script/` — Google Apps Script projects (each subfolder = one project).
- `integrations/make/` — Make.com blueprints (JSON, sanitized) and Postman tests.
- `docs/integrations/make/` — Guides for Phase A (Webhook) and Phase B (Telegram buttons).
- `sheets/` — Google Sheets schema, sample CSVs, and docs.
- `docs/strategy/` — Strategy versions (v1, v2, ...).
- `docs/architecture/` — the big-picture diagram + flow.
- `docs/adr/` — Architecture Decision Records.
- `prompts/` — Prompt packs and “context stamps” examples.
- `CHANGELOG.md` — Human‑readable changes by version.
- `.env.example` — Required env vars (never commit real secrets).

## Integrations

### Make.com
- **Phase A — Webhook only (parse → 1 HTTP → respond)**
  - Guide: `docs/integrations/make/phase-a-webhook.md`
  - Blueprint (sanitized): `integrations/make/2025-11-12_leh_webhook_one_http.blueprint.json`

- **Phase B — Telegram bot (buttons only; one HTTP per request)**
  - Guide: `docs/integrations/make/phase-b-telegram.md`
  - Blueprint (sanitized): `integrations/make/2025-11-20_lublin-events_one-http.blueprint_sanitized.json`

> **Sanitization:** committed blueprints and test collections must use placeholders (`<MAKE_WEBHOOK_URL>`, `<WEB_APP_URL>`, `<BOT_TOKEN>`). Do not commit real URLs/tokens.


## How to work with ChatGPT
Copy/paste this context stamp at the top of every conversation, then attach the changed files:

```
Context
Repo: <your repo URL>
Commit: <7-char SHA or tag e.g., v0.1.0>
Strategy doc: docs/strategy/v1.md
Integrations: docs/integrations/make/README.md
Focus files: workers/lublin-eu/worker.js; sheets/schema/events_v2.md
Question: <what you want help with>
```
