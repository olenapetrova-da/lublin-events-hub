# AI Agent — Lublin Events

Single source of truth for code, docs, and decisions.

## What lives here
- `workers/` — Cloudflare Workers per source (code + README).
- `apps_script/` — Google Apps Script projects (each subfolder = one project).
- `integrations/make/` — Make.com scenario exports (JSON).
- `sheets/` — Google Sheets schema, sample CSVs, and docs.
- `docs/strategy/` — Strategy versions (v1, v2, ...).
- `docs/adr/` — Architecture Decision Records.
- `prompts/` — Prompt packs and “context stamps” examples.
- `CHANGELOG.md` — Human‑readable changes by version.
- `.env.example` — Required env vars (never commit real secrets).

## How to work with ChatGPT
Copy/paste this context stamp at the top of every conversation, then attach the changed files:

```
Context
Repo: <your repo URL>
Commit: <7-char SHA or tag e.g., v0.1.0>
Strategy doc: docs/strategy/v1.md
Focus files: workers/lublin-eu/worker.js; sheets/schema/events_v2.md
Question: <what you want help with>
```
