# ADR-0002: Category mapping in Sheets (not in Workers)
*Status:* Superseded 
*Date:* 2025-10-29  
*Applies to:* LEHv1
*Superseded by:* 

> LEHv2 note (2025-12):  
> For LEHv2 (n8n + Supabase), taxonomy mapping will no longer live in Google Sheets.
> This ADR is kept as history for the v1 implementation. A separate ADR will define
> taxonomy handling for the database / enrichment pipeline in LEHv2.

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
