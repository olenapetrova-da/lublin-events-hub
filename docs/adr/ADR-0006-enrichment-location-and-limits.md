# ADR-0006: Enrichment location & limits (adapters only)
*Status:* Accepted  
*Date:* 2025-10-30

## Context
Each source (e.g., lublin.eu, zoom.lublin.pl) has a list page (limited fields) and a detail page (richer fields). We want to fill missing values without adding Make ops and keep taxonomy outside of code.

## Decision
- **Only per-source adapters perform optional enrichment** when `enrich=1`, capped by `enrich_max` (default 15).
- **Hub**: orchestrate + merge + dedupe only (no enrichment).
- **Apps Script**: persist **and normalize** (category mapping via Sheets, payment normalization, IDs).

## Implementation notes
- **Parameters**: `enrich=1` enables detail fetch; `enrich_max=<int>` caps detail page requests per run.
- **Network/limits**: max one request per detail page; stop at `enrich_max`; reasonable timeout; if a detail fetch fails, keep list values and continue.
- **What to enrich** is defined in ADR-0008 (keep field-level rules out of 0006).

## Consequences
- Consistent behavior across sources.
- Compute stays close to each source; zero Make ops added.
- Taxonomy remains table-driven in Sheets; no redeploys for label changes.

## References
- ADR-0008 (enrichment fields)
- ADR-0009 (_EndDate & Source)
- ADR-0002 (taxonomy in Sheets)
- ADR-0005 (raw → normalized model)
- docs/specs/sources/zoom-lublin.md
