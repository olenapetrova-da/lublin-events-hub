# S2-01 — Labels & codes change policy (MVP)

This document defines what can be changed safely (without breaking old inline buttons) vs what is **breaking** and requires a payload version bump.

## Definitions

- **Label**: human-visible Polish text shown on a button or in a message (e.g., “Wybór okresu”, “Muzyka”).
- **Code**: a stable identifier used in payloads and internal logic (e.g., `theme=muzyka`).
- **Payload**: Telegram inline `callback_data` string (e.g., `v2|set|theme=muzyka`).
- **Version prefix**: `v2` — used to keep backward compatibility when payload schemas evolve.

## What is safe to change anytime

### 1) Polish labels (UI text)
You can change:
- button labels (Polish text)
- message wording (welcome, guidance, “Brak wyników”, errors, etc.)
- button ordering

**Why it’s safe:** payloads remain the same; old buttons still send the same callback_data.

### 2) Canonical theme naming (display only)
You can rename what the user sees for themes by changing **display labels** in DB (recommended):
- change `tags.label_pl` for `kind='theme'`

Example:
- keep code: `theme=muzyka`
- change label: “Muzyka” → “Koncert”

**Result:** menus and printed categories change, while payloads remain valid.

## What is breaking (avoid without a plan)

### 1) Changing payload structure or prefix
Breaking examples:
- changing `v2|set|theme=muzyka` to `v2|set|theme|muzyka`
- changing keys/values (e.g., `pay=free` → `pay=bezplatne`)
- removing the `v2` prefix

**Impact:** old buttons already sent to users will stop working.

### 2) Changing codes used in payloads (keys/values)
Breaking examples:
- `theme=muzyka` → `theme=koncert` (without compatibility handling)
- `period=week` → `period=7days`

If you must change codes:
- either **support both** (accept old + new codes), OR
- **bump version prefix** (e.g., introduce `v3|...`) and keep `v2` handling for a transition period.

## Where to change what (recommended MVP approach)

### Theme labels
- Change: `public.tags.label_pl` (for `kind='theme'`)
- Do NOT change: `public.tags.code` (unless you plan a version bump or compatibility mapping)

### Period / navigation / non-tag labels
These labels are not stored as tags, so they are changed in the bot workflow templates:
- “Wybór okresu”, “Wstecz”, “Zacznij od nowa”, “Pokaż wyniki”, etc.

### Mapping raw categories to canonical themes
Use alias rules (DB taxonomy layer):
- `tag_alias` maps source `category_raw` → canonical theme tag (`tags.tag_id`)
- Keep unmapped values in `tag_unmapped` to review later

## Telegram `callback_data` size limit (64 bytes)

Telegram limits inline button `callback_data` to **64 bytes**. If you exceed it, Telegram will reject the keyboard or the callback will fail.

**What to do:**
- keep payloads short (codes, not labels)
- do NOT embed long texts, URLs, JSON objects, or lists of IDs inside payloads
- store any large state in DB (`user_state`, etc.), and let payloads be only a compact “command”

Example of good payload (short):
- `v2|set|theme=wycieczka`

Examples to avoid (too long / unstable):
- `v2|set|theme=Wycieczka po Starym Mieście w Lublinie`  (label leak)
- `v2|run|search|url=https://...`  (URL leak)
- `v2|run|search|{"period":"week","theme":"muzyka",...}` (JSON)

