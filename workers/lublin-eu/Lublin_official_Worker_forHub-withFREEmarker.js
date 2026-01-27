// Lublin_official_Worker_forHub2.js — RESILIENT LIST CRAWL + A–F applied + S2-07A FREE dual-fetch
// ADRs: 0006, 0008, 0009, 0010, 0011
// - Parse per .event card; .event-date-time BEFORE title
// - Time extraction handles inner <span> (clock icon)
// - Detail dates via label/value spans (YYYY-MM-DD and DD-MM-YYYY)
// - Skip bad *day-1/page-1* (and any day) instead of aborting the whole week
// - Broaden retries: 0/408/429/500/502/503/504 + 520/522/523/524
// - Telemetry: has_more, stopped_reason, error (fatal only), failed_urls[]
// - Deterministic sort: Date ↑, earliest Time ↑, Title A→Z
// - Tweak: clear "00:00" for multi-day/exhibition-like
//
// Notes:
// * We *don’t* mark stopped_reason="error" for per-day failures we skipped. That’s not fatal.
// * We only set stopped_reason="budget" when budget is actually hit.
//
// ---------- response helpers ----------

// Lublin_official_Worker_forHub2.js — RESILIENT LIST CRAWL + A–F applied + S2-07A FREE dual-fetch
// ADRs: 0006, 0008, 0009, 0010, 0011
// - Parse per .event card; .event-date-time BEFORE title
// - Time extraction handles inner <span> (clock icon)
// - Detail dates via label/value spans (YYYY-MM-DD and DD-MM-YYYY)
// - Skip bad *day-1/page-1* (and any day) instead of aborting the whole week
// - Broaden retries: 0/408/429/500/502/503/504 + 520/522/523/524
// - Telemetry: has_more, stopped_reason, error (fatal only), failed_urls[]
// - Deterministic sort: Date ↑, earliest Time ↑, Title A→Z
// - Tweak: clear "00:00" for multi-day/exhibition-like
//
// Notes:
// * We *don’t* mark stopped_reason="error" for per-day failures we skipped. That’s not fatal.
// * We only set stopped_reason="budget" when budget is actually hit.
//
// ---------- response helpers ----------
function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "access-control-allow-origin": "*"
    }
  });
}
function jserr(msg, status = 400) { return json({ error: String(msg) }, status); }

// ---------- tiny utils ----------
function flag(v){ return ["1","true","yes","y"].includes(String(v||"").toLowerCase()); }
function int(v,d){ const n=parseInt(v??"",10); return Number.isFinite(n)?n:d; }
function clamp(n,lo,hi){ return Math.max(lo, Math.min(hi,n)); }
function pad(n){ return n<10?("0"+n):(""+n); }
function fmt(d){ return d.toISOString().slice(0,10); }
function addDays(d,n){ const x=new Date(d); x.setUTCDate(x.getUTCDate()+n); return x; }
function parseYMD(s){ const m=/^(\d{4})-(\d{2})-(\d{2})$/.exec(s||""); return m?new Date(Date.UTC(+m[1],+m[2]-1,+m[3])):null; }
function toDMY(d){ return `${pad(d.getUTCDate())}-${pad(d.getUTCMonth()+1)}-${d.getUTCFullYear()}`; }
function parseFromUrl(u){ const m=/\/(\d{2})-(\d{2})-(\d{4}),dzien\.html$/i.exec(u||""); return m?new Date(Date.UTC(+m[3],+m[2]-1,+m[1])):null; }
function lastMatch(str, re){ let m, last=null; while((m=re.exec(str))!==null){ last = m[1] || m[0]; } return last; }
function firstMatch(str, re){ re.lastIndex = 0; const m = re.exec(str); return m ? (m[1] || m[0]) : ""; }
function absUrl(base, href){ try { return new URL(href, base).toString(); } catch { return href || ""; } }
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
    .replace(/[łŁ]/g,"l").replace(/[śŚ]/g,"s").replace(/[ćĆ]/g,"c")
    .replace(/[źŻŹ]/g,"z").replace(/[óÓ]/g,"o").replace(/[ńŃ]/g,"n")
    .replace(/[ąĄ]/g,"a").replace(/[ęĘ]/g,"e").toLowerCase();
}
function urlPath(u){ try { return new URL(u).pathname.replace(/\/+$/,""); } catch { return ""; } }
function mergeTimes(a,b){ const arr = s => (s||"").split(",").map(x => x.trim()).filter(Boolean);
  const set = new Set([...arr(a), ...arr(b)]); return Array.from(set).sort().join(", "); }
function earliestTimeKey(e){
  const s = (e.Time || "").trim(); if (!s) return "99:99";
  const parts = s.split(",").map(x => x.trim()).filter(Boolean);
  const sorted = parts.map(t => { const m = /^(\d{1,2}):(\d{2})$/.exec(t);
    if (!m) return "99:99"; const hh = String(parseInt(m[1],10)).padStart(2,"0"); return `${hh}:${m[2]}`; }).sort();
  return sorted[0] || "99:99";
}
function orderEvents(a, b){
  const at = !!((a.Time||"").trim()), bt = !!((b.Time||"").trim());
  if (at !== bt) return at ? -1 : 1;                    // timed first
  const ad = a.Date || "", bd = b.Date || "";
  if (ad !== bd) return ad < bd ? -1 : 1;               // then by date
  if (at && bt) { const ak = earliestTimeKey(a), bk = earliestTimeKey(b); if (ak !== bk) return ak < bk ? -1 : 1; }
  return (a.Title||"").localeCompare(b.Title||"", "pl", { sensitivity: "base" });
}

// ---------- Worker ----------
export default {
  async fetch(request, env, ctx) {
    try {
      const url = new URL(request.url);
      const q = url.searchParams;

      // Inputs
      const startISO   = (q.get("date") || "").trim();              // YYYY-MM-DD
      const period     = (q.get("period") || "day").toLowerCase();  // day|week
      const days       = int(q.get("days"), period === "week" ? 7 : 1);
      const pagesMax   = clamp(int(q.get("pages"), 3), 1, 5);
      const limit      = clamp(int(q.get("limit"), 200), 1, 10000);
      const groupTimes = flag(q.get("group_times"));
      const wantRows   = flag(q.get("sheet"));

      const enrich     = flag(q.get("enrich"));
      const enrichMax  = clamp(int(q.get("enrich_max"), 15), 0, 50);

      // Accept (no-op) include_in_progress / inprog_pages for contract alignment
      const includeInProgress = q.has("include_in_progress") ? flag(q.get("include_in_progress")) : true;
      const inprogPages       = clamp(int(q.get("inprog_pages"), 1), 1, 3);

      // Budget (ADR-0010): ≤48, count cache.match/fetch/cache.put
      const userBudget = clamp(int(q.get("budget"), 0), 0, 48);
      const budget     = { used: 0, max: userBudget || 48 };

      // Date window
      const explicitUrl = q.get("url") || "";
      if (!startISO && !explicitUrl) return jserr("Missing ?date=YYYY-MM-DD", 400);
      const start = startISO ? parseYMD(startISO) : parseFromUrl(explicitUrl);
      if (!start) return jserr("Bad or missing date", 400);
      const end = addDays(start, days - 1);

      // Day URLs
      const dayUrls = [];
      if (explicitUrl && /\d{2}-\d{2}-\d{4},dzien/i.test(explicitUrl)) dayUrls.push(explicitUrl);
      else for (let i=0;i<days;i++) dayUrls.push(`https://lublin.eu/kultura/wydarzenia/${toDMY(addDays(start,i))},dzien.html`);

      const scanned = [];
      const failed_urls = [];
      let pages_scanned = 0;
      const events = [];

      // Early-stop list collection when enrich=1
      const listCollectCap = enrich ? Math.max(enrichMax * 10, 100) : (groupTimes ? Math.min(limit * 2, 2000) : limit);

      // Telemetry
      let stopped_reason = "no_more";
      let has_more = false;
      let errorMsg = ""; // fatal only


      // S2-07A: FREE detection (cheap, list-page only)
      // Strategy: for each list page:
      //  1) GET the default list (paid+free)
      //  2) POST the FREE filter to get FREE-only list
      //  3) Mark default events as FREE if their normalized URL path is in the FREE-only set
      //
      // Everything not marked FREE is treated as UNKNOWN (no paid detection in S2-07A).
      // NOTE: lublin.eu UI applies filters only after clicking the "Filtruj" button;
      // many implementations require a second form field, so we include `filtruj=1`.
      const FREE_FILTER_BODY = "bezplatne=1&filtruj=1";
      const free_filter_scanned = [];
      let free_filter_post_ok_pages = 0;
      let free_filter_post_fail_pages = 0;
      let free_filter_post_unapplied_pages = 0;
      let free_filter_post_skipped_budget = 0;

      function postLooksApplied(html){
        // Heuristic only (best effort): checkbox for `bezplatne` appears checked in response HTML.
        // If this turns out too strict, use telemetry counters to adjust.
        return /<input[^>]*name="bezplatne"[^>]*checked/i.test(html||"")
            || /<input[^>]*checked[^>]*name="bezplatne"/i.test(html||"");
      }

      async function fetchFreeSet(listUrl){
        if (budget.used >= budget.max) { free_filter_post_skipped_budget++; return new Set(); }
        const r = await fetchPagePost(listUrl, ctx, budget, FREE_FILTER_BODY);
        free_filter_scanned.push(listUrl);
        if (!r.ok) {
          free_filter_post_fail_pages++;
          failed_urls.push({ url: listUrl, status: r.status || 0, where: "free_post" });
          return new Set();
        }
        free_filter_post_ok_pages++;
        if (!postLooksApplied(r.html)) free_filter_post_unapplied_pages++;
        const arr = parseOfficialList(r.html, listUrl);
        const set = new Set();
        for (const e of arr){
          const p = e._fp_url || (e.Link ? urlPath(e.Link) : "");
          if (p) set.add(p);
        }
        return set;
      }

      function applyFreeSet(defaultArr, freeSet){
        if (!freeSet || freeSet.size === 0) return;
        for (const e of defaultArr){
          const p = e._fp_url || (e.Link ? urlPath(e.Link) : "");
          if (p && freeSet.has(p)) {
            // Convention (align with Zoom): "No" means FREE.
            // Unknown = empty string.
            e["Payment for Entry"] = "No";
          }
        }
      }

      // Crawl list pages (budget-aware, day-resilient)
      for (const dayUrl of dayUrls) {
        if (budget.used >= budget.max || events.length >= listCollectCap) break;

        // Page 1 (resilient): if it fails, record & CONTINUE with next day
        const r1 = await fetchPage(dayUrl, ctx, budget, { useCache: false, writeCache: false });
        pages_scanned++; scanned.push(dayUrl);
        if (!r1.ok) {
          failed_urls.push({ url: dayUrl, status: r1.status || 0, where: "page1" });
          // not fatal — move on to next date
          continue;
        }
        const page1 = parseOfficialList(r1.html, dayUrl);
        const freeSet1 = await fetchFreeSet(dayUrl);
        applyFreeSet(page1, freeSet1);
        collect(page1);

        // Next pages (2..pagesMax)
        const m = /\/(\d{2}-\d{2}-\d{4}),dzien/i.exec(dayUrl);
        if (m) {
          for (let p=2; p<=pagesMax; p++){
            if (budget.used >= budget.max || events.length >= listCollectCap) break;
            const next = `https://lublin.eu/kultura/wydarzenia/${p},${m[1]},strona_dzien.html`;
            const r = await fetchPage(next, ctx, budget, { useCache: false, writeCache: false });
            pages_scanned++; scanned.push(next);
            if (!r.ok) { failed_urls.push({ url: next, status: r.status || 0, where: "pageN" }); break; }
            const pageN = parseOfficialList(r.html, next);
            const freeSetN = await fetchFreeSet(next);
            applyFreeSet(pageN, freeSetN);
            collect(pageN);
          }
        }

        if (budget.used >= budget.max) { stopped_reason = "budget"; has_more = true; break; }
      }

      if (budget.used >= budget.max) { stopped_reason = "budget"; has_more = true; }
      else { stopped_reason = "no_more"; }

      // Enrichment (detail pages) — intentionally DISABLED in S2-07A
      //
      // Rationale: per-event detail requests are expensive and defeat the goal of cheap FREE detection.
      // We keep the output fields for backward compatibility, but we do not perform any detail fetches.
      let enrichedCount = 0;
      let enrich_scanned = [];

      // Finalize list
      let finalized = groupTimes ? groupSameDayShowtimes(events) : events;
      finalized = finalized.map(e => normalizeZeroTime(e));           // clear 00:00 for ongoing/exhibitions
      finalized = finalized.slice().sort(orderEvents);                // stable order
      const sliced = finalized.slice(0, limit);

      // FREE detection canary (computed on finalized output)
      const free_detected_count_total = finalized.reduce((n,e)=> n + ((e["Payment for Entry"]||"") === "No" ? 1 : 0), 0);
      const free_detected_count_returned = sliced.reduce((n,e)=> n + ((e["Payment for Entry"]||"") === "No" ? 1 : 0), 0);

      // If we collected nothing at all AND every first page failed, call it fatal
      const allFirstPagesFailed = sliced.length === 0 && scanned.length > 0 &&
        failed_urls.filter(x => x.where === "page1").length >= dayUrls.length;
      if (allFirstPagesFailed) { stopped_reason = "error"; has_more = true; errorMsg = "All day-1 pages failed"; }

      const payload = {
        version: "official-2hub-2026-01-26-s2-07a-r2",
        source: "lublin.eu",
        url: explicitUrl || "https://lublin.eu/kultura/wydarzenia",
        start: fmt(start),
        end: fmt(end),
        pages_scanned,
        scanned,
        failed_urls,
        budget_used: budget.used,
        budget_max: budget.max,
        has_more,
        stopped_reason,
        error: errorMsg || "",
        enriched: enrichedCount,
        enrich_scanned,
        include_in_progress: includeInProgress ? 1 : 0,
        inprog_pages: inprogPages,
        count: sliced.length,

        // S2-07A: FREE-only detection telemetry (canary + debugging)
        free_detected_count_total,
        free_detected_count_returned,
        free_filter_mode: "POST " + FREE_FILTER_BODY,
        free_filter_body_config: FREE_FILTER_BODY,
        free_filter_post_ok_pages,
        free_filter_post_fail_pages,
        free_filter_post_unapplied_pages,
        free_filter_post_skipped_budget,
        free_filter_scanned,

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
            e["Payment for Entry"] || "",
            e.Source || "lublin.eu"
          ]
        }));
      }

      return json(payload);

      function collect(arr){
        for (const e of arr){
          events.push(e);
          if (events.length >= listCollectCap) break;
        }
      }
    } catch (e) {
      return jserr(String(e && e.message ? e.message : e), 500);
    }
  }
};

// ---------- HTTP with budget counting (ADR-0010) ----------
async function fetchPage(url, ctx, budget, opts = {}) {
  const useCache   = opts.useCache   !== false; // default true
  const writeCache = opts.writeCache !== false; // default true

  if (budget.used >= budget.max) return { ok:false, status:0, html:"" };

  const cache = caches.default;
  const req = new Request(url, {
    headers: {
      "User-Agent": "LublinEventsBot/1.0",
      "Accept-Language": "pl-PL,pl;q=0.9",
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

  // fetch (+1) with broadened retry window
  const RETRY_STATUSES = new Set([0, 408, 429, 500, 502, 503, 504, 520, 522, 523, 524]);

  if (budget.used + 1 > budget.max) return { ok:false, status:0, html:"" };
  budget.used++;
  let res = await fetch(req, { redirect: "follow" });

  if (!res.ok && RETRY_STATUSES.has(res.status) && (budget.used + 1) <= budget.max) {
    budget.used++;
    res = await fetch(req, { redirect: "follow" });
  }

  const html = await res.text().catch(() => "");
  if (!res.ok) return { ok:false, status:res.status || 0, html };

  // cache.put counts (+1) — skip on details
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
}

// ---------- HTTP POST with budget counting (S2-07A, no cache) ----------
async function fetchPagePost(url, ctx, budget, body) {
  if (budget.used >= budget.max) return { ok:false, status:0, html:"" };

  const RETRY_STATUSES = new Set([0, 408, 429, 500, 502, 503, 504, 520, 522, 523, 524]);

  if (budget.used + 1 > budget.max) return { ok:false, status:0, html:"" };
  budget.used++;

  const req = new Request(url, {
    method: "POST",
    headers: {
      "User-Agent": "LublinEventsBot/1.0",
      "Accept-Language": "pl-PL,pl;q=0.9",
      "Accept": "text/html,*/*",
      "Content-Type": "application/x-www-form-urlencoded; charset=UTF-8",
      // A couple of sites refuse POST without these; they are cheap to include.
      "Origin": "https://lublin.eu",
      "Referer": url
    },
    body: body || ""
  });

  let res = await fetch(req, { redirect: "follow" });
  if (!res.ok && RETRY_STATUSES.has(res.status) && (budget.used + 1) <= budget.max) {
    budget.used++;
    res = await fetch(req, { redirect: "follow" });
  }

  const html = await res.text().catch(() => "");
  if (!res.ok) return { ok:false, status:res.status || 0, html };
  return { ok:true, status:200, html };
}


// ---------- Official list parser (per-card; date/time BEFORE title) ----------
function parseOfficialList(raw, baseUrl) {
  const html = normalizeHtml(raw);
  const out = [];

  // Split by top-level .event cards
  const reCard = /<div\s+class="event"[^>]*>([\s\S]*?)<\/div>\s*<\/div>?/gi;
  let m;
  while ((m = reCard.exec(html)) !== null) {
    const card = m[1];

    // Dates (one or two)
    const dates = [];
    const reDate = /class="[^"]*event-date[^"]*"[^>]*>\s*([0-9]{2}-[0-9]{2}-[0-9]{4})/gi;
    let d; while ((d = reDate.exec(card)) !== null) { dates.push(d[1]); if (dates.length === 2) break; }
    const isoStart = dates[0] ? dmyToIso(dates[0]) : "";
    const isoEnd   = dates[1] ? dmyToIso(dates[1]) : (isoStart || "");

    // Time: allow nested spans before digits
    const time = firstMatch(card, /class="[^"]*event-time[^"]*"[^>]*>[\s\S]*?([0-9]{1,2}:[0-9]{2})/i) || "";

    // Title + href
    const href  = absUrl(baseUrl, firstMatch(card, /<div\s+class="event-title">[\s\S]*?<a\s+href="([^"]+)"/i) || "");
    const title = text(firstMatch(card, /<div\s+class="event-title">[\s\S]*?<a[^>]*>([\s\S]*?)<\/a>/i) || "");
    if (!title || !href) continue;

    out.push({
      Title: title,
      Date: isoStart,
      Time: time,
      Venue: "",
      Category: "",
      Link: href,
      event_ref: officialEventRef(href),   // <-- adde to address issue with several pages for the same logical event
      "Payment for Entry": "",
      Source: "lublin.eu",
      _EndDate: isoEnd,
      _fp_url: urlPath(href)
    });
  }
  return out;
}
function dmyToIso(s){ const m = /^(\d{2})-(\d{2})-(\d{4})$/.exec((s||"").trim()); return m ? `${m[3]}-${m[2]}-${m[1]}` : ""; }

// ---------- Official detail parser ----------
function parseOfficialDetail(raw) {
  const html = normalizeHtml(raw);

  // Dates
  const sd = labelValue(html, 'Data\\s*rozpocz(?:z|ż)ęcia') || labelBlock(html, 'Data\\s*rozpocz(?:z|ż)ęcia');
  const ed = labelValue(html, 'Data\\s*zako(?:ń|n)czenia')   || labelBlock(html, 'Data\\s*zako(?:ń|n)czenia');
  const StartDate = normalizeDate(sd);
  const EndDate   = normalizeDate(ed);

  // Time (start)
  const t1 =
    labelValue(html, 'Godzina(?:\\s+rozpocz(?:e|ę)cia)?') ||
    labelBlock(html, 'Godzina(?:\\s+rozpocz(?:e|ę)cia)?') ||
    lastMatch(html, /(?:Godzina|Godzina rozpoczecia|Godzina rozpoczęcia|Godz\.)[^<]{0,80}?>\s*([0-9]{1,2}:[0-9]{2})/gi) ||
    lastMatch(html, /(?:Godzina|Godz\.)\s*:?:?\s*([0-9]{1,2}:[0-9]{2})/gi) || "";

  // Venue
  const v1 =
    labelValue(html, '(?:Miejsce|Lokalizacja)') ||
    labelBlock(html, '(?:Miejsce|Lokalizacja)') ||
    lastMatch(html, /(?:Miejsce|Lokalizacja)\s*:\s*<[^>]*>\s*([^<]+)/gi) ||
    lastMatch(html, /class="[^"]*(?:place|lokalizacja|event__place)[^"]*"[^>]*>\s*([\s\S]*?)<\/(?:div|span|li)>/gi) || "";

  // Category
  const c1 =
    labelValue(html, '(?:Kategoria|Category)') ||
    labelBlock(html, '(?:Kategoria|Category)') ||
    lastMatch(html, /(?:Kategoria|Category)\s*:\s*<[^>]*>\s*([^<]+)/gi) ||
    lastMatch(html, /class="[^"]*(?:category|event__category)[^"]*"[^>]*>\s*([\s\S]*?)<\/(?:div|span|a)>/gi) || "";

  // Payment
  const lbl =
    labelBlock(html, '(?:Udział|Udzial|Wstęp|Wstep)') ||
    labelValue(html, '(?:Udział|Udzial|Wstęp|Wstep)') ||
    lastMatch(html, /(?:Udział|Udzial|Wstęp|Wstep)\s*:\s*<[^>]*>\s*([^<]+)/gi) || "";
  let payment = "";
  if (lbl) payment = normalizePaymentExact(lbl); else payment = detectPaymentPage(html);

  return { Time: t1, Venue: text(v1), Category: text(c1), Payment: payment, StartDate, EndDate };
}

function normalizeDate(v){
  const s = (v||"").trim(); if (!s) return "";
  let m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s); if (m) return `${m[1]}-${m[2]}-${m[3]}`;
  m = /^(\d{2})-(\d{2})-(\d{4})$/.exec(s); if (m) return `${m[3]}-${m[2]}-${m[1]}`;
  return "";
}

// ---------- Payment normalization ----------
function detectPaymentList(block){ const t = norm(block);
  if (/(wstep wolny|bezplatn|darmow|gratis|nieodplat)/.test(t)) return "No"; return ""; }
function detectPaymentPage(html){
  const t = norm(html);
  const hasFree = /(wstep wolny|bezplatn|darmow|gratis|nieodplat)/.test(t);
  const hasPaid = /(platn|platny|patn|bilet|bilety|wejsciow|oplata|cena|\b\d+[.,]?\d*\s*(zl|pln)\b)/.test(t);
  if (hasFree && !hasPaid) return "No";
  if (hasPaid && !hasFree) return "Yes";
  if (hasFree && hasPaid) return /\b\d+[.,]?\d*\s*(zl|pln)\b/.test(t) ? "Yes" : "No";
  return "";
}
function normalizePaymentExact(v){
  const t = norm(v);
  if (/(wstep wolny|bezplatn|darmow|gratis|nieodplat)/.test(t)) return "No";
  if (/\b\d+[.,]?\d*\s*(zl|pln)\b/.test(t) || /(platn|platny|patn|bilet|bilety|wejsciow|oplata|cena)/.test(t)) return "Yes";
  return "";
}

// ---------- label helpers & grouping ----------
function labelValue(html, labelRe){
  const re = new RegExp(
    `<div\\s+class="form-row"[^>]*>\\s*` +
    `<span[^>]*class="label"[^>]*>\\s*(?:${labelRe})\\s*<\\/span>\\s*` +
    `<span[^>]*>\\s*([^<]+?)\\s*<\\/span>`,
    "i"
  );
  const m = re.exec(html);
  return m ? m[1] : "";
}
function labelBlock(html, labelRe){
  const re = new RegExp(
    `<div\\s+class="form-row"[^>]*>\\s*` +
    `<span[^>]*class="label"[^>]*>\\s*(?:${labelRe})\\s*<\\/span>\\s*` +
    `<span[^>]*>\\s*([\\s\\S]*?)\\s*<\\/span>`,
    "i"
  );
  const m = re.exec(html);
  return m ? text(m[1]) : "";
}

function normalizeZeroTime(e){
  const t = (e.Time||"").trim();
  if (!t) return e;
  const isZero = /^0{0,1}0:00(?:\s*[–-]\s*0{0,1}0:00)?$/.test(t);
  if (!isZero) return e;
  const multiDay = (e._EndDate && e.Date && e._EndDate > e.Date);
  const exhib = /wystaw|exhibit/i.test(e.Category||"");
  if (multiDay || exhib) return { ...e, Time: "" };
  return e;
}

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
      const a = (prev["Payment for Entry"]||"").toLowerCase();
      const b = (e["Payment for Entry"]||"").toLowerCase();
      if (!a && b) prev["Payment for Entry"] = e["Payment for Entry"];
      else if (a && b && a !== b) prev["Payment for Entry"] = "No";
      if (e._EndDate && (!prev._EndDate || e._EndDate > prev._EndDate)) prev._EndDate = e._EndDate;
    }
  }
  return [...map.values()];
}

function officialEventRef(href){
  const p = urlPath(href);                         // "/.../slug,87359,0,w.html"
  const seg = (p.split("/").filter(Boolean).pop() || "").toLowerCase();

  if (!seg) return p.toLowerCase();

  // drop ".html"
  let s = seg.replace(/\.html$/i, "");

  // drop trailing ",<id>,0,w" (official pattern)
  s = s.replace(/,\d+,0,w$/i, "");

  // if anything left with commas, keep only the slug part
  s = s.split(",")[0];

  return s || p.toLowerCase();
}
