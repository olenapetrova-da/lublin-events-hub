# S2-10 — Bot MVP manual test checklist (Stage 2)

This document is the **manual E2E test record** for the LEHv2 Telegram bot MVP (WF-BOT-TG) on Stage 2 DB.

> Goal: confirm the bot’s end-to-end UX, pagination, and state invariants after UAT changes.

---

## Test run metadata

- **Run date:** 2026-02-05 
- **Repo / commit tested:** `aec2047` 
- **n8n:** Cloud Starter, `n8n@2.4.8` 
- **Telegram bot:** `@LEHv2_bot` 
- **DB:** Supabase Postgres *(project: Lublin-Events-Hub / env: main)*

### Preconditions

1) WF-INGEST has run at least once for the target date window.
2) `public.user_state` exists with triggers/invariants enabled (offset resets on filter change, anchor_date freeze on period change).
3) You have at least:
   - one **FREE** event (events.pay_best = `free`)
   - some **UNKNOWN** events (events.pay_best = `unknown`)
4) WF-BOT-TG is active and connected to the correct Supabase credentials + Telegram credentials.

### Evidence (optional)
- Screenshots / screen recordings:
  - `link1: ...`
  - `link2: ...`
- Notes:
  - ...

---

## Summary result

- Overall: ☐ PASS  ☐ FAIL
- If FAIL: list blocking issues + links to the tracked bug(s).

---

## Scenarios

> Conventions:
> - “Step2” = the filters/settings screen that includes toggles + “Pokaż wyniki”.
> - Page size = 10.
> - “More” = `v2|nav|more`
> - “Back/Change filters” = `v2|nav|back`

### S2-10-01 — Zero results

**Purpose:** bot shows “Brak wyników” screen (no crash), with correct keyboard.

**Steps**
1) `/start`
2) Select a period (e.g., `Tydzień`)
3) Set filters to a combination that is known to produce zero results (e.g., choose a niche category + Free only).
4) Tap **Pokaż wyniki**

**Expected**
- Bot sends a “Brak wyników …” message.
- Keyboard includes:
  - **Zmień kategorię** (menu/theme)
  - **Zmień filtry** (nav/back)
- Callback clicks are acknowledged (no Telegram spinner stuck).

**Result:** ☐ PASS ☐ FAIL  
**Notes:**
- ...

---

### S2-10-02 — One page of results (no “More”)

**Purpose:** when `has_more=false`, “Pokaż więcej” is not shown.

**Steps**
1) `/start`
2) Choose period + filters that reliably return **1–10** results.
3) Tap **Pokaż wyniki**

**Expected**
- Bot prints results lines (>=1).
- Keyboard includes **Zmień filtry**.
- Keyboard does **not** include **Pokaż więcej**.
- Formatting sanity:
  - FREE events end with `💳 Bezpłatne`
  - UNKNOWN events end with `💳 Sprawdź płatność`

**Result:** ☐ PASS ☐ FAIL  
**Notes:**
- ...

---

### S2-10-03 — Multiple pages (pagination)

**Purpose:** “More” loads the next page, updates offset via DB, and eventually stops.

**Steps**
1) `/start`
2) Choose a period + filters that return **>10** results.
3) Tap **Pokaż wyniki**
4) Tap **Pokaż więcej** repeatedly until end-of-list.

**Expected**
- Page 1 shows results + **Pokaż więcej** + **Zmień filtry** (if `has_more=true`).
- Each “More” shows a new page (different rows), not a duplicate of the prior page.
- On the final page:
  - if `has_more=false`, keyboard does not show “More”.
  - if user taps an older “More” button (stale), bot should **not** send an empty results message (see scenario S2-10-07).

**Result:** ☐ PASS ☐ FAIL  
**Notes:**
- ...

---

### S2-10-04 — Back + change filters mid-session

**Purpose:** going back does not preserve stale offsets; changing filters resets offset to 0.

**Steps**
1) `/start`
2) Set period + filters to get multiple pages.
3) Tap **Pokaż wyniki**
4) Tap **Pokaż więcej** at least once (so offset > 0).
5) Tap **Zmień filtry**.
6) Change any filter (theme OR pay toggle OR lr toggle).
7) Tap **Pokaż wyniki** again.

**Expected**
- After any filter change, next results start from page 1 (offset=0), not from the previous offset.
- Workflow uses DB RETURNING values (no cached offset behavior).
- No duplicate Step2 messages.

**Result:** ☐ PASS ☐ FAIL  
**Notes:**
- ...

---

### S2-10-05 — Pay toggle (All ↔ Free)

**Purpose:** pay toggle flips state and affects results.

**Steps**
1) `/start`
2) Choose a period with mixed FREE + UNKNOWN events.
3) On Step2, toggle pay to **Free only**.
4) Tap **Pokaż wyniki**.
5) Go back, toggle pay to **All**, run search again.

**Expected**
- With **Free only**, results contain only events with `pay_best=free`.
- With **All**, results include FREE and UNKNOWN.
- Toggling pay updates button label accordingly.
- Offset resets to 0 on each toggle.

**Result:** ☐ PASS ☐ FAIL  
**Notes:**
- ...

---

### S2-10-06 — Long-running toggle (lr 0 ↔ 1)

**Purpose:** long-running toggle flips state and affects results.

**Steps**
1) `/start`
2) Choose a period likely to include long-running events.
3) Run search with default lr=0.
4) Go back, toggle lr=1, run search again.

**Expected**
- lr=1 results set is a superset (or at least includes events excluded by lr=0 when applicable).
- Toggle label changes appropriately.
- Offset resets to 0 on toggle.

**Result:** ☐ PASS ☐ FAIL  
**Notes:**
- ...

---

### S2-10-07 — Stale “More” on last page (no empty page)

**Purpose:** bot does not send an “empty results page” message when user presses “More” after end.

**Steps**
1) Produce a multi-page result set.
2) Navigate to the last page (where there is no “More”).
3) Scroll up and tap **Pokaż więcej** on an earlier message (stale keyboard), or double-tap quickly on “More”.

**Expected**
- Bot should **not** send a new empty results message.
- Bot should show a callback toast like “To już koniec.” (or equivalent).
- Offset should not remain overshot (if rollback implemented).

**Result:** ☐ PASS ☐ FAIL  
**Notes:**
- ...

---

## Post-test notes / follow-ups

- Open issues created (links):
  - ...
- Suggested improvements (non-blocking):
  - ...
