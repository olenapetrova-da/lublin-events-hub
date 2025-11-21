# Phase B — Telegram bot (Make): buttons only, one HTTP per request

**Goal.** Let users tap buttons (no free text) to get a list:
`DATE — TITLE — TIMES — [VENUE]`. Exactly **one** HTTP GET to the Query API per “show events”.

**Blueprint (sanitized):** `integrations/make/2025-11-20_lublin-events_one-http.blueprint_sanitized.json`  
**API:** `<WEB_APP_URL>/exec` (Apps Script Web App, doGet)  
**Token:** `<BOT_TOKEN>` (Telegram)

---

## Prereqs
- Query API live and stable (ADR-0013).
- Apps Script daily pipeline running (OPS-TR1).
- Telegram bot created via BotFather; token available.

---

## Modules in order (Telegram-only)

1) **Telegram Bot → Watch updates**  
   - Enable **messages** and **callback queries**.

2) **Router** with three branches  
   - **Start:** `/start` message OR `callback_data = back:start`  
   - **Period selected:** `callback_data` starts with `p:` (`p:day` or `p:week`)  
   - **Category selected (final action):** `callback_data` starts with `c:` and embeds period, e.g. `c:film|p:day`, `c:theatre|p:week`

3) **Start branch → Send message** (inline keyboard: period)  
   - Text: short intro (e.g., “Wybierz okres”).  
   - Buttons:
     - **Dziś** → `callback_data: p:day`
     - **Tydzień** → `callback_data: p:week`

4) **Period branch → Send message** (inline keyboard: categories)  
   - Text: “Wybierz kategorię”.  
   - Buttons (examples):
     - **Film** → `callback_data: c:film|p:<period>`
     - **Teatr** → `callback_data: c:theatre|p:<period>`
     - **Wróć** → `callback_data: back:start`

5) **Category branch (final action)**  
   - **Tools → Set variables**  
     - `period` from `callback_data` (`day|week`)  
     - `category` from `callback_data` (`film|theatre`) — pass verbatim  
     - `date` = **today** in `Europe/Warsaw` (`YYYY-MM-DD`)  
     - `limit` = `5`, `offset` = `0`
   - **HTTP → Make a request** (GET)  
     - URL: `<WEB_APP_URL>/exec`  
     - Query params (use Make’s key/value fields):  
       `date`, `period`, `category`, `limit`, `offset`
   - **Format response**  
     - **Header**:
       - Day: `Wyniki (dzień <YYYY-MM-DD>)`  
       - Week: `Wyniki (tydzień <YYYY-MM-DD–YYYY-MM-DD>) • kategoria: <category>`
     - **Body**: one line per item  
       `DATE — TITLE — TIMES — [VENUE_if_present]`  
       If empty: `Brak wydarzeń dla wybranych filtrów.`
   - **Telegram Bot → Send message**  
     - Text = header + body  
     - Inline keyboard: **Start** → `callback_data: back:start`

> Formatting can be done with a single **Set variables** (join/map) or with **Iterator + Text Aggregator**. Both are acceptable; prefer the lower-ops path you’re comfortable with.

---

## Callback scheme (exact)

- Period buttons:  
  - `p:day`  
  - `p:week`
- Category buttons (embed period, no stored state):  
  - `c:film|p:day`  
  - `c:theatre|p:day`  
  - `c:film|p:week`  
  - `c:theatre|p:week`
- Navigation:  
  - `back:start`

Router conditions should check `callback_data` prefix (`p:` vs `c:`) and the explicit `back:start`.

---

## Params passed to API

- `date` — today in **Europe/Warsaw**, `YYYY-MM-DD`
- `period` — `day` or `week` (from button)
- `category` — `film` or `theatre` (from button; passed **verbatim**)
- `limit` — `5`
- `offset` — `0`

Sorting and filtering are handled by the API. No taxonomy or mapping in Make.

---

## Output formatting rule

**Each line:**  
`DATE — TITLE — TIMES — [VENUE]`  
(Include “ — VENUE” only if venue is present.)

---

## Test flows

1) `/start → Dziś → Film`  
   - Expect up to 5 lines; correct order from API.

2) `/start → Dziś → Teatr`  
   - Verify theatre filter works.

3) `/start → Tydzień → Film`  
   - Week window; still limit=5.

4) A combination with zero results  
   - Should show header + `Brak wydarzeń dla wybranych filtrów.`

5) Navigation  
   - **Wróć** or **Start** button returns to period menu.

---

## Sanitization (required for committed files)

- Replace real values with placeholders **before committing**:
  - `<WEB_APP_URL>` — your Apps Script Web App `/exec` URL
  - `<BOT_TOKEN>` — your Telegram bot token
- Do **not** commit real tokens/URLs.  
- If a token leaks, **revoke/regenerate** via BotFather and update the Make connection.

---

## Notes

- No pagination, “More”, or persistent state in this phase.  
- Keep user-facing text in Polish; internal labels can stay English.  
- Ensure `taxonomy_alias` covers your chosen button tokens (`film`, `theatre`) to match API expectations.

**Related**  
- Query API spec: `docs/specs/query-api.md`  
- Architecture: `docs/architecture/overview-minimal-make-ops.md`
