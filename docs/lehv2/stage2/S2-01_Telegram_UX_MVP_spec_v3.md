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
- optionally toggle **Płatność** (MVP: toggle only): *all events* ↔ *free only*
- optionally toggle **Długoterminowe** (long‑running events): *excluded by default*
- run search (“Pokaż wyniki”)
- page results (“Pokaż więcej”)
- open filters screen (“Zmień filtry” / “Wstecz”)

Out of scope:
- free-text search
- personalization
- LLM enrichment

---

## State model

Stored per chat/user in `public.user_state`:

- `step`: `main|main2|period|theme|pay`
  - `main2` is used as a “Step2 variant after category selection” (hide “Wybierz kategorię”).
  - `pay` step is reserved for a future pay menu; MVP uses a pay toggle.
- `period` (required): `today|tomorrow|weekend|week`
- `theme` (optional): `all|teatr|film|koncert|spotkanie|warsztat|wystawa|wycieczka|sport|inne`
- `pay` (optional): `all|free|paid|unknown` (MVP UI uses only `all` and `free`)
- `lr` (optional): `0|1`
  - `0` (default): exclude long‑running events (`range_days >= 21`)
  - `1`: include long‑running events
- `"offset"` (int): pagination offset, default `0`
- `anchor_date` (date): frozen “today” in Europe/Warsaw when period is set

Rules:
- Changing any filter (`period`, `theme`, `pay`, `lr`) resets `"offset"` to `0`.

---

## Screens and keyboards

### 0) Welcome /start (period required)

Bot responds to `/start` with:
- short welcome text
- **period selection keyboard** (no “Wstecz”)

Buttons:
- Dziś / Jutro
- Weekend / Tydzień

### 1) Period menu (step=`period`)
Buttons:
- Dziś
- Jutro
- Weekend
- Tydzień
- Wstecz *(returns to “filters/settings” screen)*

### 2) Category menu (step=`theme`)
Buttons:
- Wszystkie
- Teatr / Film / Koncert / Spotkanie / Warsztat / Wystawa / Wycieczka / Sport / Inne
- Wstecz *(returns to “filters/settings” screen)*

### 3) Filters/settings screen (Step2)

This is the main “filter builder” after period selection.

Text:
- shows current settings: Okres, Kategoria, Płatność, Długoterminowe
- guides user to refine options or run search

Keyboard always includes:
- Pay toggle:
  - if `pay=all` show “💳 Pokaż tylko bezpłatne” (`pay=free`)
  - if `pay=free` show “💳 Pokaż płatne i bezpłatne” (`pay=all`)
- Long‑running toggle:
  - if `lr=0` show “⏳ Pokaż długoterminowe” (`lr=1`)
  - if `lr=1` show “⏳ Ukryj długoterminowe” (`lr=0`)
- “🔎 Pokaż wyniki”

Category button is conditional:
- before the user selects any category → show “🎭 Wybierz kategorię”
- after the user selects a category (including “Wszystkie”) → the bot may hide this button on the Step2 screen (still accessible via “Zmień filtry” / end-of-list screens)

### 4) Filters screen (“Zmień filtry”)
From results, user can open a “filters” screen that offers:
- “📅 Wybierz okres”
- “🎭 Wybierz kategorię”
- pay toggle
- long‑running toggle

This screen does **not** show “Pokaż wyniki” (user returns to Step2 to run search).

---

## Search result screens

### A) Results (has at least 1 event)

The bot prints a list of canonical events (one line per canonical event):
- format (example): `YYYY-MM-DD — <title> — <times_text> — <venue_if_any>  <url>`
- ordering: date asc, earliest_time asc (NULL last), title asc

Keyboard:
- Pokaż więcej *(only if there are more results)*
- Zmień filtry

### B) End of list (no more results)
Text includes a short footer like: “To już wszystkie wyniki…”
Keyboard:
- 🎭 Zmień kategorię
- Zmień filtry

### C) Zero results
Text: “Brak wyników…”
Keyboard:
- 🎭 Zmień kategorię
- Zmień filtry

---

## Behavioral rules (important edge cases)

- Weekend requested on Sunday → uses **next** Sat+Sun (not the current day).
- Week window equals today..today+6.
- Any invalid/stale callback → “Nie rozumiem…” + keyboard for current state; state unchanged.
- Free text at any step → “Nie rozumiem…” + keyboard for current state; state unchanged.

---

## Acceptance checks (manual)

1) `/start` shows period selection.
2) Set Okres=Tydzień → Step2 shows settings + (category button if not chosen yet) + toggles + “Pokaż wyniki”.
3) Select a category “Wszystkie” → Step2 may hide “Wybierz kategorię” (category is still reachable via “Zmień filtry”).
4) Toggle pay twice → pay flips, `"offset"` resets to 0, label changes.
5) Toggle long‑running twice → lr flips, `"offset"` resets to 0, label changes.
6) Run search with only Okres set (Theme may be all, Pay=all, lr=0).
7) Pagination: “Pokaż więcej” increases offset by 10; results differ between pages.
8) Press “Zmień filtry” from results → filters screen appears (period/theme + toggles).
9) End-of-list: last page shows “To już wszystkie…” with “Zmień kategorię” and “Zmień filtry”.
10) Zero results → shows the “Brak wyników” screen with the two buttons.
