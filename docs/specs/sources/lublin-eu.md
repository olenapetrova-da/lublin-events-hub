# Source spec — lublin.eu (Official)

# Source spec — lublin.eu (Official)

> Purpose: document the DOM “landmarks” and parsing rules used by the **Official** adapter (`Lublin_official_Worker_forHub2.js`).  
> Note: **Venue is not present on list cards**; it exists only on the event detail page. Hub dedupe therefore uses the **venue-less fallback** (ADR-0012).

---

## List page (cards)

- **Card container:** `div.event`  *(split per card)*
- **Title:** `div.event-title > a`
- **Link:** same anchor’s `href` (resolved to absolute URL)
- **Venue:** **not present** on list → leave empty
- **Category (raw):** **not present** on list → leave empty  *(detail may fill)*
- **Date block(s):** any element whose `class` contains `event-date`  
  → captures **one or two** dates as `DD-MM-YYYY`
- **Time block:** any element whose `class` contains `event-time`  
  → captures the first `HH:MM` (inner `<span>` tolerated)

### Date/time parsing (list)

Cases the adapter handles:

a) `DD-MM-YYYY — HH:MM` → `Date=YYYY-MM-DD`, `Time=HH:MM`, `_EndDate=Date`  
b) `DD-MM-YYYY — HH:MM, HH:MM, …` *(rare on Official)* → `Date=YYYY-MM-DD`, `Time="HH:MM, HH:MM, …"`, `_EndDate=Date`  
c) `DD-MM-YYYY — DD-MM-YYYY` → `Date=start(ISO)`, `_EndDate=end(ISO)`, `Time=""`

Normalization:

- Convert `DD-MM-YYYY` → `YYYY-MM-DD` (ISO).
- Normalize dashes (`–`, `—`, `-`) and spaces before splitting.
- Payment is **not** on list; list-level heuristic may set **"No"** if explicit *free* tokens are found, otherwise leave empty.

> This matches the worker’s list parser:  
> - Dates via `class="…event-date…"`, up to two per card.  
> - Time via `class="…event-time…"`, robust to nested spans.  
> - Title/Link via `div.event-title > a`. :contentReference[oaicite:0]{index=0}

---

## Detail page (single event)

The page uses label/value rows:

<div class="form-row">
  <span class="label">Miejsce</span>
  <span>…value…</span>
</div> ```

### Preferred label-based selectors (first match wins):

- **Start date**: label ≈ Data rozpoczęcia → value text
- **End date**: label ≈ Data zakończenia → value text
- **Time**: label ≈ Godzina / Godzina rozpoczęcia → first HH:MM
- **Venue**: label ≈ Miejsce / Lokalizacja → value text
- **Category (raw)**: label ≈ Kategoria / Category → value text
- **Payment**: label ≈ Udział/Udzial or Wstęp/Wstep → value text → map to Yes/No/"" (ADR-0007)

### Fallbacks (when labels missing):

- **Venue**: any element with class matching place|lokalizacja|event__place
- **Category**: any element with class matching category|event__category
- **Payment**: page-wide token scan for paid/free phrases and zł|PLN prices; conflicts resolved by presence of numeric price = **Yes**

### Date/time parsing rules (detail)

- Accept both YYYY-MM-DD and DD-MM-YYYY, normalize to ISO.
- **Time**: take the (start) HH:MM value if present. Showtimes on multiple days are rare on Official; same-day multiplicity is handled by the hub’s group_times/union logic.
- **_EndDate**: prefer detail’s end date if present; otherwise keep the list value.

### Special handling:

If Time resolves to 00:00 and the event is multi-day or looks exhibition-like, the adapter clears Time to empty to avoid misleading “midnight” artifacts

---

## Mapping to adapter output (sheet=0 JSON)

Required keys:  
`Title, Date, Time, Venue, Category, Link, "Payment for Entry", Source, _EndDate`

- **Payment** per ADR-0007 (adapter outputs `Yes|No|""`; Apps Script maps to `free|paid|unknown`).  
- **Category** is **raw** (taxonomy mapping happens in Sheets).  
- **Venue** may be empty for Official (list) — Hub merges with Zoom using ADR-0012 fallback (date + time overlap + title/slug similarity).

---

## Notes

- **Venue-less list:** leave Venue empty on list; do not enable enrichment for daily runs.  
- **Ongoing (“w trakcie”)**: included by default when `include_in_progress=1`.  
- **Budget/limits:** obey `subreq_budget_max`; enrichment is only when `enrich=1` with `enrich_max` cap (ADR-0006/0010).

## References

- ADR-0006 (enrichment location & limits)  
- ADR-0007 (Payment value at adapter output)  
- ADR-0008 (enrichment fields)  
- ADR-0009 (_EndDate & Source policy)  
- ADR-0010 (adapter budget & stop policy)  
- ADR-0012 (cross-source dedupe without venue)  
- `docs/specs/adapter-contract.md`
