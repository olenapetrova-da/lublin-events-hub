# WF-BOT-TG design (S2)

**Stage:** LEHv2 / Stage 2

**Task:** S2-04 — Design WF-BOT-TG structure

**Purpose:** define the n8n workflow structure as a small, deterministic state machine for the Telegram bot MVP.

---

## Scope

WF-BOT-TG must:

- handle `/start` and button clicks
- show menus (period/theme/pay) and a main summary screen
- run the event search query (S2-03 Query A) and render results
- paginate (“Pokaż więcej”), go back to main (“Wstecz”), reset (“Zacznij od nowa”)
- keep per-chat session state in `public.user_state` (single source of truth)

Out of scope (MVP):

- free-text search
- message editing (we send new messages)
- personalization beyond current state per chat

---

## Dependencies (source of truth)

- UX state-machine contract: `S2-01_Telegram_UX_MVP_spec_v3.md`
- Payload contract (inline keyboard codes): `S2-01_TG_payload_contract.md`
- Labels vs codes change policy: `S2-01_TG_labels_and_codes_policy.md`
- DB invariants / trigger behavior: `ADR-0016-user-state-session-invariants.md`
- Schema reference: `LEHv2_DB_schema_S2.md`
- Search query contract: `S2-03_DB_queries_for_event_search.md` + `db/queries/s2_03_tg_event_search.sql`

---

## Key decisions for MVP

1. **Inline keyboards are the standard UI**
    
    Buttons carry stable `callback_data` payloads (`v2|...`). Reply keyboards are not used for menus.
    
2. **Callback clicks are acknowledged**
    
    When an update contains `callback_query`, WF-BOT-TG calls **Answer Callback Query**.
    
3. **DB is the single source of truth for state**
    
    WF-BOT-TG writes state to `public.user_state` and always uses the **row returned from the DB** after a write.
    
4. **No message editing**
    
    WF-BOT-TG sends new messages only (no stored `message_id` in MVP).
    

---

## Telegram updates: `message` vs `callback_query`

Telegram delivers “updates” of different kinds. WF-BOT-TG must handle at least:

### `message`

Sent when the user types and sends text (including `/start`), or uses a reply keyboard (if one exists).

- data path: `message.chat.id`, `message.text`

### `callback_query`

Sent when the user clicks an **inline keyboard** button attached to a bot message.

- data path: `callback_query.message.chat.id`, `callback_query.data`, `callback_query.id`
- `callback_query.data` is the payload (e.g. `v2|set|theme=film`)
- `callback_query.id` is required for “Answer Callback Query”

### Why “Answer Callback Query”

Inline button clicks create a client-side “waiting” feeling until the bot acknowledges the click. Calling “Answer Callback Query” reliably clears that UX and prevents “stuck click” perception.

---

## Workflow invariant: normalize first

Immediately after trigger, map the incoming update into a minimal internal contract:

- `chat_id_text` (string; required)
- `action_raw` (string; payload from `callback_query.data` or message text)
- `update_kind` (`callback` or `message`)
- `callback_query_id` (string; present only for `callback`)

Precedence rules:

- if `callback_query` exists → use it
- else fallback to `message`

---

## DB invariants (must be assumed)

`public.user_state` is written by WF-BOT-TG and protected by DB constraints + trigger.

### Stored fields are codes (not labels)

Persist only:

- `step`: `main|period|theme|pay`
- `period`: `today|tomorrow|weekend|week` (nullable until chosen)
- `theme`: `all|teatr|film|koncert|spotkanie|warsztat|wystawa|wycieczka|sport|inne`
- `pay`: `all|free|paid|unknown`
- `lr`: `0|1`
- `"offset"`: integer >= 0
- `anchor_date`: date (nullable if `period` is null)

### Trigger behavior (critical)

- any change to (`period`, `theme`, `pay`, `lr`) ⇒ `"offset"` becomes `0`
- when `period` changes:
    - set `anchor_date` to Warsaw “today”
    - if `period` cleared ⇒ clear `anchor_date`
- `updated_at` refreshes on every change

### Workflow rule (non-negotiable)

After any state write:

- **use UPSERT … RETURNING *** (preferred)
- then use the **returned** values of `"offset"` and `anchor_date`
- never reuse cached `"offset"` or cached `anchor_date`

This prevents the classic bug: workflow thinks offset is 20, but DB reset it to 0.

---

## Search query interface (S2-03 Query A)

WF-BOT-TG uses `db/queries/s2_03_tg_event_search.sql` Query A.

### Inputs

- `$1` = `chat_id` (text)
- `$2` = `page_size` (int) → **10** for MVP

### Outputs

- `event_id`
- `date`
- `title_display`
- `times_text`
- `venue_best`
- `primary_url`
- `has_more` (boolean; repeated on each row)

Behavior notes:

- `has_more` is computed via overfetch (page_size + 1)
- if query returns **0 rows**, WF-BOT-TG treats `has_more = false`

Ordering is deterministic and matches UX:

- date asc, earliest_time asc (nulls last), title asc, event_id asc

---

## High-level node topology

Conceptual pipeline (n8n node names can vary):

1. **Telegram Trigger** (must deliver both `message` and `callback_query`)
2. **Normalize Update** (produce `chat_id_text`, `action_raw`, `update_kind`, `callback_query_id`)
3. **If update_kind=callback → Answer Callback Query**
4. **Parse Action** (classify `action_raw` → action type + key/value)
5. **Router** (switch by action type)
6. **State Write (UPSERT…RETURNING *)** when state changes
7. **Event Query (S2-03 Query A)** only when results needed
8. **Format Message + Build Inline Keyboard**
9. **Send Message** (new message)


---

## Action parsing rules

### Recognized actions

- `/start` (or “start” command handling if desired) → treated as `start`
- payloads beginning with `v2|`:
    - `v2|menu|<name>`
    - `v2|set|<key>=<value>`
    - `v2|run|search`
    - `v2|nav|<flag>` where flag is `more|back|reset`

### Invalid / stale inputs

If `action_raw` is not `/start` and does not match the payload contract:

- do **not** mutate state
- reply “Nie rozumiem…” and show keyboard for **current state** (fallback: main)

This applies to:

- free text at any screen
- old inline buttons from earlier versions (not starting with `v2|`)
- malformed payloads

---

## State write pattern (UPSERT + RETURNING)

WF-BOT-TG uses one logical “state write” operation:

- upsert by `chat_id`
- update only relevant columns for the action
- read back the entire row via `RETURNING *`

### Who is allowed to set `"offset"`

Only these actions set `"offset"` explicitly:

- pagination: `v2|nav|more` → `"offset" = "offset" + 10`
- navigation: `v2|nav|back` → `"offset" = 0`
- resets: `/start` and `v2|nav|reset` → `"offset" = 0`

Filter changes (`period/theme/pay/lr`) must **not** set `"offset"` in the workflow (DB trigger will reset it anyway).

---

## Screen model and keyboards

WF-BOT-TG renders these screens:

- Main menu (`step=main`)
- Period menu (`step=period`)
- Theme menu (`step=theme`)
- Pay menu (`step=pay`)
- Results (>=1 row)
- End-of-list (no more results)
- Zero results
- Invalid/stale fallback

Button payloads are defined by `S2-01_TG_payload_contract.md`. WF-BOT-TG must never invent new codes during MVP.

---

## Action matrix (payload → DB write → next screen)

Page size constant:

- `PAGE_SIZE = 10`

### `/start`

DB write:

- set: `step='main'`
- clear: `period=NULL`, `anchor_date=NULL`
- set defaults: `theme='all'`, `pay='all'`, `lr=0`, `"offset"=0`
    
    Next screen:
    
- Main menu (period missing guidance, no “Pokaż wyniki”)

**Implementation note (current WF-BOT-TG): two main menu variants**

- `/start` renders a “welcome” main menu variant (minimal text/buttons) used only immediately after `/start` and `v2|nav|reset`.
- After any other action (set period/theme/pay/lr, nav back, run search stub), WF-BOT-TG renders a “settings main menu” variant that:
  - shows selected filters (Okres, Kategoria, Płatność, Długoterminowe)
  - shows “Pokaż wyniki” only if `period` is set
  - includes the long-running toggle with label depending on `lr`


### `v2|menu|period`

DB write: `step='period'`

Next: Period menu

### `v2|menu|theme`

DB write: `step='theme'`

Next: Theme menu

### `v2|menu|pay`

DB write: `step='pay'`

Next: Pay menu

### `v2|set|period=<code>`

DB write:

- set: `period=<code>`
- set: `step='main'`
- do not set `"offset"` (DB trigger resets)
- anchor_date handled by trigger
    
    Next: Main menu (now “Pokaż wyniki” is available)
    

### `v2|set|theme=<code>`

DB write:

- set: `theme=<code>`
- set: `step='main'`
- do not set `"offset"` (DB trigger resets)
    
    Next: Main menu
    

### `v2|set|pay=<code>`

DB write:

- set: `pay=<code>`
- set: `step='main'`
- do not set `"offset"` (DB trigger resets)
    
    Next: Main menu
    

### `v2|set|lr=0|1`

DB write:

- set: `lr=<0|1>`
- set: `step='main'`
- do not set `"offset"` (DB trigger resets)
    
    Next: Main menu (toggle label flips)
    

### `v2|run|search` 

- DB write: **ensure row exists + set `step='main'` only** (do not touch filters/offset)
- If `period` is NULL → main menu with guidance
- Else → execute **Query A** (page_size=10) via **wrapper** (returns 1 row with `rows`, `row_count`, `has_more`)
- Render:
    - `row_count=0` → Zero Results screen
    - `row_count>0` → Results screen
    - If `has_more=false` → append footer: `To już wszystkie wyniki. Zmień filtry albo zacznij od nowa.`

**Why wrapper exists**: n8n Postgres node returns **0 items** when SQL returns 0 rows; wrapper forces 1-row output with JSON rows.

### `v2|nav|more`

DB write:

- `"offset" = "offset" + PAGE_SIZE`
- keep filters as-is
    
    Then:
    
- run S2-03 Query A (using returned `"offset"` + `anchor_date`)
    
    Next:
    
- Results if rows exist
- End-of-list if no rows (or if previous page had has_more=false and user still clicked)

### `v2|nav|back`

DB write:

- `step='main'`
- `"offset"=0` (explicit; required by UX)
    
    Next: Main menu (filters preserved)
    

### `v2|nav|reset`

DB write: same as `/start`

Next: Main menu

### Invalid / stale action (any step)

DB write: none

Next: “Nie rozumiem…” + keyboard for current step (fallback: main)

---

## Message formatting rules

### Results line format

One event per line:

- `YYYY-MM-DD — <title_display> — <times_text> — <venue_best>`

Omission rules:

- if `times_text` is null/empty → show a placeholder dash for that segment
- if `venue_best` is null/empty → omit the venue segment entirely

### Results screen keyboards

- show `Pokaż więcej` only if `has_more=true`
- always show `Wstecz` and `Zacznij od nowa`

### End-of-list

Text: `To już wszystkie wyniki. Zmień filtry albo zacznij od nowa`.

Keyboard: `Wstecz`, `Zacznij od nowa`

### Zero results

Text: `Brak wyników. Zmień filtry albo zacznij od nowa`.

Keyboard: period/theme/pay menus + reset

---

## Error handling and safety rails

- If `user_state` row does not exist for a chat:
    - treat as `/start` (create defaults) and show main menu
- If DB write fails:
    - respond with a generic error + offer reset button
- If query runs while period is missing:
    - return 0 results; main menu should guide the user to pick a period first
- Never parse meaning from Polish labels; meaning lives in codes (`v2|...`)

---

## Acceptance tests (workflow-level)

Must pass these manual scenarios:

1. `/start` resets state and shows main menu with period missing guidance.
2. Select theme first → returns to main menu; period still missing; guidance remains.
3. Set period=week → main menu shows “Pokaż wyniki”.
4. Toggle long-running twice → `lr` flips; trigger resets `"offset"` to 0; button label flips.
5. Run search with only period set → results shown (or zero-results if none).
6. Pagination: “Pokaż więcej” increases `"offset"` by 10; results change.
7. After paging, press “Wstecz” → main menu, `"offset"` becomes 0, filters preserved.
8. Zero results → zero-results screen and its 4 buttons.
9. Invalid payload or free text at any step → “Nie rozumiem…” + keyboard for current state; state unchanged.
10. Offset correctness simulation:
- precondition: `user_state.offset = 20`
- action: press `v2|set|theme=<any>`
- expected: workflow uses `"offset"=0` returned from DB (not cached 20) for any subsequent query.
1. Callback acknowledgment:
- any inline button click triggers Answer Callback Query (no “stuck click” UX).