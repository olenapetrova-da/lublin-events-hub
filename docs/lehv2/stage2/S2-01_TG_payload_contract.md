# S2-01 — Telegram payload contract (MVP)

Single source of truth for **inline keyboard** `callback_data` payloads used by the Telegram bot MVP (Stage 2).

## Format

We use **inline keyboards** (callback queries). Each button has:
- a visible Polish label
- a hidden `callback_data` payload

Payload scheme:

- `v2|<action>|<key>=<value>`  (set a value)
- `v2|<action>|<flag>`         (navigation / simple commands)

## Conventions

Keys and values (stable identifiers):

- `period`: `today | tomorrow | weekend | week`
- `theme`: `all | teatr | film | koncert | spotkanie | warsztat | wystawa | wycieczka | sport | inne`
- `pay`: `all | free | paid | unknown`

Actions:

- `menu` — open a submenu (no state change beyond `step`)
- `set`  — set a filter value + reset `offset=0` + return to main menu
- `run`  — execute a search (requires `period` set)
- `nav`  — navigation helpers

Nav flags:

- `back`  — return to **main menu** (keep filters; reset `offset=0`)
- `reset` — reset all filters + `offset=0` and go to welcome/main menu
- `more`  — next page (`offset += 10`)

---

## Main menu / Filter hub

| Button label (PL) | callback_data |
|---|---|
| Wybór okresu | `v2|menu|period` |
| Wybór kategorii | `v2|menu|theme` |
| Wybór płatności | `v2|menu|pay` |
| Pokaż wyniki *(only if Okres selected)* | `v2|run|search` |
| Zacznij od nowa | `v2|nav|reset` |

## Period menu (Okres)

| Button label (PL) | callback_data |
|---|---|
| Dziś | `v2|set|period=today` |
| Jutro | `v2|set|period=tomorrow` |
| Weekend | `v2|set|period=weekend` |
| Tydzień | `v2|set|period=week` |
| Wstecz | `v2|nav|back` |
| Zacznij od nowa | `v2|nav|reset` |

## Theme menu (Kategoria)

| Button label (PL) | callback_data |
|---|---|
| Wszystkie | `v2|set|theme=all` |
| Teatr | `v2|set|theme=teatr` |
| Film | `v2|set|theme=film` |
| Muzyka | `v2|set|theme=muzyka` |
| Spotkanie | `v2|set|theme=spotkanie` |
| Warsztat | `v2|set|theme=warsztat` |
| Wystawa | `v2|set|theme=wystawa` |
| Wycieczka | `v2|set|theme=wycieczka` |
| Sport | `v2|set|theme=sport` |
| Inne | `v2|set|theme=inne` |
| Wstecz | `v2|nav|back` |
| Zacznij od nowa | `v2|nav|reset` |

## Payment menu (Płatność)

| Button label (PL) | callback_data |
|---|---|
| Wszystkie | `v2|set|pay=all` |
| Bezpłatne | `v2|set|pay=free` |
| Płatne | `v2|set|pay=paid` |
| Nieznane | `v2|set|pay=unknown` |
| Wstecz | `v2|nav|back` |
| Zacznij od nowa | `v2|nav|reset` |

## Results screen (Wyniki)

| Button label (PL) | callback_data |
|---|---|
| Pokaż więcej *(only if has_more)* | `v2|nav|more` |
| Wstecz | `v2|nav|back` |
| Zacznij od nowa | `v2|nav|reset` |

## Zero results screen (Brak wyników)

| Button label (PL) | callback_data |
|---|---|
| Wybór okresu | `v2|menu|period` |
| Wybór kategorii | `v2|menu|theme` |
| Wybór płatności | `v2|menu|pay` |
| Zacznij od nowa | `v2|nav|reset` |
