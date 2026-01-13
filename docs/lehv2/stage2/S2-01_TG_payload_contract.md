# S2-01 — Telegram payload contract (MVP)

Single source of truth for **inline keyboard** `callback_data` payloads used by the Telegram bot MVP (Stage 2).

---

## Format

We use **inline keyboards** (callback queries). Each button has:
- a visible Polish label
- a hidden `callback_data` payload

Payload scheme:

- `v2|set|<key>=<value>`  (set a value)
- `v2|menu|<name>`        (open a menu screen)
- `v2|run|search`         (execute search)
- `v2|nav|<flag>`         (navigation / simple commands)

---

## Keys and allowed values

- `period`: `today | tomorrow | weekend | week`
- `theme`: `all | teatr | film | koncert | spotkanie | warsztat | wystawa | wycieczka | sport | inne`
- `pay`: `all | free | paid | unknown`
- `lr`: `0 | 1`
  - `0` (default): exclude long‑running events (`range_days >= 21`)
  - `1`: include long‑running events

---

## Navigation flags

| Button label (PL) | callback_data |
|---|---|
| Pokaż więcej *(only if has_more)* | `v2|nav|more` |
| Wstecz | `v2|nav|back` |
| Zacznij od nowa | `v2|nav|reset` |

---

## Main menu buttons

| Button label (PL) | callback_data |
|---|---|
| Wybór okresu | `v2|menu|period` |
| Wybór kategorii | `v2|menu|theme` |
| Wybór płatności | `v2|menu|pay` |
| Pokaż wyniki | `v2|run|search` |
| Zacznij od nowa | `v2|nav|reset` |

### Long‑running toggle (shown as one button depending on current state)

| Button label (PL) | callback_data |
|---|---|
| Pokaż długoterminowe *(when lr=0)* | `v2|set|lr=1` |
| Ukryj długoterminowe *(when lr=1)* | `v2|set|lr=0` |

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

## Pay menu

| Button label (PL) | callback_data |
|---|---|
| Wszystkie | `v2|set|pay=all` |
| Bezpłatne | `v2|set|pay=free` |
| Płatne | `v2|set|pay=paid` |
| Nieznane | `v2|set|pay=unknown` |
| Wstecz | `v2|nav|back` |

---

## Results screen keyboard

| Button label (PL) | callback_data |
|---|---|
| Pokaż więcej *(only if has_more)* | `v2|nav|more` |
| Wstecz | `v2|nav|back` |
| Zacznij od nowa | `v2|nav|reset` |

---

## Zero results screen (Brak wyników)

| Button label (PL) | callback_data |
|---|---|
| Wybór okresu | `v2|menu|period` |
| Wybór kategorii | `v2|menu|theme` |
| Wybór płatności | `v2|menu|pay` |
| Zacznij od nowa | `v2|nav|reset` |
