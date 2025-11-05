# Source spec — zoom.lublin.pl

## List page (cards)
- **Title:** `.event-card__image > a.event-card__link > h3.event-card__title`
- **Link:** same `<a.event-card__link>`
- **Venue:** `.event-card__place span`
- **Category (raw):** `.event-card__data-right .c-btn.c-btn--primary > span`
- **Date/time block:** `.event-card__dates span`

### Date/time parsing rules (list)
The text inside `.event-card__dates span` can be:

a) `YYYY-MM-DD — HH:MM` → `Date=YYYY-MM-DD`, `Time=HH:MM`, `_EndDate=Date`  
b) `YYYY-MM-DD — HH:MM, HH:MM, …` → `Date=YYYY-MM-DD`, `Time="HH:MM, HH:MM, …"`, `_EndDate=Date`  
c) `YYYY-MM-DD — YYYY-MM-DD` → `Date=start`, `_EndDate=end`, `Time=""`

Normalize dashes (–, —, -) and spaces. Times are 24-hour.

> Follow the DOM as in `events_html/zoom/Zoom_event_card_list_multy-time.html`. 
> Do **not** rely on old `data-start-date`/`data-end-date` attributes — they are not present on the current cards. 
> (That’s why current Worker misses the date.) :contentReference[oaicite:1]{index=1}

---

## Detail page (single event)
- **Title:** `.single-event__content-title-wrapper .single-event__content-title`
- **Venue:** `.single-event__place-wrapper .single-event__place span`
- **Category (raw):** `.single-event__categories a.c-btn.c-btn--primary > span`
- **Payment:** `.single-event__tickets` (detect per ADR-0007 → Yes/No/"" )
- **Date/time block:** `.single-event__dates`

### Date/time parsing rules (detail)
The `.single-event__dates` contains `<p><span>…</span></p>` lines:
- `YYYY-MM-DD — HH:MM` (single showtime rows)
- multiple rows for different days/times
- sometimes a pure range: `<span>YYYY-MM-DD — </span><span>YYYY-MM-DD</span>`

Rules:
- **Time**: collect all `HH:MM` **for the requested Date only** when enriching a specific list row. Join with `", "` de-duplicated and sorted.
- **_EndDate**: the **max** `YYYY-MM-DD` present in the block (range or last show day).

> Follow the DOM as in `events_html/zoom/Zoom_event_card_details_multy-time.html`.

---

## Mapping to adapter output (sheet=0 JSON)
- Required keys: `Title, Date, Time, Venue, Category, Link, "Payment for Entry", Source, _EndDate`  
- Payment per ADR-0007; Category is **raw** (taxonomy in Sheets).  
- If the list provides multiple same-day times, keep them as `"09:30, 11:30"` (hub with `group_times=1` can union showtimes across duplicates).

## Notes on "in progress" (ongoing) items
- zoom.lublin.pl uses “w trakcie” for ongoing exhibitions. When `include_in_progress=1` (default), adapters/hub may include them; counts can be higher even for the same window.