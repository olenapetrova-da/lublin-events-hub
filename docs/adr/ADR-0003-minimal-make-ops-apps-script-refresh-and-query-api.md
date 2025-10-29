# ADR-0003: Minimal Make ops; Apps Script refresh + Query API
*Status:* Accepted  
*Date:* 2025-10-29
> See also: [Architecture — Minimal Make Ops](../architecture/overview-minimal-make-ops.md)


## Context
Make free-tier operations are limited. We already have source adapters and a hub that can return JSON (`sheet=0`). We need daily refresh without Make ops, and a cheap per-request path.

## Decision
- **Daily refresh in Apps Script**: `refresh()` calls the hub once for a 7‑day window (JSON mode), writes `raw_events`, then runs `materialize()` to build `events`.
- **Serve requests via Apps Script Web App**: `doGet(e)` filters/paginates `events` and returns JSON to Telegram/Make.
- Make is used only for the chat flow: parse text → 1 HTTP → send message.

## Consequences
- **0 Make ops/day** for refresh.  
- **Per request**: 1 HTTP + 1 send message.  
- Hub remains unchanged; we keep `_EndDate` from JSON.  
- Logic lives in Sheets/Apps Script where it’s easy to maintain.

## Alternatives considered
- Refresh via Make (rejected: burns ops).  
- Emit sheet rows from hub (`sheet=1`) and skip Apps Script normalization (rejected: less flexible; loses `_EndDate` origin).

## Status notes
This ADR is the umbrella decision. Detailed contracts and data shapes are defined in ADR‑0004/0005/0014.
