# Make.com

# Make Integrations (blueprints & guides)

This folder stores **Make.com** scenario blueprints (JSON) and usage notes for the Lublin Events Hub.

## Index

- **Phase A — Webhook only (parse → 1 HTTP → respond)**  
  Guide: `docs/integrations/make/phase-a-webhook.md`  
  Blueprint (sanitized): `integrations/make/2025-11-12_leh_webhook_one_http.blueprint.json`

- **Phase B — Telegram bot (buttons only; one HTTP per request)**  
  Guide: `docs/integrations/make/phase-b-telegram.md`  
  Blueprint (sanitized): `integrations/make/2025-11-20_leh_telegram_one_http.minimal.blueprint.json`

> “Sanitized” = **no real URLs/tokens** inside committed JSON.

---

## Naming convention

Place exported scenarios here using: YYYY-MM-DD_short-name.json

Examples:
- `2025-11-12_leh_webhook_one_http.blueprint.json`
- `2025-11-20_leh_telegram_one_http.minimal.blueprint.json`

Keep a short, descriptive suffix (e.g., `one_http`, `minimal`, `buttons_only`).

---

## Sanitization (required)

**Before committing** any blueprint or test collection:

- Replace placeholders:
  - `<MAKE_WEBHOOK_URL>` → your Make Custom Webhook URL
  - `<WEB_APP_URL>` → your Apps Script Web App `/exec` URL
  - `<BOT_TOKEN>` → your Telegram bot token
- Do **not** commit real URLs/tokens. If a webhook URL was exposed, **rotate** it in Make:
  1) Create a new webhook in the module (generates a new URL)  
  2) Update clients (Postman, notes)  
  3) Delete the old webhook  
- Optional hardening: require a shared token (e.g., query param `?token=…` or header `X-LEH-Token`) and validate it in the scenario.

---

## Import / Export

- **Export** in Make: open scenario → ⋯ → *Export blueprint (JSON)* → save to `integrations/make/`.
- **Import** in Make: ⋯ → *Import blueprint* → then replace placeholders with real values.

If you keep Postman tests, store them in: integrations/tests/postman/<name>.postman_collection.json

…and sanitize URLs there as well.

---

## Ops footprint

Both Phase A and Phase B are designed for **one HTTP call per user action**.  
- No taxonomy mapping or sorting in Make; API handles that.  
- Phase B uses **buttons only**, no state/pagination, to minimize operations.

---

## Related docs

- Query API: `docs/specs/query-api.md`  
- Architecture: `docs/architecture/overview-minimal-make-ops.md`

