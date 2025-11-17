# Make — Phase A (Webhook only): parse → 1 HTTP → respond

**Goal.** Accept simple inputs, call the Query API once, return lines:
`DATE — TITLE — TIMES — [VENUE]`. No taxonomy or extra logic in Make.

**API**
- Web App URL: `<PASTE YOUR /exec URL>`
- Params used: `date`, `period=day|week`, `category` (comma list), `limit`, `offset`
- Sorting and filtering are done by the API.

## Scenario (modules in order)
1. **Webhooks > Custom webhook** — accepts:
   - Structured JSON: `{"period":"week","date":"YYYY-MM-DD","category":"kids,music","limit":5,"offset":0}`
   - Or text: `{"text":"week kids,music"}`
2. **Tools > Set variables** — derive:
   - `period`: default `day` (detect `week`/`day` in text if present)
   - `date`: default **today Europe/Warsaw**
   - `category`: free text after period (pass verbatim)
   - `limit`: default `5`
   - `offset`: default `0`
3. **HTTP > Make a request** — GET `<WEB_APP_URL>/exec`
   - Query: `date={{date}}&period={{period}}&category={{category}}&limit={{limit}}&offset={{offset}}`
4. **Tools > Set variables** — format response:
   - For each item: `DATE — TITLE — TIMES — [VENUE]`
   - Join with `\n`; if `next_offset` present add hint: `Napisz 'more'…`
5. **Webhooks > Response** — return the text.

## Examples
- Body: `{"text":"day kids"}` → `...?date=<today>&period=day&category=kids&limit=5&offset=0`
- Body: `{"text":"week music,film"}` → `...?date=<today>&period=week&category=music,film&limit=5&offset=0`
- Follow-up: call again with `offset=<next_offset>` for pagination.

## Notes
- Keep exactly one HTTP call per request.
- Make does no sorting/mapping; API order is final.
- Phase B (Telegram bot) will reuse the same URL and params.
