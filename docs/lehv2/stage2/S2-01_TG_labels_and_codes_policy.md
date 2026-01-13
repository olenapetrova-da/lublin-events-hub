# S2-01 — Telegram labels & codes change policy (MVP)

This document defines what can be changed safely (without breaking Telegram buttons, n8n logic, or DB filters) vs what is **breaking** and requires a payload version bump.

Applies to Stage 2 Telegram UX + canonical DB model.

---

## Definitions

- **Label**: human-visible Polish text shown on a button or in a message (e.g., “Wybór okresu”, “Koncert”, “Pokaż więcej”).
- **Code**: a stable identifier used in payloads and internal logic (e.g., `theme=koncert`, `pay=free`, `lr=0`).
- **Payload**: Telegram inline keyboard `callback_data` string (e.g., `v2|set|theme=koncert`).
- **Version prefix**: `v2` — payload schema version. If codes/format change, bump to `v3` (or later) and keep compatibility if needed.

---

## Golden rules (read before changing anything)

1) **Labels may change; codes must not.**  
   Users see labels; automations parse codes.

2) **Do not embed “meaning” into labels.**  
   Meaning must live in codes and documented rules (this file + payload contract + UX spec).

3) **Keep payloads short.**  
   `callback_data` is limited to 64 bytes (Telegram constraint).

4) **If you need a new feature toggle, add a new code key/value** (like `lr=0|1`), do not overload existing codes.

---

## What is safe to change anytime

### 1) Polish labels (UI text)

You can change:
- button labels (Polish text)
- message text (prompts, errors, “brak wyników”, etc.)
- layout/order of buttons on keyboards

Safe *as long as*:
- `callback_data` strings stay identical
- the same button still triggers the same code path

Where labels live:
- `S2-01_Telegram_UX_MVP_spec_v3.md` (UX copy / structure)
- Telegram response templates in n8n (message text + keyboard labels)

### 2) Canonical theme display labels (DB/UI only)

You can change:
- `tags.label_pl` (e.g., show “Muzyka” or “Muzyka i taniec”)
- any UI label that represents a theme

Safe *as long as*:
- `tags.code` remains unchanged (payload-safe key)
- payloads keep using the same `theme=<code>` values

Example (safe):
- keep `tags.code = koncert`
- change label from “Koncert” to “Muzyka”

### 3) Threshold text / explanations

You can change explanatory text such as:
- “long‑running means ≥21 days”
- help messages describing filters

Safe *as long as*:
- the actual business rule in DB/query logic is updated consistently when you change the number

---

## What is breaking (avoid without a plan)

### 1) Changing payload structure or version prefix

Breaking examples:
- changing delimiter/shape: `v2|set|theme=koncert` → `set:theme=koncert`
- changing the prefix: `v2|...` → `v3|...` (without supporting v2)

Why breaking:
- old buttons in existing messages stop working
- n8n parsers/state logic fails

### 2) Changing codes used in payloads (keys or values)

Breaking examples:
- `theme=koncert` → `theme=muzyka`
- `pay=free` → `pay=bezplatne`
- `period=weekend` → `period=week_end`
- `lr=0/1` flipped meaning (see next section)

Why breaking:
- old callbacks still parse but now mean something else (silent wrong behavior)

### 3) Changing semantics of an existing code

Example:
- today `lr=0` means “exclude long‑running”
- later `lr=0` is changed to “include long‑running”

This is breaking-in-practice even if payload strings are unchanged, because users get unexpected results.

---

## Where to change what (MVP playbook)

### A) Theme labels (what users see)

To rename what the user sees (safe):
- update `tags.label_pl` in DB (seed or manual)
- update button label text in Telegram UI (UX spec / n8n)
- keep payload code `theme=<code>` unchanged

### B) Theme codes (what payloads send)

Do **not** change `tags.code` during MVP.  
If you must (later):
- bump payload version to `v3`
- support both versions in the bot for a transition period:
  - accept `v2|set|theme=koncert`
  - accept `v3|set|theme=muzyka`
  - map both to the same canonical DB filter

### C) Raw category mapping (source strings → canonical themes)

Where mapping lives:
- `tag_alias` maps `(source, raw_value) -> tag_id`
- `tag_unmapped` captures unknown `(source, raw_value)` including `__MISSING__`

Safe changes:
- adding new mappings into `tag_alias`
- enabling/disabling a mapping (`enabled` flag)

Potentially risky changes:
- deleting mappings (historical reproducibility)
- re-pointing an existing raw_value to a different tag (changes counts/results)

Recommended:
- prefer “disable old + add new” over editing in place if you need auditability

### D) Period / pay / navigation codes

These are **payload contract** codes, not DB tags:
- `period=today|tomorrow|weekend|week`
- `pay=all|free|paid|unknown`
- `nav=more|back|reset` (or your current nav scheme)

Safe:
- changing labels only

Breaking:
- changing any of these values without versioning/migration in bot logic

### E) Long-running switch (`lr`)

`lr` is a payload/state code:
- `lr=0` (default): exclude long‑running events
- `lr=1`: include long‑running events

Long‑running rule is a **business rule**:
- currently: `range_days >= 21`

Safe changes:
- changing the *label text* of the toggle button
- changing the *threshold* **only** if you also update:
  - DB logic (where `range_days` / `is_long_running` is computed)
  - query logic (S2‑03)
  - docs/tests

Breaking changes:
- flipping meaning of `lr=0/1`
- renaming `lr` to another key without supporting old buttons (requires version bump)

---

## Telegram `callback_data` size limit (64 bytes)

Telegram limits inline keyboard `callback_data` to **64 bytes**.

If you exceed it:
- Telegram can reject the keyboard
- or callbacks fail / are not delivered reliably

What to do:
- keep payloads short (codes, not labels)
- avoid URLs in callback_data
- avoid JSON in callback_data
- store large state in DB (`user_state`), not in payload

Good payload examples (short and stable):
- `v2|set|theme=wystawa`
- `v2|set|lr=1`
- `v2|nav|more`

Bad payload examples (too long / unstable):
- `v2|set|theme=Wycieczka po Starym Mieście w Lublinie` (label leak)
- `v2|run|search|url=https://...` (URL leak)
- `v2|run|search|{"period":"week","theme":"koncert","lr":0,...}` (JSON)

---

## Quick checklist before committing a change

1) Did you change only labels? → OK.
2) Did you change any payload value/key? → STOP, plan version bump.
3) Did you change tag codes (`tags.code`) or meanings? → STOP, plan version bump + compatibility.
4) Did you change taxonomy mapping (`tag_alias`)? → OK, but expect search results to change; keep notes in commit message.
5) Did you change long‑running threshold? → Update DB logic + query logic + docs/tests together.
