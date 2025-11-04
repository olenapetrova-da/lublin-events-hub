// Lublin_official_Worker_forHub2.js
// ADRs: 0005, 0006, 0007, 0008, 0009, 0010
// - Counts ALL subrequests: cache.match(+1), fetch(+1, retry +1), cache.put(+1)
// - Early-stops list crawl when enrich=1 (collect ~10× batch)
// - Skips cache on detail pages (no match/put) to preserve budget
// - No "Image URL"; Payment normalized to Yes/No/""

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
function jserr(msg, status = 400) {
  return json({ error: String(msg) }, status);
}

//
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
    .replace(/&quot;|&#34;/g,'"')
    .replace(/&apos;|&#39;/g,"'")
    .replace(/&amp;/g,"&")
    .replace(/&lt;/g,"<")
    .replace(/&gt;/g,">")
    .replace(/&laquo;|&#171;/g,"«")
    .replace(/&raquo;|&#187;/g,"»");
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
function urlPath(u){ try { return new URL(u).pathname.replace(/\/+$/,""); } catch { return ""; } }
function mergeTimes(a,b){
  const arr = s => (s||"").split(",").map(x => x.trim()).filter(Boolean);
  const set = new Set([...arr(a), ...arr(b)]);
  return Array.from(set).sort().join(", ");
}

//
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

      // Budget (ADR-0010): ≤48, count cache.match/fetch/cache.put
      const userBudget = clamp(int(q.get("budget"), 0), 0, 48);
      const budget     = { used: 0, max: userBudget || 48 };

      // Date window
      const explicitUrl = q.get("url") || "";
      if (!startISO && !explicitUrl) return jserr("Missing ?date=YYYY-MM-DD", 400);
      const start = startISO ? parseYMD(startISO) : parseFromUrl(explicitUrl);
      if (!start) return jserr("Bad or missing date", 400);
      const end = addDays(start, days - 1);

      // Build day URLs
      const dayUrls = [];
      if (explicitUrl && /\d{2}-\d{2}-\d{4},dzien/i.test(explicitUrl)) {
        dayUrls.push(explicitUrl);
      } else {
        for (let i=0;i<days;i++){
          dayUrls.push(`https://lublin.eu/kultura/wydarzenia/${toDMY(addDays(start,i))},dzien.html`);
        }
      }

      const scanned = [];
      let pages_scanned = 0;
      const events = [];

      // Early-stop list collection when enrich=1
      const listCollectCap = enrich
        ? Math.max(enrichMax * 10, 100)
        : (groupTimes ? Math.min(limit * 2, 2000) : limit);

      // Crawl list pages (budget-aware)
      outer:
      for (const dayUrl of dayUrls) {
        if (budget.used >= budget.max || events.length >= listCollectCap) break;

        const r1 = await fetchPage(dayUrl, ctx, budget, { useCache: true, writeCache: true });
        pages_scanned++; scanned.push(dayUrl);
        if (r1.ok) collect(parseOfficialList(r1.html, dayUrl));

        if (events.length >= listCollectCap || budget.used >= budget.max) continue;

        const m = /\/(\d{2}-\d{2}-\d{4}),dzien/i.exec(dayUrl);
        if (!m) continue;
        for (let p=2; p<=pagesMax; p++){
          if (budget.used >= budget.max || events.length >= listCollectCap) break outer;
          const next = `https://lublin.eu/kultura/wydarzenia/${p},${m[1]},strona_dzien.html`;
          const r = await fetchPage(next, ctx, budget, { useCache: true, writeCache: true });
          pages_scanned++; scanned.push(next);
          if (!r.ok) break;
          collect(parseOfficialList(r.html, next));
        }
      }

      // Enrichment (detail pages) — DO NOT use cache to save subrequests
      let enrichedCount = 0;
      let enrich_scanned = [];
      if (enrich && events.length && budget.used < budget.max) {
        const targets = events.filter(e =>
          !(e["Payment for Entry"] || "") || !e.Time || !e.Venue || !e.Category || !e._EndDate
        );
        const cap = Math.min(enrichMax, Math.max(0, budget.max - budget.used));
        for (const e of targets.slice(0, cap)) {
          if (budget.used >= budget.max) break;
          const r = await fetchPage(e.Link, ctx, budget, { useCache: false, writeCache: false });
          if (!r.ok) continue;
          enrich_scanned.push(e.Link);

          const info = parseOfficialDetail(r.html);
          if (info.Payment !== "") e["Payment for Entry"] = info.Payment;
          if (info.Time)  e.Time  = e.Time ? mergeTimes(e.Time, info.Time) : info.Time;
          if (info.Venue && !e.Venue) e.Venue = info.Venue;
          if (info.Category && !e.Category) e.Category = info.Category;
          if (info.EndDate) e._EndDate = info.EndDate;          // prefer detail end date
          if (info.StartDate && !e.Date) e.Date = info.StartDate; // fill if list missed date
          enrichedCount++;
        }
      }

      // Finalize
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
        enriched: enrichedCount,
        enrich_scanned,
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

//
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
  } catch {
    return { ok:false, status:0, html:"" };
  } finally {
    clearTimeout(to);
  }
}

//
// ---------- Official list parser (forward-only; first two dates AFTER title) ----------
function parseOfficialList(raw, baseUrl) {
  const html = normalizeHtml(raw);
  const out = [];

  const reTitle = /<div\s+class="event-title">\s*<a\s+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi;
  let m;
  while ((m = reTitle.exec(html)) !== null) {
    const href  = absUrl(baseUrl, (m[1] || "").trim());
    const title = text(m[2]);
    if (!title) continue;

    // scan only FORWARD from the title to avoid previous-card bleed
    const forward = html.slice(m.index, Math.min(html.length, m.index + 4000));

    // up to two dates AFTER the title (start, end)
    const dates = [];
    const reDate = /class="[^"]*event-date[^"]*"[^>]*>\s*([0-9]{2}-[0-9]{2}-[0-9]{4})\s*<\/span>/gi;
    let dd; reDate.lastIndex = 0;
    while ((dd = reDate.exec(forward)) !== null && dates.length < 2) dates.push(dd[1]);
    const isoStart = dates[0] ? dates[0].split('-').reverse().join('-') : '';
    const isoEnd   = dates[1] ? dates[1].split('-').reverse().join('-') : isoStart;

    // time, venue, category — first occurrence AFTER title
    const time = firstMatch(forward, /class="[^"]*event-time[^"]*"[^>]*>\s*([0-9]{1,2}:[0-9]{2})\s*<\/span>/i) || "";
    const venue = text(
      firstMatch(forward, /class="[^"]*(?:event__place|place|lokalizacja)[^"]*"[^>]*>\s*([\s\S]*?)<\/(?:div|span|li)>/i) ||
      firstMatch(forward, />\s*(?:Miejsce|Lokalizacja)\s*:\s*<[^>]*>\s*([^<]+)/i) ||
      firstMatch(forward, />\s*(?:Miejsce|Lokalizacja)\s*:\s*([^<]+)/i) || ""
    );
    const category = text(
      firstMatch(forward, /class="[^"]*(?:event__category|category|tag)[^"]*"[^>]*>\s*([\s\S]*?)<\/(?:div|span|a)>/i) ||
      firstMatch(forward, />\s*(?:Kategoria|Category)\s*:\s*<[^>]*>\s*([^<]+)/i) ||
      firstMatch(forward, />\s*(?:Kategoria|Category)\s*:\s*([^<]+)/i) || ""
    );

    out.push({
      Title: title,
      Date: isoStart,
      Time: time,
      Venue: venue,
      Category: category,
      Link: href,
      "Payment for Entry": detectPaymentList(forward), // "No" or ""
      Source: "lublin.eu",
      _EndDate: isoEnd,
      _fp_url: urlPath(href)
    });
  }
  return out;
}

//
// ---------- Official detail parser (prefer detail end date) ----------
function parseOfficialDetail(raw) {
  const html = normalizeHtml(raw);

  // Time
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

  // Dates from detail (prefer EndDate)
  const dStart = firstMatch(html, />\s*Data\s*rozpoc(?:z|ż)ęcia\s*:\s*<[^>]*>\s*([0-9]{2}-[0-9]{2}-[0-9]{4})/i);
  const dEnd   = firstMatch(html, />\s*Data\s*zako(?:ń|n)czenia\s*:\s*<[^>]*>\s*([0-9]{2}-[0-9]{2}-[0-9]{4})/i);
  const StartDate = dStart ? dStart.split('-').reverse().join('-') : "";
  const EndDate   = dEnd   ? dEnd.split('-').reverse().join('-')   : "";

  return { Time: t1, Venue: text(v1), Category: text(c1), Payment: payment, StartDate, EndDate };
}

//
// ---------- Payment normalization ----------
function detectPaymentList(block){
  const t = norm(block);
  if (/(wstep wolny|bezplatn|darmow|gratis|nieodplat)/.test(t)) return "No";
  return "";
}
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
  if (/(wstep wolny|bezplatn|darmow|gratis|nieodplat)/.test(t)) return "No"; // FREE first
  if (/\b\d+[.,]?\d*\s*(zl|pln)\b/.test(t) || /(platn|platny|patn|bilet|bilety|wejsciow|oplata|cena)/.test(t)) return "Yes";
  return "";
}

//
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
      else if (a && b && a !== b) prev["Payment for Entry"] = "No"; // prefer free on conflict
      // End date: keep the later one if present
      if (e._EndDate && (!prev._EndDate || e._EndDate > prev._EndDate)) prev._EndDate = e._EndDate;
    }
  }
  return [...map.values()];
}
