/**
 * Lublin_Zoom_Worker_forHub.js — 2025-11-05 (addendum #2)
 * - New: Enrichment budget saver — skip detail-enrichment for ongoing/no-time ranges
 *         (Time == "" AND _EndDate != Date). These are typically exhibitions; list data is sufficient.
 * - Keep: include_in_progress support for /w-trakcie is unchanged.  :contentReference[oaicite:1]{index=1}
 */

/**
 * Lublin_Zoom_Worker_forHub.js
 * CHANGELOG — 2025-11-05 (addendum)
 * - New: Option to include ongoing multi-day events from https://zoom.lublin.pl/w-trakcie/ .
 *        Controlled by ?include_in_progress=1|0 (default: 1). Page count via ?inprog_pages=1..3 (default: 1).
 * - Behavior: These cards are typically date ranges without times. We reuse the same list parser and
 *             downstream window filtering (rangesOverlap) so only ranges intersecting the requested window are kept.
 * - Risk control: One extra list fetch by default (page 1 of /w-trakcie/). Uses the same subrequest budget.
 */

/**
 * Lublin_Zoom_Worker_forHub.js
 * CHANGELOG — 2025-11-05
 * - Fix: List parser reads dates/times strictly from `.event-card__dates` (no legacy data-* attrs).
 * - Fix: Supports two-<span> “no-time” ranges like `<span>YYYY-MM-DD — </span><span>YYYY-MM-DD</span>`;
 *        emits rows with Time="" and _EndDate set to the second date.
 * - Fix: Normalizes all times to HH:MM via padTime(); detail enrichment also pads times.
 * - Fix: Detail enrichment reads only the correct blocks: single-event__dates/place/categories/tickets.
 * - Fix: Payment detection prioritizes tickets block; falls back to page-level heuristic.
 * - Keep: Grouping showtimes when `group_times=1`. ?sheet=1 returns rows (8 cols, no Image URL).
 */


/**
 * Lublin_Zoom_Worker_forHub.js — 2025-11-05 (addendum #2)
 * - New: Enrichment budget saver — skip detail-enrichment for ongoing/no-time ranges
 *         (Time == "" AND _EndDate != Date). These are typically exhibitions; list data is sufficient.
 * - Keep: include_in_progress support for /w-trakcie is unchanged.  :contentReference[oaicite:1]{index=1}
 */

/**
 * Lublin_Zoom_Worker_forHub.js
 * CHANGELOG — 2025-11-05 (addendum)
 * - New: Option to include ongoing multi-day events from https://zoom.lublin.pl/w-trakcie/ .
 *        Controlled by ?include_in_progress=1|0 (default: 1). Page count via ?inprog_pages=1..3 (default: 1).
 * - Behavior: These cards are typically date ranges without times. We reuse the same list parser and
 *             downstream window filtering (rangesOverlap) so only ranges intersecting the requested window are kept.
 * - Risk control: One extra list fetch by default (page 1 of /w-trakcie/). Uses the same subrequest budget.
 */

/**
 * Lublin_Zoom_Worker_forHub.js
 * CHANGELOG — 2025-11-05
 * - Fix: List parser reads dates/times strictly from `.event-card__dates` (no legacy data-* attrs).
 * - Fix: Supports two-<span> “no-time” ranges like `<span>YYYY-MM-DD — </span><span>YYYY-MM-DD</span>`;
 *        emits rows with Time="" and _EndDate set to the second date.
 * - Fix: Normalizes all times to HH:MM via padTime(); detail enrichment also pads times.
 * - Fix: Detail enrichment reads only the correct blocks: single-event__dates/place/categories/tickets.
 * - Fix: Payment detection prioritizes tickets block; falls back to page-level heuristic.
 * - Keep: Grouping showtimes when `group_times=1`. ?sheet=1 returns rows (8 cols, no Image URL).
 */


/**
 * S2-07A (Payment strategy v2) — Zoom list-page FREE detection
 * ----------------------------------------------------------------
 * Goal: detect FREE cheaply on list pages (no per-event enrichment).
 * Signal: Zoom marks some cards with data-infos-ids="34" on the wrapper
 *         <div class="event-card-wrapper ...">.
 * Output convention (Hub):
 *   - "Payment for Entry" = "No"   -> FREE
 *   - "Payment for Entry" = ""     -> UNKNOWN
 *
 * Debugging support:
 *   - pass ?debug_slug=<event_ref> to include __debug_* fields ONLY for that event.
 *   - this helps verify whether the worker actually sees data-infos-ids in fetched HTML.
 */
// Zoom list-page FREE marker IDs.
// Default observed marker: 34 (data-infos-ids="34").
// Defensive config:
//  - Override per-request: ?zoom_free_info_ids=34,99
//  - Override via env binding: ZOOM_FREE_INFO_IDS="34,99"
// If Zoom changes markup/IDs, the canary counters in the response help detect it early.
const DEFAULT_ZOOM_FREE_INFO_IDS = new Set(["34"]);

function buildZoomFreeInfoIds(env, q) {
  const csv = (q.get("zoom_free_info_ids") || (env && env.ZOOM_FREE_INFO_IDS) || "").trim();
  if (!csv) return DEFAULT_ZOOM_FREE_INFO_IDS;
  return new Set(csv.split(",").map(s => s.trim()).filter(Boolean));
}

export default {
  async fetch(request, env, ctx) {
    try {
      const u = new URL(request.url);
      const q = u.searchParams;

      // ---- Inputs (hub forwards these) ----
      const startISO   = (q.get("date") || "").trim();              // YYYY-MM-DD
      const period     = (q.get("period") || "day").toLowerCase();  // day|week
      const days       = int(q.get("days"), period === "week" ? 7 : 1);
      const pagesMax   = clamp(int(q.get("pages"), 3), 1, 5);
      const limit      = clamp(int(q.get("limit"), 200), 1, 10000);
      const groupTimes = flag(q.get("group_times"));
      const wantRows   = flag(q.get("sheet"));


      // Debug: include __debug_* fields for a single event_ref (optional)
      const debugSlug  = (q.get("debug_slug") || "").trim().toLowerCase();
      

      // S2-07A ops: lightweight parser health counters (wrapper vs fallback).
      // Helps detect markup shifts that would silently disable FREE detection.
      const parseStats = { wrapper_blocks: 0, wrapper_events: 0, card_blocks: 0, card_events: 0 };

      // S2-07A: FREE marker IDs are configurable (query/env) so you can hot-fix without code changes.
      const zoomFreeIds = buildZoomFreeInfoIds(env, q);

      const enrich     = flag(q.get("enrich"));
      const enrichMax  = clamp(int(q.get("enrich_max"), 15), 0, 50);

      // NEW: include ongoing events (/w-trakcie) — default ON unless explicitly set
      const includeInProgress = q.has("include_in_progress") ? flag(q.get("include_in_progress")) : true;
      const inprogPages       = clamp(int(q.get("inprog_pages"), 1), 1, 3);

      // ---- Subrequest budget (ADR-0010) ----
      const userBudget = clamp(int(q.get("budget"), 0), 0, 48);
      const budget     = { used: 0, max: userBudget || 48 };

      const listUrl    = ensureSlash(q.get("url") || "https://zoom.lublin.pl/wydarzenia/");
      const inprogUrl  = "https://zoom.lublin.pl/w-trakcie/"; // server-rendered list of ongoing ranges

      if (!startISO) return jserr("Missing ?date=YYYY-MM-DD", 400);
      const start = parseYMD(startISO);
      if (!start) return jserr("Bad ?date format, expected YYYY-MM-DD", 400);
      const end = addDays(start, days - 1);

      const scanned = [];
      let pages_scanned = 0;

      // ---- Crawl /wydarzenia (budget-aware)
      const events = [];
      const fetchCap = groupTimes ? Math.min(limit * 3, 2000) : limit;
      const listCollectCap = enrich ? Math.max(enrichMax * 10, 100) : fetchCap;

      // page 1
      let r = await fetchPage(listUrl, ctx, budget, { useCache: true, writeCache: true });
      pages_scanned++; scanned.push(listUrl);
      if (r.ok) collect(parseZoomList(r.html, debugSlug, zoomFreeIds, parseStats));

      // next pages: /wydarzenia/page/2/
      for (let p = 2; p <= pagesMax; p++) {
        if (budget.used >= budget.max || events.length >= listCollectCap) break;
        const next = new URL(`page/${p}/`, listUrl).toString();
        r = await fetchPage(next, ctx, budget, { useCache: true, writeCache: true });
        pages_scanned++; scanned.push(next);
        if (!r.ok) break;
        collect(parseZoomList(r.html, debugSlug, zoomFreeIds, parseStats));
      }

      // ---- Optionally crawl /w-trakcie (ongoing, usually no-time ranges)
      if (includeInProgress && budget.used < budget.max && events.length < listCollectCap) {
        // page 1
        let r2 = await fetchPage(inprogUrl, ctx, budget, { useCache: true, writeCache: true });
        pages_scanned++; scanned.push(inprogUrl);
        if (r2.ok) collect(parseZoomList(r2.html, debugSlug, zoomFreeIds, parseStats));

        // heuristic pagination: /w-trakcie/page/2/
        for (let p = 2; p <= inprogPages; p++) {
          if (budget.used >= budget.max || events.length >= listCollectCap) break;
          const next = new URL(`page/${p}/`, inprogUrl).toString();
          r2 = await fetchPage(next, ctx, budget, { useCache: true, writeCache: true });
          pages_scanned++; scanned.push(next);
          if (!r2.ok) break;
          collect(parseZoomList(r2.html, debugSlug, zoomFreeIds, parseStats));
        }
      }

      // ---- Filter by requested window (Date.._EndDate)
      const filtered = [];
      for (const e of events) {
        const s = parseYMD(e.Date);
        const eEnd = parseYMD(e._EndDate || e.Date);
        if (!s || !eEnd) continue;
        if (rangesOverlap(s, eEnd, start, end)) {
          filtered.push(e);
          if (filtered.length >= fetchCap) break;
        }
      }

      // ---- Optional enrichment (detail pages)
      let enrichedCount = 0;
      let detail_scanned = [];
      if (enrich && filtered.length && budget.used < budget.max) {
        const remaining = Math.max(0, budget.max - budget.used);
        const cap = Math.min(enrichMax, remaining);
        if (cap > 0) {
          const res = await enrichDetails(filtered, cap, ctx, budget);
          enrichedCount = res.enriched;
          detail_scanned = res.scanned;
        }
      }

      // ---- Group & finalize
      // Ops counters: helps explain differences between scanned/filtered/returned counts.
      const events_scanned_total = events.length;
      const events_after_window_filter = filtered.length;
      const finalized = groupTimes ? groupSameDayShowtimes(filtered) : filtered;
      const events_after_grouping_total = finalized.length;
      const sliced = finalized.slice(0, limit);

      // S2-07A canary: count FREE markers detected.
      // If this suddenly drops to 0 for a window that normally has free events,
      // Zoom likely changed markup or marker IDs.
      const isFree = (e) => (e["Payment for Entry"] === "No");
      const free_detected_count_total = finalized.reduce((n, e) => n + (isFree(e) ? 1 : 0), 0);
      const free_detected_count_returned = sliced.reduce((n, e) => n + (isFree(e) ? 1 : 0), 0);

      const payload = {
        source: "zoom.lublin.pl",
        url: listUrl,
        start: fmt(start),
        end: fmt(end),
        pages_scanned,
        scanned,
        budget_used: budget.used,
        budget_max: budget.max,
        budget_exhausted: budget.used >= budget.max,
        enriched: enrichedCount,
        detail_scanned,
        include_in_progress: includeInProgress ? 1 : 0,
        inprog_pages: includeInProgress ? inprogPages : 0,
        count: sliced.length,
        // Ops counters (risk mitigation): explain truncation and detect parsing regressions.
        events_scanned_total,
        events_after_window_filter,
        events_after_grouping_total,
        parser_wrapper_blocks_total: parseStats.wrapper_blocks,
        parser_wrapper_events_total: parseStats.wrapper_events,
        parser_card_blocks_total: parseStats.card_blocks,
        parser_card_events_total: parseStats.card_events,
                free_detected_count_total,
        free_detected_count_returned,
        free_marker_ids_config: Array.from(zoomFreeIds).sort(),
        events: sliced
      };

      if (wantRows) {
        // 8 columns (no Image URL): Title, Date, Time, Venue, Category, Link, Payment for Entry, Source
        payload.rows = sliced.map(e => ({
          values: [
            e.Title || "",
            e.Date || "",
            e.Time || "",
            e.Venue || "",
            e.Category || "",
            e.Link || "",
            e["Payment for Entry"] || "",
            e.Source || "zoom.lublin.pl"
          ]
        }));
      }

      return json(payload);

      function collect(arr) {
        for (const e of arr) {
          events.push(e);
          if (events.length >= listCollectCap) break;
        }
      }
    } catch (err) {
      return jserr(String(err && err.message ? err.message : err), 500);
    }
  }
};

/* ---------------- HTTP (budget-aware + cache counting) ---------------- */
async function fetchPage(url, ctx, budget, opts = {}) {
  const useCache   = opts.useCache   !== false; // default true
  const writeCache = opts.writeCache !== false; // default true
  if (budget.used >= budget.max) return { ok:false, status:0, html:"" };

  const cache = caches.default;
  const req = new Request(url, {
    headers: {
      "User-Agent": "LublinEventsBot/1.0",
      "Accept-Language": "pl-PL,pl;q=0.9,en;q=0.8",
      "Accept": "text/html,*/*"
    }
  });

  // cache.match counts (+1)
  if (useCache) {
    if (budget.used + 1 > budget.max) return { ok:false, status:0, html:"" };
    budget.used++;
    const cached = await cache.match(req);
    if (cached) return { ok:true, status:200, html: await cached.text() };
  }

  // fetch counts (+1)
  if (budget.used + 1 > budget.max) return { ok:false, status:0, html:"" };
  budget.used++;
  const ctrl = new AbortController();
  const to = setTimeout(() => ctrl.abort(), 20000);

  try {
    let res = await fetch(req, { signal: ctrl.signal, redirect: "follow" });

    // retry counts (+1)
    if (!res.ok && [520,522,523,524].includes(res.status) && (budget.used + 1) <= budget.max) {
      budget.used++;
      res = await fetch(req, { signal: ctrl.signal, redirect: "follow" });
    }

    const html = await res.text();
    if (!res.ok) return { ok:false, status:res.status, html };

    // cache.put counts (+1)
    if (useCache && writeCache && (budget.used + 1) <= budget.max) {
      budget.used++;
      const out = new Response(html, {
        headers: {
          "content-type": "text/html; charset=utf-8",
          "cache-control": "public, max-age=900"
        }
      });
      ctx && ctx.waitUntil(cache.put(req, out.clone()));
    }

    return { ok:true, status:200, html };
  } catch (_e) {
    return { ok:false, status:0, html:"" };
  } finally {
    clearTimeout(to);
  }
}

/* ---------------- List parser (Zoom cards) — wrapper-aware ---------------- */
/**
 * Wrapper-aware parsing:
 * - Prefer slicing blocks by `<div class="event-card-wrapper ...>` to access `data-infos-ids`
 *   which is used as a cheap FREE marker (S2-07A).
 * - Fallback to legacy `<div class="event-card"...>` scanning if wrappers are missing.
 *
 * Debugging:
 * - If `debugSlug` matches `event_ref`, we attach __debug_* fields to that one event object.
 *   This is intentionally sparse to avoid noisy payloads in normal runs.
 */
function parseZoomList(raw, debugSlug = "", freeIds = DEFAULT_ZOOM_FREE_INFO_IDS, stats = null) {
  const html = normalizeHtml(raw);
  const out = [];

  // NOTE: Zoom HTML sometimes renders wrapper <div> attributes in different order
  // (e.g., class isn't the first attribute). Also, the class token can appear in
  // scripts/styles. So:
  //  1) find occurrences of the token `event-card-wrapper`
  //  2) keep only those occurrences that are INSIDE an opening `<div ...>` tag
  //  3) slice wrapper blocks by jumping from one valid wrapper `<div ...>` to the next
  //
  // This keeps CPU bounded and avoids Cloudflare "exceeded resource limits" (1102)
  // caused by treating non-wrapper hits as real cards.
  const WRAP_TOKEN = "event-card-wrapper";
  const CARD = '<div class="event-card"';
  const MAX_BLOCKS = 300; // safety guard (pages are small; this is plenty)

  // ---------- Wrapper-aware pass (preferred: reads data-infos-ids) ----------
  let i = 0;
  let blocks = 0;

  while (true) {
    const hit = html.indexOf(WRAP_TOKEN, i);
    if (hit < 0) break;

    // Find the nearest `<div` before the token.
    const divStart = html.lastIndexOf("<div", hit);
    if (divStart < 0) { i = hit + WRAP_TOKEN.length; continue; }

    // Find end of that `<div ...>` opening tag.
    const openEnd = html.indexOf(">", divStart);
    if (openEnd < 0) break;

    // Token must be inside the opening tag, otherwise it's likely inside script/style/text.
    if (hit > openEnd) { i = hit + WRAP_TOKEN.length; continue; }

    // Build openTag (cap length to avoid huge slices).
    const openTag = html.slice(divStart, Math.min(openEnd + 1, divStart + 900));

    // Find next valid wrapper `<div ...>` start to bound the current block.
    let nextDivStart = -1;
    let j = openEnd + 1;
    let guard = 0;

    while (true) {
      const nh = html.indexOf(WRAP_TOKEN, j);
      if (nh < 0) break;

      const ds = html.lastIndexOf("<div", nh);
      if (ds < 0) { j = nh + WRAP_TOKEN.length; if (++guard > 80) break; continue; }

      const oe = html.indexOf(">", ds);
      if (oe < 0) break;

      // Accept only if token is inside that opening tag.
      if (nh <= oe) { nextDivStart = ds; break; }

      j = nh + WRAP_TOKEN.length;
      if (++guard > 80) break;
    }

    const block = html.slice(divStart, nextDivStart > 0 ? nextDivStart : html.length);
    i = nextDivStart > 0 ? nextDivStart : html.length;

    if (stats) stats.wrapper_blocks++;

    // Extract wrapper attribute data-infos-ids (robust against spaces + quotes).
    const infosRaw =
      firstMatch(openTag, /data-infos-ids\s*=\s*["']([^"']*)["']/i) ||
      firstMatch(openTag, /data-infos-ids\s*=\s*["']?([^"'>\s]*)/i) ||
      "";

    const infosIds = (infosRaw || "").split(",").map(s => s.trim()).filter(Boolean);
    const markerFree = infosIds.some(id => freeIds.has(id));

    // Title + Link
    const mTitle = /<a[^>]+href="(https:\/\/zoom\.lublin\.pl\/wydarzenie\/[^"]+)"[^>]*class="event-card__link"[^>]*>\s*<h3[^>]*>([\s\S]*?)<\/h3>/i.exec(block);
    if (!mTitle) continue;

    const href  = (mTitle[1] || "").trim();
    const title = text(mTitle[2]);
    if (!title) continue;

    const evref = zoomEventRef(href);
    const debug = (debugSlug && evref === debugSlug);

    // Venue
    const venue = text(firstMatch(block, /<div\s+class="event-card__place">[\s\S]*?<span>([\s\S]*?)<\/span>/i) || "");

    // Category
    const category = text(firstMatch(block, /<div\s+class="event-card__data-right"[\s\S]*?<a[^>]*class="c-btn[^"]*c-btn--primary[^"]*"[^>]*>\s*<span>([\s\S]*?)<\/span>/i) || "");

    // Date/Time — read ALL <span> inside .event-card__dates (supports two-span ranges)
    const datesBlock = sliceFirstBlock(block, "event-card__dates");
    const spanTexts  = extractDateSpanTexts(datesBlock);
    const { Date, Time, End } = parseListDateTimeFromSpans(spanTexts);

    // Payment in S2-07A: only FREE ("No") or UNKNOWN ("")
    // detectPaymentList(block) is list-only (never forces "Yes"); markerFree has priority.
    const p = detectPaymentList(block); // "No" or ""
    const isFree = markerFree || (p === "No");

    if (stats) stats.wrapper_events++;

    out.push({
      Title: title,
      Date: Date || "",
      Time: Time || "",
      Venue: venue || "",
      Category: category || "",
      Link: href,
      event_ref: evref,
      "Payment for Entry": isFree ? "No" : "",
      Source: "zoom.lublin.pl",
      _EndDate: End || Date || "",
      _fp_url: urlPath(href),

      ...(debug ? {
        __debug_parseMode: "wrapper",
        __debug_infosRaw: infosRaw,
        __debug_markerFree: markerFree,
        __debug_detectPayment: p,
        __debug_isFree: isFree,
        __debug_openTag: openTag.slice(0, 250)
      } : {})
    });

    if (++blocks >= MAX_BLOCKS) break;
  }

  // If wrapper pass produced events, return them (best effort).
  if (out.length) return out;

  // ---------- Fallback: legacy behavior (no wrapper attrs available) ----------
  i = 0;
  while (true) {
    const start = html.indexOf(CARD, i);
    if (start < 0) break;
    const next  = html.indexOf(CARD, start + 1);
    const block = html.slice(start, next > 0 ? next : html.length);
    i = next > 0 ? next : html.length;

    if (stats) stats.card_blocks++;

    // Title + Link
    const mTitle = /<a[^>]+href="(https:\/\/zoom\.lublin\.pl\/wydarzenie\/[^"]+)"[^>]*class="event-card__link"[^>]*>\s*<h3[^>]*>([\s\S]*?)<\/h3>/i.exec(block);
    if (!mTitle) continue;
    const href  = (mTitle[1] || "").trim();
    const title = text(mTitle[2]);
    if (!title) continue;

    const evref = zoomEventRef(href);
    const debug = (debugSlug && evref === debugSlug);

    // Venue
    const venue = text(firstMatch(block, /<div\s+class="event-card__place">[\s\S]*?<span>([\s\S]*?)<\/span>/i) || "");

    // Category
    const category = text(firstMatch(block, /<div\s+class="event-card__data-right"[\s\S]*?<a[^>]*class="c-btn[^"]*c-btn--primary[^"]*"[^>]*>\s*<span>([\s\S]*?)<\/span>/i) || "");

    // Date/Time — read ALL <span> inside .event-card__dates (supports two-span ranges)
    const datesBlock = sliceFirstBlock(block, "event-card__dates");
    const spanTexts  = extractDateSpanTexts(datesBlock);
    const { Date, Time, End } = parseListDateTimeFromSpans(spanTexts);

    // Payment: list-only (FREE or UNKNOWN)
    const p = detectPaymentList(block); // "No" or ""
    const isFree = (p === "No");

    if (stats) stats.card_events++;

    out.push({
      Title: title,
      Date: Date || "",
      Time: Time || "",
      Venue: venue || "",
      Category: category || "",
      Link: href,
      event_ref: evref,
      "Payment for Entry": isFree ? "No" : "",
      Source: "zoom.lublin.pl",
      _EndDate: End || Date || "",
      _fp_url: urlPath(href),

      ...(debug ? {
        __debug_parseMode: "card",
        __debug_detectPayment: p,
        __debug_isFree: isFree
      } : {})
    });

    if (out.length >= MAX_BLOCKS) break;
  }

  return out;
}

// Read all <span>…</span> texts within the dates block
function extractDateSpanTexts(blockHtml) {
  const re = /<span>([\s\S]*?)<\/span>/gi;
  const spans = [];
  let m;
  while ((m = re.exec(blockHtml)) !== null) {
    const s = text(m[1]);
    if (s) spans.push(s);
  }
  return spans;
}

// Accepts tokens from .event-card__dates, supports:
//  • "YYYY-MM-DD — HH:MM, HH:MM"
//  • "YYYY-MM-DD — HH:MM"
//  • "YYYY-MM-DD — YYYY-MM-DD" (including split across two <span>s)
function parseListDateTimeFromSpans(spans) {
  if (!spans || !spans.length) return { Date: "", Time: "", End: "" };
  const normHyph = s => (s || "").replace(/[‐-‒–—]/g, "-");

  const s0 = normHyph(spans[0]);
  const s1 = spans[1] ? normHyph(spans[1]) : "";

  // Try: first token has date, optional " - ...", maybe times; second token pure date ⇒ range (no times)
  const m0 = /^\s*(\d{4}-\d{2}-\d{2})\s*(?:-)?\s*(.*)\s*$/.exec(s0);
  if (m0) {
    const d = m0[1];
    const rest = m0[2] || "";
    const hasTime = /\b[0-2]?\d:[0-5]\d\b/.test(rest);

    if (!hasTime && /^\s*\d{4}-\d{2}-\d{2}\s*$/.test(s1)) {
      // Two-span range: "<span>YYYY-MM-DD — </span><span>YYYY-MM-DD</span>"
      return { Date: d, Time: "", End: s1.trim() };
    }

    // Times in first token
    const times = Array.from(new Set((rest.match(/\b([0-2]?\d:[0-5]\d)\b/g) || [])
      .map(padTime))).sort();
    return { Date: d, Time: times.join(", "), End: d };
  }

  // Fallback: "YYYY-MM-DD - YYYY-MM-DD" in a single span
  const mRange = /^\s*(\d{4}-\d{2}-\d{2})\s*-\s*(\d{4}-\d{2}-\d{2})\s*$/.exec(s0);
  if (mRange) return { Date: mRange[1], Time: "", End: mRange[2] };

  return { Date: "", Time: "", End: "" };
}

/* ---------------- Enrichment (detail pages) — DOM-precise ---------------- */
async function enrichDetails(list, cap, ctx, budget) {
  // Skip ongoing/no-time ranges completely to save subrequests:
  // definition: no Time AND _EndDate present AND _EndDate !== Date
  const isOngoingNoTime = (e) => !((e.Time || "").trim()) && !!e._EndDate && e._EndDate !== e.Date;

  const targets = list
    .filter(e => !isOngoingNoTime(e)) // NEW: budget saver
    .filter(e => !(e["Payment for Entry"] || "") || !e.Time || !e.Venue || !e.Category || !e._EndDate);

  const scanned = [];
  let enriched = 0;

  for (const e of targets.slice(0, cap)) {
    if (budget.used >= budget.max) break;

    const r = await fetchPage(e.Link, ctx, budget, { useCache: false, writeCache: false });
    if (!r.ok) continue;
    scanned.push(e.Link);

    const info = parseZoomDetail(r.html, e.Date);

    if (info.Payment === "Yes" && e["Payment for Entry"] !== "Yes") e["Payment for Entry"] = "Yes";
    else if (info.Payment === "No" && !e["Payment for Entry"])      e["Payment for Entry"] = "No";

    if (info.Time)                    e.Time      = e.Time ? mergeTimes(e.Time, info.Time) : info.Time;
    if (info.Venue && !e.Venue)       e.Venue     = info.Venue;
    if (info.Category && !e.Category) e.Category  = info.Category;

    if (info.EndDate) {
      if (!e._EndDate || info.EndDate > e._EndDate) e._EndDate = info.EndDate;
    }

    enriched++;
  }
  return { enriched, scanned };
}

function parseZoomDetail(raw, forDate /* YYYY-MM-DD */) {
  const html = normalizeHtml(raw);

  // --- blocks ---
  const datesBlock   = sliceFirstBlock(html, "single-event__dates");
  const placeBlock   = sliceFirstBlock(html, "single-event__place");
  const catsBlock    = sliceFirstBlock(html, "single-event__categories");
  const ticketsBlock = sliceFirstBlock(html, "single-event__tickets");

  // PAYMENT — read tickets block first (fallback to page-level if missing)
  const Payment = detectPaymentFromTickets(ticketsBlock) || detectPaymentPage(html);

  // TIMES — rows like: <span>YYYY-MM-DD — HH:MM</span> or pure ranges
  const times = [];
  const datesSeen = new Set();
  const reSpan = /<span>([\s\S]*?)<\/span>/gi;
  let m;
  while ((m = reSpan.exec(datesBlock)) !== null) {
    const s = text(m[1]).replace(/[‐-‒–—]/g, "-");
    const t1 = /^\s*(\d{4}-\d{2}-\d{2})\s*-\s*([0-2]?\d:[0-5]\d)\s*$/.exec(s);
    const t2 = /^\s*(\d{4}-\d{2}-\d{2})\s*-\s*(\d{4}-\d{2}-\d{2})\s*$/.exec(s);
    if (t1) {
      const d = t1[1], hh = padTime(t1[2]);
      datesSeen.add(d);
      if (!forDate || d === forDate) times.push(hh);
    } else if (t2) {
      datesSeen.add(t2[1]); datesSeen.add(t2[2]);
    }
  }
  const Time = Array.from(new Set(times)).sort().join(", ");
  const EndDate = datesSeen.size ? Array.from(datesSeen).sort().slice(-1)[0] : "";

  // VENUE
  const Venue = text(firstMatch(placeBlock, /<span>([\s\S]*?)<\/span>/i) || "");

  // CATEGORY
  const Category = text(firstMatch(catsBlock, /class="c-btn[^"]*c-btn--primary[^"]*"[^>]*>\s*<span>([\s\S]*?)<\/span>/i) || "");

  return { Time, Venue, Category, Payment, EndDate };
}

/* ---------------- Payment normalization (ADR-0007) ---------------- */
// On list: only detect clearly FREE -> "No"; never force "Yes" on list
function detectPaymentList(block){
  const t = norm(block);
  return (/(?:\b|>)(wstep wolny|bezplatn|darmow|gratis|nieodplat)(?:\b|<)/.test(t)) ? "No" : "";
}

// Prefer tickets block (detail)
function detectPaymentFromTickets(block){
  const t = norm(text(block || ""));
  const hasFree = /(wstep wolny|bezplatn|darmow|gratis|free|nieodplat)/.test(t);
  const hasPaid = /(platn|platny|bilet|bilety|wejsciow|oplata|cena|\b\d+[.,]?\d*\s*(zl|pln)\b)/.test(t);
  if (hasFree && !hasPaid) return "No";
  if (hasPaid && !hasFree) return "Yes";
  if (hasFree && hasPaid) return /\b\d+[.,]?\d*\s*(zl|pln)\b/.test(t) ? "Yes" : "No";
  return "";
}

// Fallback: page-level heuristic
function detectPaymentPage(html){
  const t = norm(text(html || ""));
  const hasFree = /(wstep wolny|bezplatn|darmow|gratis|free|nieodplat)/.test(t);
  const hasPaid = /(platn|platny|bilet|bilety|wejsciow|oplata|cena|\b\d+[.,]?\d*\s*(zl|pln)\b)/.test(t);
  if (hasFree && !hasPaid) return "No";
  if (hasPaid && !hasFree) return "Yes";
  if (hasFree && hasPaid) return /\b\d+[.,]?\d*\s*(zl|pln)\b/.test(t) ? "Yes" : "No";
  return "";
}

/* ---------------- Grouping & small utils ---------------- */
function groupSameDayShowtimes(list){
  const key = e => [e.Title, e.Date, e.Venue, e.Category, e.Link]
    .map(s => (s||"").toLowerCase()).join("|");

  const map = new Map();
  for (const e of list) {
    const k = key(e);
    if (!map.has(k)) {
      map.set(k, { ...e, Time: e.Time ? [e.Time] : [] });
    } else if (e.Time) {
      map.get(k).Time.push(e.Time);
    }
  }
  return [...map.values()].map(e => {
    const uniq = Array.from(new Set((e.Time || []).flatMap(t => (t||"").split(",").map(s => s.trim()).filter(Boolean))));
    return { ...e, Time: uniq.sort().join(", ") };
  });
}

function mergeTimes(a, b){
  const toArr = s => (s||"").split(",").map(x => x.trim()).filter(Boolean);
  const set = new Set([...toArr(a), ...toArr(b)]);
  return Array.from(set).sort().join(", ");
}

/* ---------------- Generic helpers ---------------- */
function ensureSlash(url){ return url.endsWith("/") ? url : (url + "/"); }
function sliceFirstBlock(html, className){
  const i = html.indexOf(className);
  if (i < 0) return "";
  const open = html.lastIndexOf("<div", i);
  const start = open >= 0 ? open : i;
  return html.slice(start, start + 4000); // local slice is enough & cheap
}
function flag(v){ return ["1","true","yes","y"].includes(String(v||"").toLowerCase()); }
function int(v,d){ const n=parseInt(v??"",10); return Number.isFinite(n)?n:d; }
function clamp(n,lo,hi){ return Math.max(lo, Math.min(hi,n)); }

function parseYMD(s){ const m=/^(\d{4})-(\d{2})-(\d{2})$/.exec(s||""); return m?new Date(Date.UTC(+m[1],+m[2]-1,+m[3])):null; }
function addDays(d,n){ const x=new Date(d); x.setUTCDate(x.getUTCDate()+n); return x; }
function fmt(d){ return d.toISOString().slice(0,10); }
function rangesOverlap(a1,a2,b1,b2){ return a1 <= b2 && b1 <= a2; }

function normalizeHtml(s){ return (s||"").replace(/\r/g,"").replace(/\t/g," ").replace(/&nbsp;/g," ").replace(/[‐-‒–—]/g,"—"); }
function stripTags(s){ return (s||"").replace(/<[^>]*>/g," "); }
function decodeEntities(s){
  return (s||"")
    .replace(/&quot;|&#34;/g,'"').replace(/&apos;|&#39;/g,"'")
    .replace(/&amp;/g,"&").replace(/&lt;/g,"<").replace(/&gt;/g,">")
    .replace(/&laquo;|&#171;/g,"«").replace(/&raquo;|&#187;/g,"»");
}
function text(s){ return decodeEntities(stripTags(s)).replace(/\s+/g," ").trim(); }

function norm(s){
  const t = text(s).normalize("NFKD").replace(/[\u0300-\u036f]/g,"");
  return t
    .replace(/[łŁ]/g,"l")
    .replace(/[śŚ]/g,"s")
    .replace(/[ćĆ]/g,"c")
    .replace(/[źŻŹ]/g,"z")
    .replace(/[óÓ]/g,"o")
    .replace(/[ńŃ]/g,"n")
    .replace(/[ąĄ]/g,"a")
    .replace(/[ęĘ]/g,"e")
    .toLowerCase();
}
function padTime(t) {
  const m = /^\s*([0-2]?\d):([0-5]\d)\s*$/.exec(t || "");
  if (!m) return (t || "").trim();
  const hh = String(parseInt(m[1], 10)).padStart(2, "0");
  return `${hh}:${m[2]}`;
}

function lastMatch(str, re){ let m, last=null; while((m=re.exec(str))!==null){ last = m[1] || m[0]; } return last; }
function firstMatch(str, re){ re.lastIndex=0; const m=re.exec(str); return m ? (m[1] || m[0]) : ""; }
function absUrl(base, href){ try { return new URL(href, base).toString(); } catch { return href; } }
function urlPath(u){ try { return new URL(u).pathname.replace(/\/+$/,""); } catch { return ""; } }

function json(obj,status=200){
  return new Response(JSON.stringify(obj), {
    status,
    headers: { "content-type":"application/json; charset=utf-8", "access-control-allow-origin":"*" }
  });
}
function jserr(msg,status=400){ return json({ error: String(msg) }, status); }

function zoomEventRef(href){
  const p = urlPath(href).toLowerCase();          // "/wydarzenie/<slug>"
  const seg = p.split("/").filter(Boolean).pop() || "";
  return seg || p;
}
