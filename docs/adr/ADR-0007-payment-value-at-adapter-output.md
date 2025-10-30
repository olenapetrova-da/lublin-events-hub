# ADR-0007: Payment value at adapter output = Yes/No/""
*Status:* Accepted  
*Date:* 2025-10-30

## Context
Payment is often only reliable on the detail page. Sources use varied labels/phrases. We want a single adapter-level output format that Apps Script can normalize later.

## Decision
- **Adapter output for `Payment for Entry` must be**:
  - `"Yes"` for paid,
  - `"No"` for free,
  - `""` (empty string) if truly unknown after enrichment.
- Detection is **case-insensitive** and based on simple rules:
  - **Free → "No"** if text matches: `wstęp wolny|bezpłatn|darmow|gratis|free|nieodpłat`
  - **Paid → "Yes"** if text matches: `bilet|bilety|wejściów|opłata|cena|PLN|zł|(\d+[.,]?\d*\s*(zł|PLN))`
- **Conflict resolution** (both free and paid tokens appear):
  - If a numeric price is present → `"Yes"`.
  - Else prefer `"No"` when explicit free phrases like “wstęp wolny/bezpłatny” appear.
- Do **not** translate to `free/paid/unknown` in adapters; that remains in Apps Script.

## Compatibility & migration
- Apps Script (ADR-0005) will continue to normalize to `free|paid|unknown`.
- During migration, older payloads using “Bezpłatny/Płatny” are temporarily tolerated by normalization, but the target is **Yes/No/""** from all adapters.

## Consequences
- Single, predictable adapter output; easier testing.
- Normalization logic remains centralized in Apps Script.

## References
- ADR-0005 (raw → normalized model)
- ADR-0008 (enrichment fields)
