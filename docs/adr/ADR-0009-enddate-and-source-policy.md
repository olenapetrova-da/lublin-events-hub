# ADR-0009: _EndDate and Source policy
*Status:* Accepted  
*Date:* 2025-10-30

## Context
Multi-day events need an end date; clients also need a consistent source identifier.

## Decision
- **_EndDate** must be present for every raw row.
  - If the adapter/hub provides `_EndDate`, pass it through.
  - If missing, **default `_EndDate = Date` in Apps Script** during `refresh()`.
- **Source** value must be the plain **hostname** only (e.g., `lublin.eu`, `zoom.lublin.pl`).

## Rationale
Defaulting `_EndDate` in Apps Script reduces adapter complexity and keeps a single rule for all sources.

## Consequences
- All rows are safe to normalize into `events` without special-casing.
- Source filters remain simple and stable.

## References
- ADR-0004 (hub JSON mode for refresh)
- ADR-0005 (raw → normalized model)
- ADR-0006 (location & limits)
