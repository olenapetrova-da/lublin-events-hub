# Events DB Schema — v3 (2025-10-28)

Aligned to your current Google Sheet “Lublin Events Database”. This replaces v2.

## Sheets and columns

### 1) raw_events
Raw, source-level fields before mapping/dedup.
| # | Column              | Type / Format                       | Notes |
|---|---------------------|-------------------------------------|-------|
| 1 | Title               | string (required)                   | As on source page |
| 2 | Date                | date `YYYY-MM-DD` (required)        | Start date |
| 3 | Time                | text                                | `HH:MM` or `HH:MM–HH:MM`; may be empty |
| 4 | Venue               | string                              | Raw venue/place |
| 5 | Category_raw        | string                              | Raw label; if multiple, separate with `|` |
| 6 | Link                | url                                 | Canonical detail page |
| 7 | Payment for Entry   | enum `Yes` \| `No` \| `Unknown`   | Parsed from source (“Bezpłatny” ⇒ `No`) |
| 8 | Source              | string (required)                   | e.g., `lublin.eu`, `zoom.lublin.pl` |
| 9 | End Date            | date `YYYY-MM-DD`                   | For multi-day events; else empty |

### 2) events
Normalized, deduped table used by the bot/UI.
| # | Column              | Type / Format                       | Notes |
|---|---------------------|-------------------------------------|-------|
| 1 | Title               | string (required)                   | Title after normalization |
| 2 | Date                | date `YYYY-MM-DD` (required)        | Start date |
| 3 | Time                | text                                | `HH:MM` or `HH:MM–HH:MM`; may be empty |
| 4 | Venue               | string                              | Normalized venue if enriched |
| 5 | Category            | string (canonical)                  | From mapping/alias; single value |
| 6 | Link                | url                                 | Detail page |
| 7 | Payment for Entry   | enum `Yes` \| `No` \| `Unknown`   | |
| 8 | Source              | string (required)                   | Original source id |
| 9 | End Date            | date `YYYY-MM-DD`                   | If multi-day |

### 3) taxonomy_map
| Column        | Type     | Notes |
|---------------|----------|-------|
| source        | string   | Source id (`lublin.eu`, `zoom.lublin.pl`) |
| source_key    | string   | Optional key/id from the source |
| source_label  | string   | The label as shown on the source |
| match_type    | enum     | `exact` \| `contains` \| `regex` |
| canonical     | string   | Canonical category (e.g., `kids`, `music`) |
| notes         | string   | Free text |

### 4) taxonomy_alias
| Column   | Type   | Notes |
|----------|--------|-------|
| alias    | string | Alternative form (e.g., `dla dzieci`) |
| canonical| string | Canonical category (e.g., `kids`) |

### 5) taxonomy_unmapped
| Column    | Type     | Notes |
|-----------|----------|-------|
| source    | string   | Source id |
| raw_label | string   | Unrecognized label |
| count     | integer  | Times seen |

## Conventions
- **Dates:** ISO `YYYY-MM-DD`.  
- **Payment for Entry:** `Yes` (paid), `No` (free), `Unknown` (not found).  
- **Category_raw:** multiple values separated by `|` when a source shows several tags.  
- **Category (canonical):** single value after mapping/alias. Keep the canonical set small and stable.
- **Sheet names:** keep as you have now. If you later rename `Taxonomy_alias` → `taxonomy_alias`, update scripts accordingly.

## Minimal canonical categories (example)
Adjust to your needs; derive from your current mapping tables:
`kids`, `workshop`, `music`, `theatre`, `film`, `art`, `education`, `lecture`, `sport`, `festival`, `community`.

## Pipeline expectation
- **Workers** write to `raw_events` (use `Category_raw` and raw venue).  
- **Apps Script** maps categories using `taxonomy_map` and `taxonomy_alias`, dedupes, and writes to `events`.  
- **Unmapped labels** append rows to `taxonomy_unmapped` for review.

## Change log
- v3: Align with actual sheets, split `Category_raw` vs `Category`, formalize payment enum.
