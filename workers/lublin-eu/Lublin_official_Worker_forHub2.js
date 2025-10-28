// Official-lublin-2hub — Payment fixed, subrequest-safe, NO Image URL

// Official-lublin-2hub — Payment = exact "Udział" value ("Bezpłatny" / "Płatny"), subrequest-safe, NO Image URL

export default {
  async fetch(request, env, ctx) {
    const u = new URL(request.url);
    const q = u.searchParams;

    // ---- inputs ----
    const startISO   = (q.get("date") || "").trim();
    const period     = (q.get("period") || "day").toLowerCase();  // day|week
    const daysParam  = int(q.get("days"), 0);
    const days       = daysParam || (period === "week" ? 7 : 1);

    const limit      = clamp(int(q.get("limit"), 200), 1, 10000);
    const pagesMax   = clamp(int(q.get("pages"), 3), 1, 5);
    const groupTimes = flag(q.get("group_times"));
    const wantRows   = flag(q.get("sheet"));

    // enrichment (detail fetches)
    const enrich     = flag(q.get("enrich"));
    const enrichMax  = clamp(int(q.get("enrich_max"), 15), 0, 30);

    // global subrequest budget (list pages + detail pages)
    const budgetMax  = clamp(int(q.get("budget"), 45), 20, 45);
    const budget     = { used: 0, max: budgetMax };

    // optional direct URL
    const explicitUrl = q.get("url") || "";

    if (!startISO && !explicitUrl) return jserr("Missing ?date=YYYY-MM-DD", 400);

    const start = startISO ? parseYMD(startISO) : parseFromUrl(explicitUrl);
    if (!start) return jserr("Bad or missing date", 400);
    const end = addDays(start, days - 1);

    const scanned = [];
    let pages_scanned = 0;

    const events = [];

    try {
      // Build day URLs
      const dayUrls = [];
      if (explicitUrl && /\d{2}-\d{2}-\d{4},dzien/i.test(explicitUrl)) {
        dayUrls.push(explicitUrl);
      } else {
        for (let i = 0; i < days; i++) {
          dayUrls.push(`https://lublin.eu/kultura/wydarzenia/${toDMY(addDays(start, i))},dzien.html`);
        }
      }

      // Over-fetch slightly when grouping showtimes
      const fetchCap = groupTimes ? limit * 3 : limit;

      // Scan list pages with budget checks
      outer:
      for (const dayUrl of dayUrls) {
        if (budget.used >= budget.max) break;
        const r1 = await fetchPage(dayUrl, ctx, budget);
        pages_scanned++; scanned.push(dayUrl);
        if (r1.ok) collect(parseLublinList(r1.html, dayUrl));
        if (events.length >= fetchCap) break;

        // next pages 2..pagesMax
        const m = /\/(\d{2}-\d{2}-\d{4}),dzien/i.exec(dayUrl);
        if (!m) continue;
        for (let p = 2; p <= pagesMax; p++) {
          if (budget.used >= budget.max || events.length >= fetchCap) break;
          const next = `https://lublin.eu/kultura/wydarzenia/${p},${m[1]},strona_dzien.html`;
          const r = await fetchPage(next, ctx, budget);
          pages_scanned++; scanned.push(next);
          if (!r.ok) break;
          collect(parseLublinList(r.html, next));
          if (events.length >= fetchCap) break outer;
        }
        if (events.length >= fetchCap) break;
      }

      // Enrichment — detail page is authoritative for "Payment for Entry"
      let enrichedCount = 0;
      let enrich_scanned = [];
      if (enrich && events.length && budget.used < budget.max) {
        const remaining = Math.max(0, budget.max - budget.used);
        const useCap = Math.min(enrichMax, remaining);
        if (useCap > 0) {
          const enr = await enrichDetails(events, useCap, ctx, budget);
          enrichedCount = enr.enriched;
          enrich_scanned = enr.scanned;
        }
      }

      // Group same-day showtimes if requested
      const finalized = groupTimes ? groupSameDayShowtimes(events) : events;
      const sliced = finalized.slice(0, limit);

      // Build payload (NO Image URL)
      const payload = {
        source: "lublin.eu",
        url: explicitUrl || "https://lublin.eu/kultura/wydarzenia",
        start: fmt(start),
        end: fmt(end),
        pages_scanned,
        scanned,
        budget_used: budget.used,
        budget_max: budget.max,
        count: sliced.length,
        enriched: enrichedCount,
        enrich_scanned,
        events: sliced,
      };

      if (wantRows) {
        // Columns: Title, Date, Time, Venue, Category, Link, Payment for Entry, Source
        payload.rows = sliced.map(e => ({
          values: [
            e.Title || "",
            e.Date || "",
            e.Time || "",
            e.Venue || "",
            e.Category || "",
            e.Link || "",
            e["Payment for Entry"] || "",
            e.Source || "",
          ],
        }));
      }

      return json(payload);

      function collect(arr) {
        for (const e of arr) {
          events.push(e);
          if (events.length >= fetchCap) break;
        }
      }
    } catch (e) {
      return jserr(String(e), 500);
    }
  }
};

/* ---------------- HTTP + cache (budget-aware) ---------------- */
async function fetchPage(url, ctx, budget) {
  if (budget && budget.used >= budget.max) return { ok: false, status: 0, html: "" };

  const cache = caches.default;
  const req = new Request(url, {
    headers: {
      "User-Agent": "LublinEventsBot/1.0",
      "Accept-Language": "pl-PL,pl;q=0.9",
      "Accept": "text/html,*/*",
    },
  });

  const cached = await cache.match(req);
  if (cached) return { ok: true, html: await cached.text() };

  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 20000);
  try {
    if (budget) budget.used++;
    let res = await fetch(req, { signal: ctrl.signal, redirect: "follow" });

    // Single retry for transient CF errors
    if (!res.ok && [520, 522, 523, 524].includes(res.status)) {
      if (!budget || budget.used < budget.max) {
        if (budget) budget.used++;
        res = await fetch(req, { signal: ctrl.signal, redirect: "follow" });
      }
    }

    const html = await res.text();
    if (res.ok) {
      const out = new Response(html, {
        headers: { "content-type": "text/html", "cache-control": "public, max-age=900" },
      });
      if (ctx) ctx.waitUntil(cache.put(req, out.clone()));
      return { ok: true, html };
    }
    return { ok: false, html };
  } finally {
    clearTimeout(t);
  }
}

/* ---------------- List parser (robust fields + multi-times) ---------------- */
function parseLublinList(raw, baseUrl) {
  const html = normalizeHtml(raw);
  const out = [];

  // Card title + link anchors each event
  const reTitle = /<div\s+class="event-title">\s*<a\s+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi;
  let m;
  while ((m = reTitle.exec(html)) !== null) {
    const href = absUrl(baseUrl, (m[1] || "").trim());
    const title = text(m[2]);
    if (!title) continue;

    // Local block around the title to capture its card context
    const start = Math.max(0, m.index - 2000);
    const block = html.slice(start, Math.min(html.length, m.index + 2000));

    // Date -> ISO
    const dmy =
      lastMatch(
        block,
        /<span[^>]*class="[^"]*event-date[^"]*"[^>]*>\s*([0-9]{2}-[0-9]{2}-[0-9]{4})\s*<\/span>/gi
      ) || "";
    const iso = dmy ? dmy.split("-").reverse().join("-") : "";

    // All times on the card
    const times = [];
    const reTime = /class="[^"]*event-time[^"]*"[^>]*>\s*([0-9]{1,2}:[0-9]{2})\s*<\/span>/gi;
    let tm;
    while ((tm = reTime.exec(block)) !== null) times.push(tm[1]);
    const time = Array.from(new Set(times)).sort().join(", ");

    // Venue
    const venue = text(
      lastMatch(
        block,
        /class="[^"]*(?:event__place|place|lokalizacja)[^"]*"[^>]*>\s*([\s\S]*?)<\/(?:div|span|li)>/gi
      ) ||
        lastMatch(block, />\s*(?:Miejsce|Lokalizacja)\s*:\s*<[^>]*>\s*([^<]+)/gi) ||
        lastMatch(block, />\s*(?:Miejsce|Lokalizacja)\s*:\s*([^<]+)/gi) ||
        ""
    );

    // Category
    const category = text(
      lastMatch(
        block,
        /class="[^"]*(?:event__category|category|tag)[^"]*"[^>]*>\s*([\s\S]*?)<\/(?:div|span|a)>/gi
      ) ||
        lastMatch(block, />\s*(?:Kategoria|Category)\s*:\s*<[^>]*>\s*([^<]+)/gi) ||
        lastMatch(block, />\s*(?:Kategoria|Category)\s*:\s*([^<]+)/gi) ||
        ""
    );

    out.push({
      Title: title,
      Date: iso,
      Time: time,
      Venue: venue,
      Category: category,
      Link: href,
      // On list cards, only mark clearly free (never force "Płatny" here)
      "Payment for Entry": detectPaymentList(block),
      Source: "lublin.eu",
      _EndDate: iso,
      _fp_url: urlPath(href),
      _fp_tdv: f_title_date_venue({ Title: title, Date: iso, Venue: venue }),
    });
  }
  return out;
}

/* ---------------- Enrichment (detail pages) ---------------- */
async function enrichDetails(list, cap, ctx, budget) {
  // Enrich items missing Payment OR critical fields
  const targets = list.filter(
    e => !(e["Payment for Entry"] || "") || !e.Time || !e.Venue || !e.Category
  );

  const scanned = [];
  let enriched = 0;

  for (const e of targets.slice(0, cap)) {
    if (budget && budget.used >= budget.max) break;

    const r = await fetchPage(e.Link, ctx, budget);
    if (!r.ok) continue;
    scanned.push(e.Link);

    const info = parseLublinDetail(r.html, e.Link);

    // Detail is authoritative for payment — use exact Polish label value
    if (info.Payment) e["Payment for Entry"] = info.Payment;

    // Merge time(s)
    if (info.Time) e.Time = e.Time ? mergeTimes(e.Time, info.Time) : info.Time;

    // Fill venue/category if empty
    if (info.Venue && !e.Venue) e.Venue = info.Venue;
    if (info.Category && !e.Category) e.Category = info.Category;

    enriched++;
  }
  return { enriched, scanned };
}

function parseLublinDetail(raw, url) {
  const html = normalizeHtml(raw);

  // TIME
  const t1 =
    labelValue(html, 'Godzina(?:\\s+rozpocz(?:e|ę)cia)?') ||
    labelBlock(html, 'Godzina(?:\\s+rozpocz(?:e|ę)cia)?') ||
    lastMatch(
      html,
      /(?:Godzina|Godzina rozpoczecia|Godzina rozpoczęcia|Godz\.)[^<]{0,80}?>\s*([0-9]{1,2}:[0-9]{2})/gi
    ) ||
    lastMatch(html, /(?:Godzina|Godz\.)\s*:?:?\s*([0-9]{1,2}:[0-9]{2})/gi) ||
    (html.match(/(^|>|\s)([0-9]{1,2}:[0-9]{2})(\s|<)/) ? RegExp.$2 : "");

  // VENUE
  const v1 =
    labelValue(html, '(?:Miejsce|Lokalizacja)') ||
    labelBlock(html, '(?:Miejsce|Lokalizacja)') ||
    lastMatch(html, /(?:Miejsce|Lokalizacja)\s*:\s*<[^>]*>\s*([^<]+)/gi) ||
    lastMatch(
      html,
      /class="[^"]*(?:place|lokalizacja|event__place)[^"]*"[^>]*>\s*([\s\S]*?)<\/(?:div|span|li)>/gi
    ) ||
    "";

  // CATEGORY
  const c1 =
    labelValue(html, '(?:Kategoria|Category)') ||
    labelBlock(html, '(?:Kategoria|Category)') ||
    lastMatch(html, /(?:Kategoria|Category)\s*:\s*<[^>]*>\s*([^<]+)/gi) ||
    lastMatch(
      html,
      /class="[^"]*(?:category|event__category)[^"]*"[^>]*>\s*([\s\S]*?)<\/(?:div|span|a)>/gi
    ) ||
    "";

  // PAYMENT — prefer labeled "Udział/Wstęp" value; otherwise infer from page
  let labelVal =
    labelBlock(html, '(?:Udział|Udzial|Wstęp|Wstep)') ||   // allow inner tags
    labelValue(html, '(?:Udział|Udzial|Wstęp|Wstep)') ||   // plain text value
    lastMatch(html, /(?:Udział|Udzial|Wstęp|Wstep)\s*:\s*<[^>]*>\s*([^<]+)/gi) ||
    "";

  let payment = "";
  if (labelVal) {
    payment = normalizePaymentExact(labelVal); // -> "Bezpłatny" | "Płatny" | (value cleaned)
  } else {
    payment = detectPaymentPage(html);         // -> "Bezpłatny"/"Płatny"/""
  }

  return {
    Time: t1,
    Venue: text(v1),
    Category: text(c1),
    Payment: payment,
  };
}

/* ---------------- Helpers ---------------- */
function flag(v) { return ["1","true","yes","y"].includes(String(v||"").toLowerCase()); }
function int(v, d) { const n = parseInt(v ?? "", 10); return Number.isFinite(n) ? n : d; }
function clamp(n, lo, hi) { return Math.max(lo, Math.min(hi, n)); }

function normalizeHtml(s) {
  return (s || "")
    .replace(/\r/g, "")
    .replace(/\t/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/[‐-‒–—]/g, "—");
}

function stripTags(s) { return (s || "").replace(/<[^>]*>/g, " "); }
function decodeEntities(s){
  return (s||"")
    .replace(/&quot;|&#34;/g, '"')
    .replace(/&apos;|&#39;/g, "'")
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&laquo;|&#171;/g, '«')
    .replace(/&raquo;|&#187;/g, '»');
}
function text(s) { return decodeEntities(stripTags(s)).replace(/\s+/g, " ").trim(); }
function normalizeDiacritics(s){ return text(s).normalize("NFKD").replace(/[\u0300-\u036f]/g,"").toLowerCase(); }

function lastMatch(str, re){
  let m, last = null;
  while ((m = re.exec(str)) !== null) { last = m[1] || m[0]; }
  return last;
}

// label readers for <div class="form-row"><span class="label">LABEL</span><span>VALUE</span>
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

/* --- Payment mapping helpers --- */
// On list: only set when clearly free (never force paid on list)
function detectPaymentList(block){
  const t = normalizeDiacritics(block);
  if (/(wstep wolny|bezplatn|darmow|gratis|free|nieodplat)/.test(t)) return "Bezpłatny";
  return "";
}
// Fallback on whole page if label missing
function detectPaymentPage(html){
  const t = normalizeDiacritics(html);
  const free = /(wstep wolny|bezplatn|darmow|gratis|free|nieodplat)/.test(t);
  const paid = /(platn|platny|bilet|bilety|wejsciow|oplata|cena|pln|zl|\b\d+[.,]?\d*\s*(zl|pln)\b)/.test(t);
  if (free && !paid) return "Bezpłatny";
  if (paid && !free) return "Płatny";
  if (free && paid)  return "Bezpłatny"; // prefer Free when both appear
  return "";
}
// Normalize any label text to the canonical values
function normalizePaymentExact(value){
  const raw = text(value);
  const t = normalizeDiacritics(raw);
  if (/bezplatn|wstep wolny|darmow|gratis|free|nieodplat/.test(t)) return "Bezpłatny";
  if (/platn|platny|bilet|bilety|oplata|cena|pln|zl|\b\d+[.,]?\d*\s*(zl|pln)\b/.test(t)) return "Płatny";
  // If label literally says something else, return its text (trimmed), but prefer canonical:
  return raw || "";
}

// times merging
function parseTimes(s){ const set=new Set(); (s||"").split(",").map(x=>x.trim()).filter(Boolean).forEach(t=>set.add(t)); return set; }
function mergeTimes(a,b){ const out=parseTimes(a); for(const t of parseTimes(b)) out.add(t); return Array.from(out).sort().join(", "); }

// grouping by Title|Date|Venue (same day showtimes); "Bezpłatny" wins over "Płatny"; any value wins over empty
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

      const pA = (prev["Payment for Entry"]||"").toLowerCase();
      const pB = (e["Payment for Entry"]||"").toLowerCase();
      if (!pA && pB) prev["Payment for Entry"] = e["Payment for Entry"];
      else if (pB && pA && pB !== pA) {
        // Prefer Bezpłatny over Płatny on conflict
        if (pB.includes("bezp")) prev["Payment for Entry"] = e["Payment for Entry"];
      }
    }
  }
  return [...map.values()];
}

// date helpers
function parseYMD(s){ const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s||""); return m ? new Date(Date.UTC(+m[1], +m[2]-1, +m[3])) : null; }
function addDays(d, n){ const x = new Date(d); x.setUTCDate(x.getUTCDate() + n); return x; }
function pad(n){ return n < 10 ? "0"+n : ""+n; }
function toDMY(d){ return `${pad(d.getUTCDate())}-${pad(d.getUTCMonth()+1)}-${d.getUTCFullYear()}`; }
function parseFromUrl(u){ const m = /\/(\d{2})-(\d{2})-(\d{4}),dzien\.html$/i.exec(u||""); return m ? new Date(Date.UTC(+m[3], +m[2]-1, +m[1])) : null; }
function fmt(d){ return d.toISOString().slice(0,10); }
function absUrl(base, href){ try { return new URL(href, base).toString(); } catch { return href; } }
function urlPath(u){ try { return new URL(u).pathname.replace(/\/+$/,""); } catch { return ""; } }
function json(obj, status=200){ return new Response(JSON.stringify(obj), { status, headers: { "content-type":"application/json; charset=utf-8", "access-control-allow-origin":"*" } }); }
function jserr(msg, status=400){ return json({ error: msg }, status); }
function normalizeForKey(s){ return (s||"").normalize("NFKD").replace(/[\u0300-\u036f]/g,"").toLowerCase().replace(/[^a-z0-9 ]/g," ").replace(/\s+/g," ").trim(); }
function f_title_date_venue(e){ return `${normalizeForKey(e.Title)}|${e.Date}|${normalizeForKey(e.Venue)}`; }
