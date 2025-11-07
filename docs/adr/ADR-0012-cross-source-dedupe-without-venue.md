# ADR-0012: Cross-source dedupe fallback without venue
*Status:* Accepted  
*Date:* 2025-11-07

## Context
The Official list page does not expose Venue; Zoom does. Our primary hub dedupe uses title+date+time+venue and therefore misses cross-source duplicates when one side lacks Venue.

## Decision
Introduce a fallback merge applied only when one side has an empty Venue:
- **Date:** equal (YYYY-MM-DD).
- **Time:** overlaps — at least one identical `HH:MM` value (or within ±5 minutes).
- **Title/slug similarity:** either `title_norm` ≥ 0.92, **or** Jaccard of `_fp_url` slug tokens ≥ 0.70.
If satisfied, treat as the same event: keep a single row, **union** showtimes, prefer non-empty Payment, and prefer non-empty Venue (usually from Zoom). Keep a single `Source` using priority order (Zoom > Official).

## Consequences
- Cross-source duplicates are merged without enabling enrichment for Official.
- False-positive risk is low in Lublin’s context (same title+time on same date but different venues). If encountered, raise the thresholds or require both title **and** slug matches.

## Implementation notes
- `title_norm`: lowercase, strip punctuation/diacritics, collapse spaces.
- `_fp_url`: use the path after `/wydarzenie/` split into `[-a-z0-9]+` tokens.
- Time compare: parse `HH:MM` → minutes since midnight; overlap if |Δ| ≤ 5.
- Log merged pairs where Venue was missing on one side to a small debug array (optional export).

## References
- ADR-0011 (Hub ordering policy)
- ADR-0006/0008 (enrichment scope; enrichment stays off)
- ADR-0007 (Payment Yes/No/empty)
