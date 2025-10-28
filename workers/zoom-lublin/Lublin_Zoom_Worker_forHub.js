// zoom-adapter-worker.js
export default {
  async fetch(request, env, ctx) {
    const u = new URL(request.url);
    const q = u.searchParams;

    // ---- inputs (aligned with Lublin worker) ----
    const startISO = (q.get("date") || "").trim();                // YYYY-MM-DD (required in normal mode)
    const period   = (q.get("period") || "day").toLowerCase();     // day | week
    const wantRows = ["1","true","yes"].includes((q.get("sheet") || "").toLowerCase());
    const groupTimes = ["1","true","yes"].includes((q.get("group_times")||"").toLowerCase()); // read flag
    const limit    = clamp(int(q.get("limit") ?? q.get("max_events"), 200), 1, 10000);
    const pagesMax = clamp(int(q.get("pages"), 1), 1, 5);          // follow at most N list pages
    let days       = int(q.get("days"), 0);
    if (!days) days = period === "week" ? 7 : 1;

    // list page override (for testing), default is main listing
    const listUrl = q.get("url") || "https://zoom.lublin.pl/wydarzenia/";

    const debug = (q.get("debug") || "").toLowerCase();

    // ---- fetch once for debug quick-outs ----
    const first = await fetchPage(listUrl, ctx);
    if (!first.ok) {
      return jserr(JSON.stringify({ source: "zoom.lublin.pl", url: listUrl, status: first.status }), 502);
    }
    const html = first.html;

    // ---- DEBUG PATHS (no date required) ----
    if (debug === "titles") {
      const parsed = parseZoom(html, listUrl);
      return json({ sample_count: parsed.length, first_10: parsed.slice(0, 10) });
    }
    if (debug === "dates") {
      const n = normalizeHtml(html);
      const m = n.match(/\b\d{4}-\d{2}-\d{2}\b/g) || [];
      const uniq = [...new Set(m)].sort();
      return json({ first: uniq[0], last: uniq.at(-1), count: uniq.length, sample: uniq.slice(0, 20) });
    }
    if (debug === "peek") {
      const blocks = peekBlocks(html, listUrl).slice(0, 3);
      return json({ blocks_count: blocks.length, blocks });
    }

    // ---- NORMAL MODE (requires date) ----
    if (!startISO) return jserr("Missing ?date=YYYY-MM-DD", 400);
    const start = parseYMD(startISO);
    if (!start) return jserr("Bad ?date format, expected YYYY-MM-DD", 400);
    const end   = addDays(start, days - 1);

    const scanned = [listUrl];
    let pages_scanned = 1;

    // page 1
    const all1 = parseZoom(html, listUrl);

    const fetchCap = groupTimes ? limit * 3 : limit;

    // optional pagination: /wydarzenia/page/2/
    const all = [...all1];
    for (let p = 2; p <= pagesMax && all.length < fetchCap; p++) {
      const next = new URL(`page/${p}/`, listUrl).toString();
      const r = await fetchPage(next, ctx);
      pages_scanned++; scanned.push(next);
      if (!r.ok) break;
      all.push(...parseZoom(r.html, next));
    }

    // filter by requested date window (support single date or ranges from data-end-date)
    const events = [];
    for (const e of all) {
      const s = parseYMD(e.Date);
      const eEnd = parseYMD(e._EndDate || e.Date);
      if (!s || !eEnd) continue;
      if (rangesOverlap(s, eEnd, start, end)) {
        events.push(e);
        if (events.length >= fetchCap) break;
      }
    }
    // ---- group same-day showtimes if requested ----
    const finalized = groupTimes ? groupSameDayShowtimes(events) : events;
    // enforce the real limit here
    const sliced = finalized.slice(0, limit);

    const payload = {
      source: "zoom.lublin.pl",
      url: listUrl,
      start: fmt(start),
      end: fmt(end),
      pages_scanned,
      scanned,
      count: sliced.length,
      events: sliced
    };
    
    if (wantRows) {
      payload.rows = sliced.map(e => ({
        values: [
          e.Title || "",
          e.Date || "",
          e.Time || "",
          e.Venue || "",
          e.Category || "",
          e.Link || "",
          e["Image URL"] || "",
          e["Payment for Entry"] || "",   // <— NEW COLUMN
          e.Source || "zoom.lublin.pl"
        ]
      }));
    }

    return json(payload);
  }
};

/* ---------------- HTTP + cache (same policy as Lublin) ---------------- */
async function fetchPage(url, ctx) {
  const cache = caches.default;
  const req = new Request(url, { headers: {
    "User-Agent": "Mozilla/5.0 (compatible; LublinEventsBot/1.0)",
    "Accept-Language": "pl-PL,pl;q=0.9,en;q=0.8",
    "Accept": "text/html,*/*",
    "Cache-Control": "no-cache"
  }});
  const cached = await cache.match(req);
  if (cached) return { ok: true, status: 200, html: await cached.text() };

  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 20000);
  try {
    let res = await fetch(req, { signal: ctrl.signal, redirect: "follow" });
    if (!res.ok && [520, 522, 523, 524].includes(res.status)) {
      res = await fetch(req, { signal: ctrl.signal, redirect: "follow" });
    }
    const html = await res.text();
    if (res.ok) {
      const out = new Response(html, {
        headers: {
          "content-type": "text/html; charset=utf-8",
          "cache-control": "public, max-age=900"
        }
      });
      ctx && ctx.waitUntil(cache.put(req, out.clone()));
      return { ok: true, status: res.status, html };
    }
    return { ok: false, status: res.status, html };
  } finally {
    clearTimeout(t);
  }
}

/* ---------------- Parser for zoom.lublin.pl ---------------- */
function parseZoom(raw, baseUrl) {
  const html = normalizeHtml(raw);
  const out = [];

  // Match title + canonical event URL
  const reTitle = /<a\s+href="(https:\/\/zoom\.lublin\.pl\/wydarzenie\/[^"]+)"[^>]*class="event-card__link"[^>]*>\s*<h3[^>]*>([\s\S]*?)<\/h3>\s*<\/a>/gi;

  let m;
  while ((m = reTitle.exec(html)) !== null) {
    const href  = absUrl(baseUrl, (m[1] || "").trim());
    const title = text(m[2]);
    if (!title) continue;

    // Search in a local window around the title
    const backStart = Math.max(0, m.index - 1500);
    const fwdEnd    = Math.min(html.length, m.index + 1500);
    const ctxStr    = html.slice(backStart, fwdEnd);

    // Prefer wrapper attributes for dates
    const dStart = lastMatch(ctxStr, /data-start-date="([0-9]{4}-[0-9]{2}-[0-9]{2})"/gi);
    const dEnd   = lastMatch(ctxStr, /data-end-date="([0-9]{4}-[0-9]{2}-[0-9]{2})"/gi);

    // Time may appear in the dates block "YYYY-MM-DD — HH:MM"
    const time  = lastMatch(ctxStr, /<span>\s*[0-9]{4}-[0-9]{2}-[0-9]{2}\s*[—\-–]\s*([0-9]{1,2}:[0-9]{2})\s*<\/span>/gi) ||
                  lastMatch(ctxStr, /class="event-card__time"[^>]*>\s*([0-9]{1,2}:[0-9]{2})\s*</gi) ||
                  "";

    // Venue
    const venue = lastMatch(ctxStr, /<div\s+class="event-card__place">[\s\S]*?<span>([\s\S]*?)<\/span>/gi);

    // Category (right block)
    const category = lastMatch(ctxStr, /class="c-btn c-btn--primary"[^>]*>[\s\S]*?<span>([\s\S]*?)<\/span>/gi) ||
                     lastMatch(ctxStr, /https:\/\/zoom\.lublin\.pl\/gatunek\/[^"]+"[^>]*>[\s\S]*?<span>([\s\S]*?)<\/span>/gi) || "";

    // Image
    const img = lastMatch(ctxStr, /<img[^>]+src="([^"]+)"[^>]*class="[^"]*wp-post-image/gi);

    const iso = dStart || ""; // main Date column = start date

    out.push({
      Title: title,
      Date: iso,
      Time: time,
      Venue: text(venue || ""),
      Category: text(category || ""),
      Link: href,
      "Image URL": absUrl(baseUrl, img || ""),
      "Payment for Entry": detectPayment(ctxStr), // <— NEW
      Source: "zoom.lublin.pl",
      _EndDate: dEnd || "",
      _fp_url: urlPath(href),                     // <— NEW
      _fp_tdv: f_title_date_venue({ Title: title, Date: iso, Venue: venue }) // <— NEW
    });
  }

  return out;
}

/* ---------------- Small debug helper ---------------- */
function peekBlocks(html, base) {
  const out = [];
  const re = /<div\s+class="event-card-wrapper\b[\s\S]*?<\/div>\s*<\/div>/gi;
  let m, i = 0;
  while ((m = re.exec(html)) !== null && i < 10) {
    out.push({ at: m.index, snippet: html.slice(m.index, Math.min(html.length, m.index + 800)) });
    i++;
  }
  return out;
}

/* ---------------- Utils (same as Lublin) ---------------- */
//  cleans HTML text (tabs, &nbsp;, dash variants)
function normalizeHtml(s) {
  return (s || "")
    .replace(/\r/g, "")
    .replace(/\t/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/[‐-‒–—]/g, "—");
}
function text(s) { return stripTags(s).replace(/\s+/g, " ").trim(); }
function stripTags(s) { return (s || "").replace(/<[^>]*>/g, " "); }
function lastMatch(str, re) {
  let m, last = null;
  while ((m = re.exec(str)) !== null) last = m[1];
  return last;
}
function int(v, d) { const n = parseInt(v ?? "", 10); return Number.isFinite(n) ? n : d; }
function clamp(n, lo, hi) { return Math.max(lo, Math.min(hi, n)); }
function parseYMD(s) { const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s||""); return m ? new Date(Date.UTC(+m[1], +m[2]-1, +m[3])) : null; }
function addDays(d, n) { const x = new Date(d); x.setUTCDate(x.getUTCDate() + n); return x; }
function fmt(d) { return d.toISOString().slice(0,10); }
function rangesOverlap(a1, a2, b1, b2) { return a1 <= b2 && b1 <= a2; }
function absUrl(base, href) { try { return new URL(href, base).toString(); } catch { return href; } }
function json(obj, status=200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "access-control-allow-origin": "*"
    }
  });
}
function jserr(msg, status=400) { return json({ error: msg }, status); }

// find Payment info
function detectPayment(textBlock){
  const t = (textBlock||"").toLowerCase();
  const hasFree = /(wst[eę]p\s+wolny|bezpłatn|darmow|free)/.test(t);
  const hasPaid = /(bilet|bilety|wejściów|pln|zł|\b\d+[,.]?\d*\s*zł\b)/.test(t);
  if (hasFree && !hasPaid) return "No";
  if (hasPaid && !hasFree) return "Yes";
  return "";
}

//   canonicalizes text for fingerprint keys (strip diacritics, lowercase, strip punctuation).
function normalizeForKey(s){
  return (s||"")
    .normalize("NFKD").replace(/[\u0300-\u036f]/g,"")
    .toLowerCase().replace(/[^a-z0-9 ]/g," ")
    .replace(/\s+/g," ").trim();
}
function f_title_date_venue(e){ return `${normalizeForKey(e.Title)}|${e.Date}|${normalizeForKey(e.Venue)}`; }

function urlPath(u){ try { return new URL(u).pathname.replace(/\/+$/,""); } catch { return ""; } }

// group days showtimes
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
    const uniq = Array.from(new Set((e.Time || []).filter(Boolean)));
    return { ...e, Time: uniq.sort().join(", ") };
  });
}