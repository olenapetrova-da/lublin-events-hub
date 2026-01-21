# S2-01 — Telegram UX flow (MVP)

Context: LEHv2 Stage 2 — Telegram bot MVP on PostgreSQL + n8n (button-only, Polish UI).

This document is the **UX/state-machine contract** for the bot.
Implementation details (n8n modules, SQL, etc.) are out of scope here.

---

## Scope

Users can:
- start the bot (`/start`)
- choose **Okres** (required): Dziś / Jutro / Weekend / Tydzień
- optionally choose **Kategoria** (theme): Wszystkie, Teatr, Film, Koncert, Spotkanie, Warsztat, Wystawa, Wycieczka, Sport, Inne
- optionally choose **Płatność**: Wszystkie / Bezpłatne / Płatne / Nieznane
- optionally toggle **Długoterminowe** (long‑running events): *excluded by default*
- run search (“Pokaż wyniki”)
- page results (“Pokaż więcej”)
- go back to main menu (“Wstecz”)
- restart flow (“Zacznij od nowa”)

Out of scope:
- free-text search
- personalization
- remembering filters across long time (beyond the current chat session)
- LLM enrichment

---

## State model

Stored per chat/user (eventually in `user_state`):

- `step`: `main|period|theme|pay`
- `period` (required): `today|tomorrow|weekend|week`
- `theme` (optional): `all|teatr|film|koncert|spotkanie|warsztat|wystawa|wycieczka|sport|inne`
- `pay` (optional): `all|free|paid|unknown`
- `lr` (optional): `0|1`
  - `0` (default): exclude long‑running events (`range_days >= 21`)
  - `1`: include long‑running events
- `offset` (int): pagination offset, default `0`

Rules:
- Changing any filter (`period`, `theme`, `pay`, `lr`) resets `offset` to `0`.

---

## Screens and keyboards

### 1) Main menu (step=`main`)

**Text content (example; exact wording can vary):**
- shows selected filters (Okres, Kategoria, Płatność, Długoterminowe)
- if `period` is missing: guidance “Najpierw wybierz okres”
- if `period` is present: show “Pokaż wyniki”
- The first screen after `/start` may be a simplified “welcome” variant; after any filter change or navigation, the main menu should still reflect the current filter state and conditional “Pokaż wyniki” rule.


Buttons (order can vary):
- Wybór okresu
- Wybór kategorii
- Wybór płatności
- Długoterminowe (toggle):
  - if `lr=0` show button “Pokaż długie”
  - if `lr=1` show button “Ukryj długie”
- Pokaż wyniki *(only if period is set)*
- Zacznij od nowa

### 2) Period menu (step=`period`)
Buttons:
- Dziś
- Jutro
- Weekend
- Tydzień
- Wstecz

### 3) Theme menu (step=`theme`)
Buttons:
- Wszystkie
- Teatr / Film / Koncert / Spotkanie / Warsztat / Wystawa / Wycieczka / Sport / Inne
- Wstecz

### 4) Pay menu (step=`pay`)
Buttons:
- Wszystkie
- Bezpłatne
- Płatne
- Nieznane
- Wstecz

---

## Search result screens

### A) Results (has at least 1 event)

The bot prints a list of canonical events (one line per canonical event):
- format: `YYYY-MM-DD — <title> — <times_text> — <venue_if_any>`
- ordering: date asc, earliest_time asc (NULL last), title asc

Keyboard:
- Pokaż więcej *(only if there are more results)*
- Wstecz
- Zacznij od nowa

### B) End of list (no more results)
Text: “To już wszystkie wyniki.”
Keyboard:
- Wstecz
- Zacznij od nowa

### C) Zero results
Text: “Brak wyników…”
Keyboard:
- Wybór okresu
- Wybór kategorii
- Wybór płatności
- Zacznij od nowa

---

## Behavioral rules (important edge cases)

- Weekend requested on Sunday → uses **next** Sat+Sun (not the current day).
- Week window equals today..today+6.
- Any invalid/stale callback → “Nie rozumiem…” + keyboard for current state; state unchanged.
- Free text at any step → “Nie rozumiem…” + keyboard for current state; state unchanged.

---

## Acceptance checks (manual)

1) `/start` resets state and shows main menu (Okres missing, guidance present, no “Pokaż wyniki”).
2) Select Theme first → returns to main menu; Okres still missing; guidance remains.
3) Set Okres=Tydzień → main menu shows filters + “Pokaż wyniki”.
4) Toggle Długoterminowe twice → `lr` flips, offset resets to 0, label changes.
5) Run search with only Okres set (Theme=all, Pay=all, lr=0).
6) Pagination: “Pokaż więcej” increases offset by 10; results differ between pages.
7) After paging, press Wstecz → returns to main menu, offset reset to 0, filters preserved.
8) Zero results → shows the “brak wyników” screen with 4 buttons.
