# ADR-0002: Category mapping in Sheets (not in Workers)
*Status:* Accepted  
*Date:* 2025-10-29

## Context
Sources use inconsistent labels. Changing mappings shouldn’t require redeploying Workers or editing Make.

## Decision
- Workers output raw labels (`Category`/`Category_raw`).
- Canonicalization happens in Google Sheets using `taxonomy_map` and `taxonomy_alias`.
- Unrecognized labels append to `taxonomy_unmapped` for review.

## Consequences
- Faster maintenance (edit tables, not code).
- Workers remain simple and cheap.
- A small curation loop is required.
