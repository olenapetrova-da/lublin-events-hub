# ADR-0014: Query API contract (params & response)
*Status:* Superseded
*Date:* 2025-11-12  
*Owner:* Apps Script Web App (`doGet(e)`)  
*Applies to:* LEHv1  
*Superseded by:* ADR-0015

(DB-based queries via n8n)

## Context
Telegram/Make should call a single endpoint and receive predictable JSON with pagination.

## Decision
- Implement `doGet(e)` over the **`events`** sheet with params:
  - `date` (YYYY-MM-DD), `period` = `day|week|range|weekend`, `days` (int, optional)
  - `payment` = `any|free|paid`
  - `category` = comma-separated (aliases allowed → mapped to canonicals)
  - `limit` (default 30), `offset` (default 0)
- Sort by `start_dt`, then `title`. Return:
```json
{
  "start": "YYYY-MM-DD",
  "end": "YYYY-MM-DD",
  "total": 0,
  "limit": 30,
  "offset": 0,
  "results": [
    {
      "event_id": "…",
      "title": "…",
      "start_dt": "…",
      "end_dt": "…",
      "venue": "…",
      "payment": "free|paid|unknown",
      "categories": "kids|workshop",
      "source": "lublin.eu",
      "url": "https://…"
    }
  ]
}
```

## Consequences
- Make per-request cost stays at 1 HTTP + 1 send.  
- API is stable for future UI/bot clients.

## Error handling
- If refresh failed, optionally include `"stale": true` in the payload and serve last good data.

## Status notes

- ADR-0013 refines this contract with explicit times joining and more detailed sorting and error behavior.
- For LEHv2, the Apps Script-based Query API is no longer used; queries are handled directly against Supabase via n8n.