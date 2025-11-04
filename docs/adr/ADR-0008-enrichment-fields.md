# ADR-0008: Enrichment fields (what adapters may fill)
*Status:* Accepted  
*Date:* 2025-10-30

## Context
List pages often miss reliable values found on detail pages. We want better data with minimal cost and without moving taxonomy into code.

## Decision
Adapters MAY enrich the following when `enrich=1` (capped by `enrich_max`):
- **Payment for Entry** — authoritative value if available on detail (see ADR-0007).
- **Time / time range** — fill or refine when list lacks/omits it.
- **Venue** — fill/normalize obvious venue name when missing on list.

Adapters MUST NOT:
- Perform **taxonomy/canonical category mapping** (that stays in Sheets).
- Do heavy multi-hop crawling or spend requests just for images.

## Notes
- Image URL may be passed through if trivially available on list; do not trigger enrichment solely for images (images are excluded from the normalized `events` table).
- If a detail fetch fails, keep list values and continue.

## Consequences
- Consistent, bounded enrichment close to sources.
- Taxonomy stays table-driven; no redeploy for label changes.

## References
- ADR-0002 (taxonomy in Sheets)
- ADR-0006 (location & limits)
- docs/specs/sources/zoom-lublin.md
