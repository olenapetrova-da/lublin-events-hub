// Lublin_Zoom_Worker_forHub.js — zoom.lublin.pl adapter (budget-safe + optional enrichment)
// ADRs: 0005 (raw→normalized), 0006 (enrichment in adapters), 0007 (Payment Yes/No/""),
//       0008 (fields to enrich), 0009 (_EndDate present)

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

      // ---- Subrequest budget (HARD CAP) ----
      // Zoom listing isn't per-day; we paginate N list pages for the whole range.
      const listPagesBudget  = pagesMax;                    // page/1..pagesMax
      const enrichBudgetHint = enrich ? Math.min(enrichMax, 15) : 0;
      const headroom         = 6;                           // retry/redirect/slop
      const userBudget       = clamp(int(q.get("budget"), 0), 0, 48);
      const budgetMax        = Math.min(48, userBudget || (listPagesBudget + enrichBudgetHint + headroom));
      const budget           = { used: 0, max: budgetMax };

      // Optional explicit list URL
      const listUrl = ensureSlash(q.get("url") || "https://zoom.lublin.pl/wydarzenia/");

      if (!startISO) return jserr("Missing ?date=YYYY-MM-DD", 400);
      const start = parseYMD(startISO);
      if (!start) return jserr("Bad ?date format, expected YYYY-MM-DD", 400);
      const end = addDays(start, days - 1);

      const scanned = [];
      let pages_scanned = 0;

      // ---- Fetch page 1
      const events = [];
      const fetchCap = groupTimes ? Math.min(limit * 3, 2000) : limit;

      const r1 = await fetchPage(listUrl, ctx, budget);
      pages_scanned++; scanned.push(listUrl);
      if (r1.ok) collect(parseZoomList(r1.html, listUrl));

      // ---- Paginate: /wydarzenia/page/2/
      for (let p = 2; p <= pagesMax; p++) {
        if (budget.used >= budget.max || events.length >= fetchCap) break;
        const next = new URL(`page/${p}/`, listUrl).toString();
        const r = await fetchPage(next, ctx, budget);
        pages_scanned++; scanned.push(next);
        if (!r.ok) break;
        collect(parseZoomList(r.html, next));
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

      // ---- Optional enrichment (detail pages) within strict budget
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
          if (events.length >= fetchCap) break;
        }
      }
    } catch (err) {
      return jserr(String(err && err.message ? err.message : err), 500);
    }
  }
};

/* ---------------- HTTP (budget-aware + cache) ---------------- */
async function fetchPage(url, ctx, budget) {
  if (budget.used >= budget.max) return { ok: false, status: 0, html: "" };

  const cache = caches.default;
  const req = new Request(url, {
    headers: {
      "User-Agent": "LublinEventsBot/1.0",
      "Accept-Language": "pl-PL,pl;q=0.9,en;q=0.8",
      "Accept": "text/html,*/*"
    }
  });

  const cached = await cache.match(req);
  if (cached) return { ok: true, status: 200, html: await cached.text() };

  // Reserve budget BEFORE network to prevent racing over the cap
  if (++budget.used > budget.max) {
    budget.used = budget.max;
    return { ok: false, status: 0, html: "" };
  }

  const ctrl = new AbortController();
  const to = setTimeout(() => ctrl.abort(), 20000);

  try {
    let res = await fetch(req, { signal: ctrl.signal, redirect: "follow" });

    // Single retry for transient CF errors; retry also consumes budget
    if (!res.ok && [520, 522, 523, 524].includes(res.status) && budget.used < budget.max) {
      if (++budget.used <= budget.max) {
        res = await fetch(req, { signal: ctrl.signal, redirect: "follow" });
      }
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
  } catch (_e) {
    return { ok: false, status: 0, html: "" };
  } finally {
    clearTimeout(to);
  }
}

/* ---------------- List parser (Zoom cards) ---------------- */
function parseZoomList(raw, baseUrl) {
  const html = normalizeHtml(raw);
  const out = [];

  // Anchor with title (canonical link)
  const reTitle = /<a\s+href="(https:\/\/zoom\.lublin\.pl\/wydarzenie\/[^"]+)"[^>]*class="event-card__link"[^>]*>\s*<h3[^>]*>([\s\S]*?)<\/h3>\s*<\/a>/gi;

  let m;
  while ((m = reTitle.exec(html)) !== null) {
    const href  = absUrl(baseUrl, (m[1] || "").trim());
    const title = text(m[2]);
    if (!title) continue;

    // Local context
    const backStart = Math.max(0, m.index - 1500);
    const fwdEnd    = Math.min(html.length, m.index + 1500);
    const ctxStr    = html.slice(backStart, fwdEnd);

    // Dates from wrapper data-attrs
    const dStart = lastMatch(ctxStr, /data-start-date="(20\d{2}-\d{2}-\d{2})"/gi) || "";
    const dEnd   = lastMatch(ctxStr, /data-end-date="(20\d{2}-\d{2}-\d{2})"/gi) || "";

    // Time (one or more)
    const time = lastMatch(ctxStr, /<span>\s*20\d{2}-\d{2}-\d{2}\s*[—\-–]\s*([0-2]?\d:[0-5]\d)\s*<\/span>/gi) ||
                 lastMatch(ctxStr, /class="event-card__time"[^>]*>\s*([0-2]?\d:[0-5]\d)\s*</gi) || "";

    // Venue
    const venue = lastMatch(ctxStr, /<div\s+class="event-card__place">[\s\S]*?<span>([\s\S]*?)<\/span>/gi) || "";

    // Category
    const category = lastMatch(ctxStr, /class="c-btn c-btn--primary"[^>]*>[\s\S]*?<span>([\s\S]*?)<\/span>/gi) ||
                     lastMatch(ctxStr, /https:\/\/zoom\.lublin\.pl\/gatunek\/[^"]+"[^>]*>[\s\S]*?<span>([\s\S]*?)<\/span>/gi) || "";

    out.push({
      Title: text(title),
      Date: dStart,
      Time: text(time),
      Venue: text(venue),
      Category: text(category),
      Link: href,
      "Payment for Entry": detectPaymentList(ctxStr), // list-only: "No" or ""
      Source: "zoom.lublin.pl",
      _EndDate: dEnd || dStart,  // ADR-0009: ensure present; default to Date
      _fp_url: urlPath(href),
      _fp_tdv: f_title_date_venue({ Title: title, Date: dStart, Venue: text(venue) })
    });
  }

  return out;
}

/* ---------------- Enrichment (detail pages) ---------------- */
async function enrichDetails(list, cap, ctx, budget) {
  const targets = list.filter(
    e => !(e["Payment for Entry"] || "") || !e.Time || !e.Venue || !e.Category
  );

  const scanned = [];
  let enriched = 0;

  for (const e of targets.slice(0, cap)) {
    if (budget.used >= budget.max) break;

    const r = await fetchPage(e.Link, ctx, budget);
    if (!r.ok) continue;
    scanned.push(e.Link);

    const info = parseZoomDetail(r.html, e.Date);

    if (info.Payment !== "") e["Payment for Entry"] = info.Payment;     // Yes/No/""
    if (info.Time)  e.Time  = e.Time ? mergeTimes(e.Time, info.Time) : info.Time;
    if (info.Venue && !e.Venue) e.Venue = info.Venue;
    if (info.Category && !e.Category) e.Category = info.Category;

    enriched++;
  }
  return { enriched, scanned };
}

function parseZoomDetail(raw, forDate /* YYYY-MM-DD */) {
  const html = normalizeHtml(raw);

  // PAYMENT — full page inference, normalized
  const payment = detectPaymentPage(html);

  // TIME(S) — from "Terminy" section like: <span>YYYY-MM-DD — HH:MM</span>
  const times = [];
  const reDT = /<span>\s*(20\d{2}-\d{2}-\d{2})\s*[—\-–]\s*([0-2]?\d):([0-5]\d)\s*<\/span>/gi;
  let m;
  while ((m = reDT.exec(html)) !== null) {
    const d = m[1];
    const t = `${String(m[2]).padStart(2,"0")}:${m[3]}`;
    if (!forDate || d === forDate) times.push(t);
  }
  const time = Array.from(new Set(times)).sort().join(", ");

  // VENUE — try single-event__place or button span near it
  const venue = text(
    lastMatch(html, /class="single-event__place"[\s\S]*?<span>([\s\S]*?)<\/span>/gi) ||
    lastMatch(html, /class="single-event__place"[\s\S]*?class="c-btn[^"]*"[^>]*>\s*<span>([\s\S]*?)<\/span>/gi) || ""
  );

  // CATEGORY (optional on detail)
  const category = text(
    lastMatch(html, /https:\/\/zoom\.lublin\.pl\/gatunek\/[^"]+"[^>]*>\s*<span>([\s\S]*?)<\/span>/gi) || ""
  );

  return { Time: time, Venue: venue, Category: category, Payment: payment };
}

/* ---------------- Payment normalization (ADR-0007) ---------------- */
// On list: only detect clearly free -> "No"; never force "Yes" on list
function detectPaymentList(block){
  const t = norm(block);
  if (/(wstep wolny|bezplatn|darmow|gratis|free|nieodplat)/.test(t)) return "No";
  return "";
}
// On detail: derive Yes/No with numeric-price conflict rule
function detectPaymentPage(html){
  const t = norm(html);
  const hasFree = /(wstep wolny|bezplatn|darmow|gratis|free|nieodplat)/.test(t);
  const hasPaid = /(platn|platny|bilet|bilety|wejsciow|oplata|cena|pln|zl|\b\d+[.,]?\d*\s*(zl|pln)\b)/.test(t);
  if (hasFree && !hasPaid) return "No";
  if (hasPaid && !hasFree) return "Yes";
  if (hasFree && hasPaid) {
    const numeric = /\b\d+[.,]?\d*\s*(zl|pln)\b/.test(t);
    return numeric ? "Yes" : "No";
  }
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
function norm(s){ return text(s).normalize("NFKD").replace(/[\u0300-\u036f]/g,"").toLowerCase(); }

function lastMatch(str, re){ let m, last=null; while((m=re.exec(str))!==null){ last = m[1] || m[0]; } return last; }
function absUrl(base, href){ try { return new URL(href, base).toString(); } catch { return href; } }
function urlPath(u){ try { return new URL(u).pathname.replace(/\/+$/,""); } catch { return ""; } }
function normalizeForKey(s){ return text(s).normalize("NFKD").replace(/[\u0300-\u036f]/g,"").toLowerCase().replace(/[^a-z0-9 ]/g," ").replace(/\s+/g," ").trim(); }
function f_title_date_venue(e){ return `${normalizeForKey(e.Title)}|${e.Date}|${normalizeForKey(e.Venue)}`; }

function json(obj,status=200){
  return new Response(JSON.stringify(obj), {
    status,
    headers: { "content-type":"application/json; charset=utf-8", "access-control-allow-origin":"*" }
  });
}
function jserr(msg,status=400){ return json({ error: String(msg) }, status); }
