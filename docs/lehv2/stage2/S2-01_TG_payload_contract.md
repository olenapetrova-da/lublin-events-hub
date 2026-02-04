# S2-01 — Telegram payload contract (MVP)

Single source of truth for **inline keyboard** `callback_data` payloads used by the Telegram bot MVP (Stage 2).

This contract describes **codes** (stable) and example **labels** (Polish, changeable).

---

## Format

We use **inline keyboards** (callback queries). Each button has:
- a visible Polish label
- a hidden `callback_data` payload

Payload scheme:

- `v2|set|<key>=<value>`  (set a value)
- `v2|menu|<name>`        (open a menu screen)
- `v2|run|search`         (execute search)
- `v2|nav|<flag>`         (navigation)

---

## Keys and allowed values

- `period`: `today | tomorrow | weekend | week`
- `theme`: `all | teatr | film | koncert | spotkanie | warsztat | wystawa | wycieczka | sport | inne`
- `pay`: `all | free | paid | unknown`
  - **MVP UI uses only** `all` and `free` (toggle). Other values are reserved.
- `lr`: `0 | 1`
  - `0` (default): exclude long‑running events (`range_days >= 21`)
  - `1`: include long‑running events

---

## Navigation flags

| Example button label (PL) | callback_data |
|---|---|
| Pokaż więcej *(only if has_more)* | `v2|nav|more` |
| Wstecz / Zmień filtry | `v2|nav|back` |

---

## Menus

| Menu | callback_data |
|---|---|
| Okres | `v2|menu|period` |
| Kategoria | `v2|menu|theme` |

---

## /start screen

`/start` is a **message** (not callback). The bot responds with a welcome text and the **period selection keyboard** (same buttons as the Period menu, without “Wstecz”).

---

## Period menu

| Button label (PL) | callback_data |
|---|---|
| Dziś | `v2|set|period=today` |
| Jutro | `v2|set|period=tomorrow` |
| Weekend | `v2|set|period=weekend` |
| Tydzień | `v2|set|period=week` |
| Wstecz | `v2|nav|back` |

---

## Theme menu

| Button label (PL) | callback_data |
|---|---|
| Wszystkie | `v2|set|theme=all` |
| Teatr | `v2|set|theme=teatr` |
| Film | `v2|set|theme=film` |
| Koncert | `v2|set|theme=koncert` |
| Spotkanie | `v2|set|theme=spotkanie` |
| Warsztat | `v2|set|theme=warsztat` |
| Wystawa | `v2|set|theme=wystawa` |
| Wycieczka | `v2|set|theme=wycieczka` |
| Sport | `v2|set|theme=sport` |
| Inne | `v2|set|theme=inne` |
| Wstecz | `v2|nav|back` |

---

## Step2 (filters + “Pokaż wyniki”)

After period selection, the bot shows a “settings” screen with:
- optional **category** menu entry (may be hidden after category selection)
- **pay toggle**:
  - `pay=all` → button sends `v2|set|pay=free`
  - `pay=free` → button sends `v2|set|pay=all`
- **long‑running toggle**:
  - `lr=0` → button sends `v2|set|lr=1`
  - `lr=1` → button sends `v2|set|lr=0`
- run search: `v2|run|search`

Example buttons:

| Example button label (PL) | callback_data |
|---|---|
| 🎭 Wybierz kategorię *(optional)* | `v2|menu|theme` |
| 💳 Pokaż tylko bezpłatne | `v2|set|pay=free` |
| 💳 Pokaż płatne i bezpłatne | `v2|set|pay=all` |
| ⏳ Pokaż długoterminowe | `v2|set|lr=1` |
| ⏳ Ukryj długoterminowe | `v2|set|lr=0` |
| 🔎 Pokaż wyniki | `v2|run|search` |

---

## Results screen keyboard

When results are shown:

| Example button label (PL) | callback_data |
|---|---|
| Pokaż więcej *(only if has_more)* | `v2|nav|more` |
| Zmień filtry | `v2|nav|back` |

### End-of-list and zero-results
When there are no more results (or no results at all), the bot may also offer:

| Example button label (PL) | callback_data |
|---|---|
| 🎭 Zmień kategorię | `v2|menu|theme` |
| Zmień filtry | `v2|nav|back` |
