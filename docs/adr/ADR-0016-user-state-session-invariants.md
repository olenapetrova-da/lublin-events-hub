**Status:** Accepted

**Date:** 2026-01-13

**Stage:** LEHv2 / Stage 2 (S2-02)

## Context

Stage 2 introduces a Telegram bot MVP with a button-only UX and a small per-chat state machine.

The UX/state contract is defined in:

- `docs/lehv2/stage2/S2-01_Telegram_UX_MVP_spec_v3.md`
- `docs/lehv2/stage2/S2-01_TG_payload_contract.md`
- `docs/lehv2/stage2/S2-01_TG_labels_and_codes_policy.md`

Upcoming work depends on stable, predictable state handling:

- **S2-03** DB queries for search + pagination
- **S2-04** WF-BOT-TG workflow structure

Two key risks to address early:

1. **Offset correctness:** any filter change must reset pagination.
2. **Midnight drift:** relative periods (today/week/weekend) can shift if a user paginates after midnight.

## Decision

We finalize `public.user_state` as the single source of truth for Telegram session state per chat:

### 1) chat_id type

- Keep `chat_id` as **text** (MVP-friendly; n8n payloads are strings; avoids bigint migration risk).

### 2) Stored state fields (codes)

Persist the UX contract codes directly (no UI labels stored):

- `step`: `main|period|theme|pay`
- `period`: `today|tomorrow|weekend|week` (nullable until selected)
- `theme`: `all|teatr|film|koncert|spotkanie|warsztat|wystawa|wycieczka|sport|inne`
- `pay`: `all|free|paid|unknown`
- `lr`: `0|1` (exclude long-running by default)
- `offset`: integer >= 0 (pagination offset)

### 3) Stable pagination via anchor_date

Add `anchor_date` (date) to freeze the “relative period” reference point.

- `anchor_date` is set to **Europe/Warsaw “today”** when `period` is chosen/changed.
- S2-03 queries must compute windows (today/week/weekend) relative to `anchor_date`, not `now()`.

### 4) DB-enforced invariants via trigger

Add a DB trigger on `user_state` to guarantee:

- `updated_at` is refreshed on every change.
- if any filter changes (`period`, `theme`, `pay`, `lr`) → `offset` resets to `0`.
- if `period` changes (or becomes non-null) and `anchor_date` is null → set `anchor_date` to Warsaw “today”.

This reduces workflow fragility (n8n can’t “forget” to reset offset / set anchor date).

### 5) Message editing is deferred

We do **not** store `last_bot_message_id` or other message-editing fields in S2-02.

We will document this as a future extension (can be added later without breaking query semantics).

## Consequences

### Benefits

- **Correct pagination by construction:** filter changes cannot accidentally keep an old offset.
- **Deterministic relative windows:** paging after midnight won’t shift results mid-session.
- **Simpler WF-BOT-TG logic:** n8n can upsert state with fewer “guardrail” branches.

### Costs / trade-offs

- Trigger introduces **implicit behavior**; must be documented and remembered during debugging.
- `anchor_date` adds one more concept to queries and testing.
- Keeping `chat_id` as text is slightly less strict than bigint, but safer for MVP.

## Alternatives considered

1. **No anchor_date (compute windows from now())**
- Rejected: results can shift after midnight; pagination becomes inconsistent.
1. **Handle invariants only in n8n**
- Rejected: too easy to miss a reset/update path; DB should protect correctness.
1. **Use bigint chat_id**
- Deferred: valuable long-term, but not worth migration risk during MVP.
1. **Store message IDs for editing**
- Deferred: not needed for MVP (we send new messages); can be added later as optional columns.

## Implementation notes (S2-02)

- Add/rename columns to align with contract naming (`theme`, `pay`, `lr`, `offset`).
- Add CHECK constraints for allowed codes and `offset >= 0`.
- Implement a trigger function (BEFORE INSERT/UPDATE) to enforce the invariants above.
- Update:
    - `docs/lehv2/stage2/LEHv2_DB_schema_S2.md` (user_state + design notes)
    - Stage 2 ERD diagram (`docs/lehv2/stage2/diagrams/S2-01_Telegram_UX-and-ERD.drawio.xml`)