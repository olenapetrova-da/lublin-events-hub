// Lublin_Zoom_Worker_forHub.js — zoom.lublin.pl adapter (budget-safe + enrichment)
// ADRs: 0005, 0006, 0007, 0008, 0009, 0010

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

      const enrich     = flag(q.get("enrich"));
      const enrichMax  = clamp(int(q.get("enrich_max"), 15), 0, 50);

      // ---- Subrequest budget (ADR-0010) ----
      const userBudget = clamp(int(q.get("budget"), 0), 0, 48);
      const budget     = { used: 0, max: userBudget || 48 };

      const listUrl = ensureSlash(q.get("url") || "https://zoom.lublin.pl/wydarzenia/");

      if (!startISO) return jserr("Missing ?date=YYYY-MM-DD", 400);
      const start = parseYMD(startISO);
      if (!start) return jserr("Bad ?date format, expected YYYY-MM-DD", 400);
      const end = addDays(start, days - 1);

      const scanned = [];
      let pages_scanned = 0;

      // ---- Crawl list pages (budget-aware)
      const events = [];
      const fetchCap = groupTimes ? Math.min(limit * 3, 2000) : limit;
      const listCollectCap = enrich ? Math.max(enrichMax * 10, 100) : fetchCap;

      // page 1
      let r = await fetchPage(listUrl, ctx, budget, { useCache: true, writeCache: true });
      pages_scanned++; scanned.push(listUrl);
      if (r.ok) collect(parseZoomList(r.html));

      // next pages: /wydarzenia/page/2/
      for (let p = 2; p <= pagesMax; p++) {
        if (budget.used >= budget.max || events.length >= listCollectCap) break;
        const next = new URL(`page/${p}/`, listUrl).toString();
        r = await fetchPage(next, ctx, budget, { useCache: true, writeCache: true });
        pages_scanned++; scanned.push(next);
        if (!r.ok) break;
        collect(parseZoomList(r.html));
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
      const finalized = groupTimes ? groupSameDayShowtimes(filtered) : filtered;
      const sliced = finalized.slice(0, limit);

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
        count: sliced.length,
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

/* ---------------- List parser (Zoom cards) — DOM-precise ---------------- */
function parseZoomList(raw) {
  const html = normalizeHtml(raw);
  const out = [];

  // iterate per <div class="event-card"> ... </div>
  let i = 0;
  while (true) {
    const start = html.indexOf('<div class="event-card"', i);
    if (start < 0) break;
    const next  = html.indexOf('<div class="event-card"', start + 1);
    const block = html.slice(start, next > 0 ? next : html.length);
    i = next > 0 ? next : html.length;

    // Title + Link
    const mTitle = /<a[^>]+href="(https:\/\/zoom\.lublin\.pl\/wydarzenie\/[^"]+)"[^>]*class="event-card__link"[^>]*>\s*<h3[^>]*>([\s\S]*?)<\/h3>/i.exec(block);
    if (!mTitle) continue;
    const href  = (mTitle[1] || "").trim();
    const title = text(mTitle[2]);

    // Venue
    const venue = text(firstMatch(block, /<div\s+class="event-card__place">[\s\S]*?<span>([\s\S]*?)<\/span>/i) || "");

    // Category
    const category = text(firstMatch(block, /<div\s+class="event-card__data-right"[\s\S]*?<a[^>]*class="c-btn[^"]*c-btn--primary[^"]*"[^>]*>\s*<span>([\s\S]*?)<\/span>/i) || "");

    // Date/Time from .event-card__dates span
    const dtText = text(firstMatch(block, /<div\s+class="event-card__dates"[\s\S]*?<span>([\s\S]*?)<\/span>/i) || "");
    const { Date, Time, End } = parseListDateTime(dtText);

    out.push({
      Title: title,
      Date: Date || "",
      Time: Time || "",
      Venue: venue || "",
      Category: category || "",
      Link: href,
      "Payment for Entry": detectPaymentList(block), // list-only: "No" or ""
      Source: "zoom.lublin.pl",
      _EndDate: End || Date || "",  // ADR-0009: ensure present; default to Date
      _fp_url: urlPath(href)
    });
  }

  return out;
}

// Parse strings like:
// "2025-11-05 — 09:30, 11:30"
// "2025-11-05 — 09:30"
// "2025-11-05 — 2025-11-12"
function parseListDateTime(s){
  const t = s.replace(/[‐-‒–—]/g, "-");
  let Date = "", Time = "", End = "";
  // Range
  let m = /^\s*(\d{4}-\d{2}-\d{2})\s*-\s*(\d{4}-\d{2}-\d{2})\s*$/.exec(t);
  if (m) return { Date: m[1], Time: "", End: m[2] };

  // Date — times
  m = /^\s*(\d{4}-\d{2}-\d{2})\s*-\s*(.+)\s*$/.exec(t);
  if (m) {
    Date = m[1];
    const times = Array.from(new Set((m[2].match(/\b([0-2]?\d:[0-5]\d)\b/g) || []).map(x => x.trim()))).sort();
    Time = times.join(", ");
    End = Date;
  }
  return { Date, Time, End };
}

/* ---------------- Enrichment (detail pages) — DOM-precise ---------------- */
async function enrichDetails(list, cap, ctx, budget) {
  const targets = list.filter(
    e => !(e["Payment for Entry"] || "") || !e.Time || !e.Venue || !e.Category || !e._EndDate
  );

  const scanned = [];
  let enriched = 0;

  for (const e of targets.slice(0, cap)) {
    if (budget.used >= budget.max) break;

    // Skip cache for details to preserve budget for real content
    const r = await fetchPage(e.Link, ctx, budget, { useCache: false, writeCache: false });
    if (!r.ok) continue;
    scanned.push(e.Link);

    const info = parseZoomDetail(r.html, e.Date);

    // Payment: Yes overrides No/blank; No fills blanks only
    if (info.Payment === "Yes" && e["Payment for Entry"] !== "Yes") e["Payment for Entry"] = "Yes";
    else if (info.Payment === "No" && !e["Payment for Entry"])      e["Payment for Entry"] = "No";

    if (info.Time)                 e.Time      = e.Time ? mergeTimes(e.Time, info.Time) : info.Time;
    if (info.Venue && !e.Venue)    e.Venue     = info.Venue;
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

  // TIMES — from dates block, rows like: <span>YYYY-MM-DD — HH:MM</span>
  const times = [];
  const datesSeen = new Set();
  const reSpan = /<span>([\s\S]*?)<\/span>/gi;
  let m;
  while ((m = reSpan.exec(datesBlock)) !== null) {
    const s = text(m[1]).replace(/[‐-‒–—]/g, "-");
    const t1 = /^\s*(\d{4}-\d{2}-\d{2})\s*-\s*([0-2]?\d:[0-5]\d)\s*$/.exec(s);
    const t2 = /^\s*(\d{4}-\d{2}-\d{2})\s*-\s*(\d{4}-\d{2}-\d{2})\s*$/.exec(s);
    if (t1) {
      const d = t1[1], hh = t1[2];
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
