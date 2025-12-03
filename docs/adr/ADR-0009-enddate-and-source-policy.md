# ADR-0009: _EndDate and Source policy

*Status:* Accepted  
*Date:* 2025-10-30  
*Applies to:* LEHv1, LEHv2

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
- Source filters remain simple and stable. :contentReference[oaicite:8]{index=8}

## LEHv2 note (2025-12)

- The policy that **every record must have `_EndDate`** and that **`Source` is the hostname** remains valid.
- In LEHv2, the `_EndDate` defaulting rule moves from Apps Script into the **ingestion workflow (n8n / Supabase)**, but the behaviour is the same.
