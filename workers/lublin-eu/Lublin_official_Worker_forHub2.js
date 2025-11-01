// Lublin_official_Worker_forHub2.js
// Hardened against CF "Too many subrequests":
// - Global budget covering list pages + (optional) detail enrichment
// - Early-stops pagination when fetchCap/limit is satisfied
// - Never performs a fetch once budget is exhausted
// ADRs: 0006 (enrichment in adapters), 0007 (Payment Yes/No/""), 0008 (enrich fields),
//       0009 (_EndDate policy), 0005 (raw→normalized staging)

export default {
  async fetch(request, env, ctx) {
    try {
      const url = new URL(request.url);
      const q = url.searchParams;

      // ---- Inputs (hub forwards date/period/days/pages/limit/group_times; enrich optional) ----
      const startISO   = (q.get("date") || "").trim();                       // YYYY-MM-DD
      const period     = (q.get("period") || "day").toLowerCase();           // day|week
      const days       = int(q.get("days"), period === "week" ? 7 : 1);
      const pagesMax   = clamp(int(q.get("pages"), 3), 1, 5);                // per-day pages
      const limit      = clamp(int(q.get("limit"), 200), 1, 10000);
      const groupTimes = flag(q.get("group_times"));                          // showtime grouping
      const wantRows   = flag(q.get("sheet"));                                // sheet=1 -> rows

      const enrich     = flag(q.get("enrich"));
      const enrichMax  = clamp(int(q.get("enrich_max"), 15), 0, 50);

      // ---- Subrequest budget (HARD CAP) ----
      // Strategy: compute a conservative cap: dayPages + enrichment + headroom.
      // This keeps us well under Cloudflare's per-request limit while maximizing useful work.
      const dayPagesBudget   = days * pagesMax;                // worst-case list fetches
      const enrichBudgetHint = enrich ? Math.min(enrichMax, 15) : 0;
      const headroom         = 6;                              // redirects/retries/slop
      const userBudget       = clamp(int(q.get("budget"), 0), 0, 48); // hub may pass it
      const budgetMax        = Math.min(48, userBudget || (dayPagesBudget + enrichBudgetHint + headroom));
      const budget           = { used: 0, max: budgetMax };

      // Optional direct URL for a single day page (debug/manual)
      const explicitUrl = q.get("url") || "";

      if (!startISO && !explicitUrl) {
        return jserr("Missing ?date=YYYY-MM-DD", 400);
      }
      const start = startISO ? parseYMD(startISO) : parseFromUrl(explicitUrl);
      if (!start) return jserr("Bad or missing date", 400);
      const end = addDays(start, days - 1);

      // ---- Build day URLs (official site has per-day pages) ----
      const dayUrls = [];
      if (explicitUrl && /\d{2}-\d{2}-\d{4},dzien/i.test(explicitUrl)) {
        dayUrls.push(explicitUrl);
      } else {
        for (let i = 0; i < days; i++) {
          dayUrls.push(`https://lublin.eu/kultura/wydarzenia/${toDMY(addDays(start, i))},dzien.html`);
        }
      }

      const scanned = [];
      let pages_scanned = 0;
      const events = [];

      // Fetch cap before grouping: overfetch a bit if grouping is on
      const fetchCap = groupTimes ? Math.min(limit * 2, 2000) : limit;

      // ---- Scan day pages with pagination, honoring budget & cap ----
      for (const dayUrl of dayUrls) {
        if (budget.used >= budget.max || events.length >= fetchCap) break;

        const r1 = await fetchPage(dayUrl, ctx, budget);
        pages_scanned++; scanned.push(dayUrl);
        if (r1.ok) collect(parseList(r1.html, dayUrl));

        // Only paginate if we still need more events and have budget
        if (events.length >= fetchCap || budget.used >= budget.max) continue;

        // Next pages: /{p},{DD-MM-YYYY},strona_dzien.html
        const m = /\/(\d{2}-\d{2}-\d{4}),dzien/i.exec(dayUrl);
        if (!m) continue;

        for (let p = 2; p <= pagesMax; p++) {
          if (budget.used >= budget.max || events.length >= fetchCap) break;
          const next = `https://lublin.eu/kultura/wydarzenia/${p},${m[1]},strona_dzien.html`;
          const r = await fetchPage(next, ctx, budget);
          pages_scanned++; scanned.push(next);
          if (!r.ok) break;
          collect(parseList(r.html, next));
        }
      }

      // ---- Optional enrichment (detail pages) with strict budget guard ----
      let enrichedCount = 0;
      let enrich_scanned = [];
      if (enrich && events.length && budget.used < budget.max) {
        const remaining = Math.max(0, budget.max - budget.used);
        const cap = Math.min(enrichMax, remaining); // 1 fetch per detail (retry included in budget)
        if (cap > 0) {
          const res = await enrichDetails(events, cap, ctx, budget);
          enrichedCount = res.enriched;
          enrich_scanned = res.scanned;
        }
      }

      // ---- Group & finalize
      const finalized = groupTimes ? groupSameDayShowtimes(events) : events;
      const sliced = finalized.slice(0, limit);

      const payload = {
        source: "lublin.eu",
        url: explicitUrl || "https://lublin.eu/kultura/wydarzenia",
        start: fmt(start),
        end: fmt(end),
        pages_scanned,
        scanned,
        budget_used: budget.used,
        budget_max: budget.max,
        budget_exhausted: budget.used >= budget.max,
        count: sliced.length,
        enriched: enrichedCount,
        enrich_scanned,
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
            e.Source || "lublin.eu"
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
      // Graceful error body for the hub to log without crashing the pipeline
      return jserr(String(err && err.message ? err.message : err), 500);
    }
  }
};

/* ---------------- HTTP (budget-aware) ---------------- */
async function fetchPage(url, ctx, budget) {
  // If budget exhausted, never perform a network fetch
  if (budget.used >= budget.max) return { ok: false, status: 0, html: "" };

  const cache = caches.default;
  const req = new Request(url, {
    headers: {
      "User-Agent": "LublinEventsBot/1.0",
      "Accept-Language": "pl-PL,pl;q=0.9",
      "Accept": "text/html,*/*"
    }
  });

  // Cache lookup (does not consume subrequest budget)
  const cached = await cache.match(req);
  if (cached) return { ok: true, status: 200, html: await cached.text() };

  // "Reserve" a subrequest before going to network to avoid racing over budget
  if (++budget.used > budget.max) {
    // Revert reservation and bail
    budget.used = budget.max;
    return { ok: false, status: 0, html: "" };
  }

  const ctrl = new AbortController();
  const to = setTimeout(() => ctrl.abort(), 20000);

  try {
    let res = await fetch(req, { signal: ctrl.signal, redirect: "follow" });

    // Single retry for transient CF gateway errors (retry also consumes budget)
    if (!res.ok && [520, 522, 523, 524].includes(res.status) && budget.used < budget.max) {
      if (++budget.used <= budget.max) {
        res = await fetch(req, { signal: ctrl.signal, redirect: "follow" });
      }
    }

    const html = await res.text();
    if (res.ok) {
      const out = new Response(html, {
        headers: { "content-type": "text/html; charset=utf-8", "cache-control": "public, max-age=900" }
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

/* ---------------- List parsing ---------------- */
function parseList(raw, baseUrl) {
  const html = normalizeHtml(raw);
  const out = [];

  // Title + link
  const reTitle = /<div\s+class="event-title">\s*<a\s+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi;
  let m;
  while ((m = reTitle.exec(html)) !== null) {
    const href  = absUrl(baseUrl, (m[1] || "").trim());
    const title = text(m[2]);
    if (!title) continue;

    // Local block
    const start = Math.max(0, m.index - 2000);
    const block = html.slice(start, Math.min(html.length, m.index + 2000));

    // Date (DD-MM-YYYY -> ISO)
    const dmy = lastMatch(block, /class="[^"]*event-date[^"]*"[^>]*>\s*([0-9]{2}-[0-9]{2}-[0-9]{4})\s*<\/span>/gi) || "";
    const iso = dmy ? dmy.split("-").reverse().join("-") : "";

    // Times (collect all on card)
    const times = [];
    const reTime = /class="[^"]*event-time[^"]*"[^>]*>\s*([0-9]{1,2}:[0-9]{2})\s*<\/span>/gi;
    let tm;
    while ((tm = reTime.exec(block)) !== null) times.push(tm[1]);
    const time = Array.from(new Set(times)).sort().join(", ");

    // Venue (tolerant)
    const venue = text(
      lastMatch(block, /class="[^"]*(?:event__place|place|lokalizacja)[^"]*"[^>]*>\s*([\s\S]*?)<\/(?:div|span|li)>/gi) ||
      lastMatch(block, />\s*(?:Miejsce|Lokalizacja)\s*:\s*<[^>]*>\s*([^<]+)/gi) ||
      lastMatch(block, />\s*(?:Miejsce|Lokalizacja)\s*:\s*([^<]+)/gi) || ""
    );

    // Category
    const category = text(
      lastMatch(block, /class="[^"]*(?:event__category|category|tag)[^"]*"[^>]*>\s*([\s\S]*?)<\/(?:div|span|a)>/gi) ||
      lastMatch(block, />\s*(?:Kategoria|Category)\s*:\s*<[^>]*>\s*([^<]+)/gi) ||
      lastMatch(block, />\s*(?:Kategoria|Category)\s*:\s*([^<]+)/gi) || ""
    );

    out.push({
      Title: title,
      Date: iso,
      Time: time,
      Venue: venue,
      Category: category,
      Link: href,
      "Payment for Entry": detectPaymentList(block), // "No" or ""
      Source: "lublin.eu",
      _EndDate: iso, // ADR-0009: always present; default to Date for single-day
      _fp_url: urlPath(href),
      _fp_tdv: f_title_date_venue({ Title: title, Date: iso, Venue: venue })
    });
  }
  return out;
}

/* ---------------- Enrichment (detail pages) ---------------- */
async function enrichDetails(list, cap, ctx, budget) {
  // Target items missing Payment OR key fields
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

    const info = parseDetail(r.html);

    if (info.Payment !== "") e["Payment for Entry"] = info.Payment; // Yes/No/""
    if (info.Time)  e.Time  = e.Time ? mergeTimes(e.Time, info.Time) : info.Time;
    if (info.Venue && !e.Venue) e.Venue = info.Venue;
    if (info.Category && !e.Category) e.Category = info.Category;

    enriched++;
  }
  return { enriched, scanned };
}

function parseDetail(raw) {
  const html = normalizeHtml(raw);

  // TIME
  const t1 =
    labelValue(html, 'Godzina(?:\\s+rozpocz(?:e|ę)cia)?') ||
    labelBlock(html, 'Godzina(?:\\s+rozpocz(?:e|ę)cia)?') ||
    lastMatch(html, /(?:Godzina|Godzina rozpoczecia|Godzina rozpoczęcia|Godz\.)[^<]{0,80}?>\s*([0-9]{1,2}:[0-9]{2})/gi) ||
    lastMatch(html, /(?:Godzina|Godz\.)\s*:?:?\s*([0-9]{1,2}:[0-9]{2})/gi) ||
    "";

  // VENUE
  const v1 =
    labelValue(html, '(?:Miejsce|Lokalizacja)') ||
    labelBlock(html, '(?:Miejsce|Lokalizacja)') ||
    lastMatch(html, /(?:Miejsce|Lokalizacja)\s*:\s*<[^>]*>\s*([^<]+)/gi) ||
    lastMatch(html, /class="[^"]*(?:place|lokalizacja|event__place)[^"]*"[^>]*>\s*([\s\S]*?)<\/(?:div|span|li)>/gi) ||
    "";

  // CATEGORY
  const c1 =
    labelValue(html, '(?:Kategoria|Category)') ||
    labelBlock(html, '(?:Kategoria|Category)') ||
    lastMatch(html, /(?:Kategoria|Category)\s*:\s*<[^>]*>\s*([^<]+)/gi) ||
    lastMatch(html, /class="[^"]*(?:category|event__category)[^"]*"[^>]*>\s*([\s\S]*?)<\/(?:div|span|a)>/gi) ||
    "";

  // PAYMENT
  const lbl =
    labelBlock(html, '(?:Udział|Udzial|Wstęp|Wstep)') ||
    labelValue(html, '(?:Udział|Udzial|Wstęp|Wstep)') ||
    lastMatch(html, /(?:Udział|Udzial|Wstęp|Wstep)\s*:\s*<[^>]*>\s*([^<]+)/gi) ||
    "";

  let payment = "";
  if (lbl) payment = normalizePaymentExact(lbl); else payment = detectPaymentPage(html);

  return {
    Time: t1,
    Venue: text(v1),
    Category: text(c1),
    Payment: payment
  };
}

/* ---------------- Payment normalization (ADR-0007) ---------------- */
function detectPaymentList(block){
  const t = norm(block);
  if (/(wstep wolny|bezplatn|darmow|gratis|free|nieodplat)/.test(t)) return "No";
  return "";
}
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
function normalizePaymentExact(v){
  const t = norm(v);
  if (/\b\d+[.,]?\d*\s*(zl|pln)\b/.test(t) || /(platn|platny|bilet|bilety|wejsciow|oplata|cena|pln|zl)/.test(t)) return "Yes";
  if (/(wstep wolny|bezplatn|darmow|gratis|free|nieodplat)/.test(t)) return "No";
  return "";
}

/* ---------------- Grouping & small utils ---------------- */
function groupSameDayShowtimes(list){
  const map = new Map();
  for (const e of list) {
    const k = `${(e.Title||"").toLowerCase()}|${e.Date||""}|${(e.Venue||"").toLowerCase()}`;
    if (!map.has(k)) map.set(k, { ...e });
    else {
      const prev = map.get(k);
      if (e.Time) prev.Time = prev.Time ? mergeTimes(prev.Time, e.Time) : e.Time;
      if (!prev.Venue && e.Venue) prev.Venue = e.Venue;
      if (!prev.Category && e.Category) prev.Category = e.Category;

      // On payment conflict prefer free ("No"), per ADR-0007
      const a = (prev["Payment for Entry"]||"").toLowerCase();
      const b = (e["Payment for Entry"]||"").toLowerCase();
      if (!a && b) prev["Payment for Entry"] = e["Payment for Entry"];
      else if (a && b && a !== b) prev["Payment for Entry"] = "No";
    }
  }
  return [...map.values()];
}

function mergeTimes(a,b){
  const arr = s => (s||"").split(",").map(x => x.trim()).filter(Boolean);
  const set = new Set([...arr(a), ...arr(b)]);
  return Array.from(set).sort().join(", ");
}

function parseYMD(s){ const m=/^(\d{4})-(\d{2})-(\d{2})$/.exec(s||""); return m?new Date(Date.UTC(+m[1],+m[2]-1,+m[3])):null; }
function addDays(d,n){ const x=new Date(d); x.setUTCDate(x.getUTCDate()+n); return x; }
function pad(n){ return n<10?("0"+n):(""+n); }
function toDMY(d){ return `${pad(d.getUTCDate())}-${pad(d.getUTCMonth()+1)}-${d.getUTCFullYear()}`; }
function parseFromUrl(u){ const m=/\/(\d{2})-(\d{2})-(\d{4}),dzien\.html$/i.exec(u||""); return m?new Date(Date.UTC(+m[3],+m[2]-1,+m[1])):null; }
function fmt(d){ return d.toISOString().slice(0,10); }

function flag(v){ return ["1","true","yes","y"].includes(String(v||"").toLowerCase()); }
function int(v,d){ const n=parseInt(v??"",10); return Number.isFinite(n)?n:d; }
function clamp(n,lo,hi){ return Math.max(lo, Math.min(hi,n)); }

function normalizeHtml(s){ return (s||"").replace(/\r/g,"").replace(/\t/g," ").replace(/&nbsp;/g," ").replace(/[‐-‒–—]/g,"—"); }
function stripTags(s){ return (s||"").replace(/<[^>]*>/g," "); }
function decodeEntities(s){
  return (s||"")
    .replace(/&quot;|&#34;/g,'"').replace(/&apos;|&#39;/g,"'")
    .replace(/&amp;/g,"&").replace(/&lt;/g,"<").replace(/&gt;/g,">")
    .replace(/&laquo;|&#171;/g,"«").replace(/&raquo;|&#187;/g,"»");
}
function text(s){ return decodeEntities(stripTags(s)).replace(/\s+/g," ").trim(); }
function normalizeForKey(s){ return text(s).normalize("NFKD").replace(/[\u0300-\u036f]/g,"").toLowerCase().replace(/[^a-z0-9 ]/g," ").replace(/\s+/g," ").trim(); }
function f_title_date_venue(e){ return `${normalizeForKey(e.Title)}|${e.Date}|${normalizeForKey(e.Venue)}`; }
function urlPath(u){ try { return new URL(u).pathname.replace(/\/+$/,""); } catch { return ""; } }
function json(obj,status=200){ return new Response(JSON.stringify(obj), {status, headers:{"content-type":"application/json; charset=utf-8","access-control-allow-origin":"*"}}); }
function jserr(msg,status=400){ return json({ error: String(msg) }, status); }

function lastMatch(str, re){ let m, last=null; while((m=re.exec(str))!==null){ last = m[1] || m[0]; } return last; }
function absUrl(base, href){ try { return new URL(href, base).toString(); } catch { return href; } }
function labelValue(html, labelRe){
  const re = new RegExp(`<div\\s+class="form-row"[^>]*>\\s*<span[^>]*class="label"[^>]*>\\s*(?:${labelRe})\\s*<\\/span>\\s*<span[^>]*>\\s*([^<]+?)\\s*<\\/span>`,"i");
  const m = re.exec(html); return m ? m[1] : "";
}
function labelBlock(html, labelRe){
  const re = new RegExp(`<div\\s+class="form-row"[^>]*>\\s*<span[^>]*class="label"[^>]*>\\s*(?:${labelRe})\\s*<\\/span>\\s*<span[^>]*>\\s*([\\s\\S]*?)\\s*<\\/span>`,"i");
  const m = re.exec(html); return m ? text(m[1]) : "";
}
function norm(s){ return text(s).normalize("NFKD").replace(/[\u0300-\u036f]/g,"").toLowerCase(); }
