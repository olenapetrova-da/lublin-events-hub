# S2-01 — Telegram UX flow (MVP)

Context: LEHv2 Stage 2 — Telegram bot MVP on PostgreSQL + n8n (button-only, Polish UI).

This document is the UX/state-machine contract for the bot. Implementation details (n8n modules, SQL, etc.) are out of scope here.

## Scope

Users can:
- start the bot (`/start`)
- choose **Okres** (required): Dziś / Jutro / Weekend / Tydzień
- optionally choose **Kategoria** (theme): Wszystkie, Teatr, Film, Muzyka, Spotkanie, Warsztat, Wystawa, Wycieczka, Sport, Inne
- optionally choose **Płatność**: Wszystkie / Bezpłatne / Płatne / Nieznane
- run search (“Pokaż wyniki”)
- page results (“Pokaż więcej”)
- go back to main menu (“Wstecz”)
- reset everything (“Zacznij od nowa”)

Non-goals for MVP:
- counts in menus, hiding zero options
- remembering last filters across long time
- type/audience second filter (planned later)

## Keyboard type and payload contract


UI uses **inline keyboards** (Telegram callback queries). Each button has:
- a visible Polish label
- a hidden payload (callback_data) that the workflow interprets

Payload format:
- `v2|<action>|<key>=<value>` or `v2|<action>|<flag>`

Payloads for every button are defined in **`docs/lehv2/S2-01_TG_payload_contract.md`** (single source of truth).
Change rules for labels vs codes are defined in **`docs/lehv2/S2-01_TG_labels_and_codes_policy.md`**.


## State model (conceptual)

Stored per `chat_id`:
- `step` (one of: welcome, main_menu, menu_period, menu_theme, menu_pay, results)
- `period` (required before search): `today|tomorrow|weekend|week`
- `theme` (optional): `all|teatr|film|muzyka|spotkanie|warsztat|wystawa|wycieczka|sport|inne`
- `pay` (optional): `all|free|paid|unknown`
- `offset` (pagination): integer, starts at 0, increments by 10 on “Pokaż więcej”
- timestamps (not specified here)

Offset rules:
- Any filter change resets `offset = 0`.
- Results → “Wstecz” keeps filters, resets `offset = 0`.

## Period semantics (Europe/Warsaw)

Let **D** be the local date when the request is handled.

- **Dziś**: [D, D]
- **Jutro**: [D+1, D+1]
- **Tydzień**: [D, D+6] (rolling 7 days)
- **Weekend**: nearest Sat+Sun strictly **after** “now”.
  - If the request date is Sunday, Weekend means **next** Sat+Sun (not today).

## Screens and behavior

### S0 — Welcome (`/start`)
Action:
- reset all filters and offset
- show welcome message
- move to S1 (Main menu / Filter hub)

### S1 — Main menu / Filter hub
Message must always include 3 blocks:

**(A) Aktualne filtry** (always)
- Okres: {value or “nie wybrano (wymagane)”}
- Kategoria: {value}
- Płatność: {value}

**(B) Guidance to mandatory selection** (conditional)
- if Okres missing: “Wybierz okres (wymagane), aby zobaczyć wyniki.”
- if Okres set: “Kliknij ‘Pokaż wyniki’ lub zmień kategorię/płatność.”

**(C) Guidance that optional filters can be changed** (always)
- if Okres missing: “Możesz też ustawić kategorię i płatność teraz albo później.”
- if Okres set: “Kategoria i płatność są opcjonalne — możesz je zmieniać w dowolnym momencie.”

Buttons shown (labels only; see payload contract doc for callback_data):
- Wybór okresu
- Wybór kategorii
- Wybór płatności
- Zacznij od nowa
- Pokaż wyniki *(only if Okres is selected)*

- Pokaż wyniki *(only if Okres is selected)*

### S2 — Period menu
Buttons (labels only; see payload contract doc):
- Dziś
- Jutro
- Weekend
- Tydzień
- Wstecz
- Zacznij od nowa

On selection:
- update `period`
- reset `offset=0`
- return to S1

### S3 — Theme menu
Buttons (labels only; see payload contract doc):
- Wszystkie
- Teatr
- Film
- Muzyka
- Spotkanie
- Warsztat
- Wystawa
- Wycieczka
- Sport
- Inne
- Wstecz
- Zacznij od nowa

On selection:
- update `theme`
- reset `offset=0`
- return to S1

### S4 — Payment menu
Buttons (labels only; see payload contract doc):
- Wszystkie
- Bezpłatne
- Płatne
- Nieznane
- Wstecz
- Zacznij od nowa

On selection:
- update `pay`
- reset `offset=0`
- return to S1

### S5 — Results
Triggered only by:
- S1 “Pokaż wyniki” when Okres is set
- S5 “Pokaż więcej”

Result formatting:
- Output is grouped by date (ascending).
- Within a date, sort by title (ascending), then venue (ascending).
- One line per **(date, event_id)** with times aggregated for that day.
- If multiple showtimes for the same (date, event_id), render time as: `HH:MM, HH:MM, ...` (sorted).
- If time unknown/NULL: render `-`.

Venue display rule (MVP):
- If venue is known: show it.
- If venue is NULL/unknown: show `-`.

Line format:
`<date> - <Title> - <Time(s)> - <Category> - <Venue> - <Payment> - <Link>`

Category field rule (MVP):
- Display the **canonical theme** (the same theme dimension used by the menu filter).
- If an event cannot be mapped to a canonical theme, display **Inne/Nieznane**.

Pagination:
- page size = 10 lines per message
- “Pokaż więcej” increases `offset += 10`
- If no more results remain:
  - show message: “To już wszystkie wyniki dla tych filtrów.”
  - do not show “Pokaż więcej”

Results buttons (labels only; see payload contract doc):
- Pokaż więcej *(only if has_more)*
- Wstecz
- Zacznij od nowa


### Zero results
If search returns 0 rows:
Message:
- “Przykro mi, brak wyników. Zmień filtry albo zacznij od nowa.”

Buttons (labels only; see payload contract doc):
- Wybór okresu
- Wybór kategorii
- Wybór płatności
- Zacznij od nowa

### Backend error
If a backend/bot error occurs:
- Message: “Mamy problem po naszej stronie. Spróbuj proszę za chwilę.”
- Show the keyboard for the user’s current state again.
- Do not change state.

### Free text and unknown/stale callback handling
If user sends any free text, or the bot receives unknown / invalid / stale callback_data:
- Message: “Nie rozumiem 🙁 Wybierz opcję z menu poniżej, wtedy potrafię pomóc!”
- Show the keyboard for the user’s current state again.
- Do not change state.

## Manual test checklist (MVP)

1) `/start` resets state and shows main menu (Okres missing, guidance present, no “Pokaż wyniki”).
2) From main menu choose Kategoria first → returns to main menu with Okres still missing and clear guidance.
3) Set Okres=Tydzień → main menu shows filters + guidance that other filters are optional + “Pokaż wyniki” visible.
4) Run search with only Okres set (Theme=all, Pay=all).
5) Select Theme and Pay, run search; verify ordering and formatting.
6) Weekend requested on Sunday → uses next Sat+Sun.
7) Week window equals today..today+6.
8) Pagination: “Pokaż więcej” increases offset by 10; results differ between pages.
9) After paging to page 2, press Wstecz → returns to main menu, offset reset to 0, filters preserved.
10) After paging, change a filter → offset resets to 0; next “Pokaż wyniki” shows page 1.
11) Zero results → shows “brak wyników” screen with 4 buttons.
12) End of list → shows “To już wszystkie wyniki…” and no “Pokaż więcej”.
13) Free text at any step → “Nie rozumiem…” + keyboard for current state; state unchanged.
14) Press a stale/unknown inline button → “Nie rozumiem…” + current keyboard; state unchanged.
15) Simulate backend error → error message + current keyboard; state unchanged.
