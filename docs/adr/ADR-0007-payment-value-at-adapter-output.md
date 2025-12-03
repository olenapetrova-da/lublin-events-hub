# ADR-0007: Payment value at adapter output = Yes/No/""

*Status:* Accepted  
*Date:* 2025-10-30  
*Applies to:* LEHv1, LEHv2

## Context

Payment is often only reliable on the detail page. Sources use varied labels/phrases. We want a single adapter-level output format that a downstream normalization layer can convert to canonical values. :contentReference[oaicite:8]{index=8}

## Decision

- **Adapter output for `Payment for Entry` must be**:
  - `"Yes"` for paid,
  - `"No"` for free,
  - `""` (empty string) if truly unknown after enrichment.
- Detection is **case-insensitive** and based on simple rules:
  - **Free → "No"** if text matches:  
    `wstęp wolny|bezpłatn|darmow|gratis|free|nieodpłat`
  - **Paid → "Yes"** if text matches:  
    `bilet|bilety|wejściów|opłata|cena|PLN|zł|(\d+[.,]?\d*\s*(zł|PLN))`
- **Conflict resolution** (both free and paid tokens appear):
  - If a numeric price is present → `"Yes"`.
  - Else prefer `"No"` when explicit free phrases like “wstęp wolny/bezpłatny” appear.
- Do **not** translate to `free/paid/unknown` in adapters; that remains in the **normalization layer**:
  - LEHv1: Apps Script `materialize()` writing to the `events` sheet.
  - LEHv2: ingestion/DB layer writing to PostgreSQL (`events` / `showtimes`).

## Compatibility & migration

- LEHv1: Apps Script (ADR-0005) normalizes to `free|paid|unknown`.
- LEHv2: the same mapping logic is applied in the ingestion workflow or in SQL when writing into Supabase.
- During migration, older payloads using “Bezpłatny/Płatny” can be tolerated temporarily, but the target remains **Yes/No/""** from all adapters.

## Consequences

- Single, predictable adapter output; easier testing.
- Normalization logic stays centralized and tool-agnostic (not in adapters).
