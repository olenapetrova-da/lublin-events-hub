# ADR-0004: Use hub JSON mode (`sheet=0`) for refresh
*Status:* Accepted  
*Date:* 2025-10-29

## Context
The hub supports two modes: `sheet=1` (row output) and `sheet=0` (JSON `events[]`). JSON includes helper fields like `_EndDate` and keeps values closer to the source.

## Decision
- Call the hub with `sheet=0` and `group_times=1` for a 7‑day window.  
- Apps Script parses the returned `events[]` and writes the **staging** sheet `raw_events` with 10 columns:  
  `Title, Date, Time, Venue, Category, Link, Payment for Entry, Source, _EndDate`.  
- If `_EndDate` is missing for a source, default it to `Date`.

## Consequences
- We retain `_EndDate` for multi-day events.  
- We avoid premature formatting to row strings.  
- Normalization and mapping happen in Apps Script with full control.

## Alternatives considered
- `sheet=1` row mode (rejected): drops `_EndDate` and constrains formatting.  
- Per‑source Workers writing directly to Sheets (rejected for now): more moving parts.
