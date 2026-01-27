// CHANGELOG — 2025-11-07 (addendum #3)
// - New: Cross-source **venue-less fallback** dedupe so Official (no Venue on list) can merge with Zoom
//   without enabling enrichment. The fallback requires:
//     • Same Date
//     • Time overlap (identical HH:MM or within ±5 minutes) — only if both have at least one time
//     • AND (Title token Jaccard ≥ 0.92  OR  URL slug token Jaccard ≥ 0.70)
//   On merge we union showtimes, prefer non-empty Venue/Payment, and pick Source with priority Zoom > Official.
//   Stats now include `fallback_merges`.
//
// - Why: lublin.eu list cards don’t expose Venue; with the primary rule (title+date+time+venue)
//   duplicates from Zoom/Official weren’t merged. This fallback solves that without extra subrequests.
//
// NOTE: No API/response shape changes; just smarter dedupe behavior.

// CHANGELOG — 2025-11-05 (addendum #2)
// - New: Ranking — timed events first, then ongoing/no-time; within each group sort by Date, then earliest Time.
// - No API changes. Rows & events reflect the new order.
// - (Context) Pass-through for include_in_progress already present.

// CHANGELOG — 2025-11-05 (addendum)
// - New: Pass-through for ?include_in_progress=1|0 (default if missing: 1) and ?inprog_pages=1..3 (default: 1).
//        The Hub forwards these to adapters so we can include ongoing events from /w-trakcie by default,
//        but still have a switch for time-specific use cases or as a kill-switch if needed.

// CHANGELOG — 2026-01-27 (S2-07A Payment strategy v2)
// - Fix: When merging duplicates across sources, preserve FREE signal.
//        If *any* merged record has "Payment for Entry" == "No" then the merged event keeps "No".
//        Rationale: in S2-07A we only have free|unknown (no reliable "paid"); so "No" is the strongest signal.

// lublin-events-hub — Orchestrator for multiple adapters (bindings preferred, HTTP fallback)
// Contract: adapters return JSON with events[] when sheet=0 (default). Hub dedupes + caps.
// Sheet mode (sheet=1) returns rows[] with 8 columns (NO Image URL): 
// [Title, Date, Time, Venue, Category, Link, Payment for Entry, Source]

// CHANGELOG — 2025-11-07 (addendum #3)
// - New: Cross-source **venue-less fallback** dedupe so Official (no Venue on list) can merge with Zoom
//   without enabling enrichment. The fallback requires:
//     • Same Date
//     • Time overlap (identical HH:MM or within ±5 minutes) — only if both have at least one time
//     • AND (Title token Jaccard ≥ 0.92  OR  URL slug token Jaccard ≥ 0.70)
//   On merge we union showtimes, prefer non-empty Venue/Payment, and pick Source with priority Zoom > Official.
//   Stats now include `fallback_merges`.
//
// - Why: lublin.eu list cards don’t expose Venue; with the primary rule (title+date+time+venue)
//   duplicates from Zoom/Official weren’t merged. This fallback solves that without extra subrequests.
//
// NOTE: No API/response shape changes; just smarter dedupe behavior.

// CHANGELOG — 2025-11-05 (addendum #2)
// - New: Ranking — timed events first, then ongoing/no-time; within each group sort by Date, then earliest Time.
// - No API changes. Rows & events reflect the new order.
// - (Context) Pass-through for include_in_progress already present.

// CHANGELOG — 2025-11-05 (addendum)
// - New: Pass-through for ?include_in_progress=1|0 (default if missing: 1) and ?inprog_pages=1..3 (default: 1).
//        The Hub forwards these to adapters so we can include ongoing events from /w-trakcie by default,
//        but still have a switch for time-specific use cases or as a kill-switch if needed.

// lublin-events-hub — Orchestrator for multiple adapters (bindings preferred, HTTP fallback)
// Contract: adapters return JSON with events[] when sheet=0 (default). Hub dedupes + caps.
// Sheet mode (sheet=1) returns rows[] with 8 columns (NO Image URL): 
// [Title, Date, Time, Venue, Category, Link, Payment for Entry, Source]

export default {
  async fetch(request, env, ctx) {
    const u = new URL(request.url);
    const q = u.searchParams;

    // ---- Inputs (refresh-runbook defaults) ----
    const date       = (q.get("date") || "").trim();
    const period     = (q.get("period") || "day").toLowerCase(); // day|week
    const days       = q.get("days") || (period === "week" ? "7" : "1");
    const limit      = clamp(int(q.get("limit"), 1000), 1, 1000);
    const pages      = clamp(int(q.get("pages"), 3), 1, 5);
    const sheet      = flag(q.get("sheet"));          // JSON mode by default (sheet=0)
    const groupTimes = flag(q.get("group_times"));    // union showtimes at adapter level

    if (!date) return json({ error: "Missing ?date=YYYY-MM-DD" }, 400);

    // Optional enrichment pass-through (adapters handle details/budget internally)
    const enrich     = flag(q.get("enrich"));
    const enrich_max = clamp(int(q.get("enrich_max"), 15), 1, 100);
    const budget     = int(q.get("budget"), 0);       // optional: forwarded to adapters iff >0

    // NEW: include-in-progress pass-through (default ON if not specified)
    const includeInProgress = q.has("include_in_progress") ? flag(q.get("include_in_progress")) : true;
    const inprogPages       = clamp(int(q.get("inprog_pages"), 1), 1, 3);

    // ---- Source resolution (bindings > explicit src > CSV list > legacy URLs) ----
    const hasZoomBinding   = !!env.L_ZOOM;
    const hasLublinBinding = !!env.L_OFFICIAL;

    const legacyZoom   = withSlash(q.get("lublin_zoom")     || "https://zoom-lublin-2hub.elenipster.workers.dev/");
    const legacyLublin = withSlash(q.get("lublin_official") || "https://official-lublin-2hub.elenipster.workers.dev/");

    const aliasToBinding = { zoom: "L_ZOOM", official: "L_OFFICIAL"/*, lublin: "L_OFFICIAL"*/ };

    const srcs = q.getAll("src").map(s => s.trim()).filter(Boolean);
    let sources = [];
    if (srcs.length) {
      for (const s of srcs) {
        const key = s.toLowerCase();
        const binding = aliasToBinding[key];
        if (binding && env[binding]) sources.push({ type: "binding", name: binding });
        else sources.push({ type: "http", url: withSlash(s) });
      }
    } else if ((q.get("sources") || "").trim()) {
      sources = q.get("sources").split(",").map(s => ({ type: "http", url: withSlash(s.trim()) }));
    } else {
      if (hasZoomBinding)   sources.push({ type: "binding", name: "L_ZOOM"     }); else sources.push({ type: "http", url: legacyZoom   });
      if (hasLublinBinding) sources.push({ type: "binding", name: "L_OFFICIAL" }); else sources.push({ type: "http", url: legacyLublin });
    }

    // ---- Over-fetch per source (helps dedupe; adapters still cap by `limit=per`) ----
    const overFactor = groupTimes ? 3 : 2;
    const perSource  = Math.max((limit * overFactor) / Math.max(1, sources.length), limit);
    const per        = Math.min(Math.ceil(perSource), 1000);

    // Build adapter query
    let qs = `?date=${encodeURIComponent(date)}&period=${period}&days=${encodeURIComponent(days)}&limit=${per}` +
             `&sheet=0&group_times=${groupTimes ? "1" : "0"}&pages=${pages}` +
             `&include_in_progress=${includeInProgress ? "1" : "0"}&inprog_pages=${inprogPages}`;
    if (enrich) qs += `&enrich=1&enrich_max=${enrich_max}`;
    if (budget > 0) qs += `&budget=${clamp(budget, 1, 48)}`;

    // ---- Run all sources in parallel ----
    const fetches = sources.map((src) => callAdapter(src, qs, env));
    const results = await Promise.all(fetches);

    // ---- Collect events + per-source stats ----
    const allEvents = [];
    const errors = [];
    const per_source = results.map(r => ({
      source: r.source,
      got: (r.ok && r.data && Array.isArray(r.data.events)) ? r.data.events.length : 0,
      ok: r.ok,
      status: r.status
    }));

    for (const r of results) {
      if (r.ok) {
        const list = Array.isArray(r.data?.events) ? r.data.events : [];
        for (const e of list) {
          const via = prettySourceTag(r.source, e.Source);
          if (!Array.isArray(e._via)) e._via = [];
          e._via.push(via);
          allEvents.push(e);
        }
      } else {
        errors.push({ source: r.source, status: r.status, error: r.error, data: r.data });
      }
    }

    // ---- Dedupe + ORDER + cap ----
    const stats = { merges: 0, time_merges: 0, fallback_merges: 0 }; // <— added fallback counter
    const uniq = dedupe(allEvents, stats);

    // Order: timed first, then ongoing/no-time; then by Date, then earliest Time
    const ordered = uniq.slice().sort(orderEvents);
    const top = ordered.slice(0, limit);

    // ---- Prepare outputs
    const rows = top.map(toRow);
    const topEnriched = top.map(e => ({
      ...e,
      Sources: (Array.isArray(e._via) ? Array.from(new Set(e._via)).join(", ") : (e.Source || ""))
    }));

    // Envelope fields useful for runbook visibility
    const envelope = {
      source: "events-hub",
      date, period, days,
      group_times: groupTimes ? 1 : 0,
      pages,
      limit,
      enrich: enrich ? 1 : 0,
      enrich_max: enrich ? enrich_max : 0,
      budget: budget > 0 ? clamp(budget, 1, 48) : 0,
      include_in_progress: includeInProgress ? 1 : 0,
      inprog_pages: inprogPages
    };

    return json({
      ...envelope,
      sources_count: sources.length,
      received: allEvents.length,
      deduped: uniq.length,
      count: top.length,
      per_source,
      dedupe_stats: { merges: stats.merges, showtime_merges: stats.time_merges, fallback_merges: stats.fallback_merges },
      errors: errors.length ? errors : undefined,
      rows: sheet ? rows : undefined,
      events: sheet ? undefined : topEnriched
    });
  }
};

/* ---------------- adapter calls ---------------- */
async function callAdapter(src, qs, env){
  const headers = { "Accept": "application/json" };
  try {
    if (src.type === "binding") {
      const url = new URL("https://internal/" + qs);
      const req = new Request(url, { headers, method: "GET" });
      const res = await env[src.name].fetch(req);
      const raw = await res.text();
      let data = {}; try { data = JSON.parse(raw); } catch {  data = { raw: raw.slice(0, 800) }; }
      return { ok: res.ok, data, source: `[binding:${src.name}]`, status: res.status };
    } else {
      const url = withSlash(src.url) + qs;
      const ctrl = new AbortController();
      const t = setTimeout(() => ctrl.abort(), 20000);
      try {
        let res = await fetch(url, { signal: ctrl.signal, headers, redirect: "follow" });
        if (!res.ok && [520, 522, 523, 524].includes(res.status)) {
          res = await fetch(url, { signal: ctrl.signal, headers, redirect: "follow" });
        }
        const raw = await res.text();
        let data = {}; try { data = JSON.parse(raw); } catch {  data = { raw: raw.slice(0, 800) }; }
        return { ok: res.ok, data, source: url, status: res.status };
      } finally {
        clearTimeout(t);
      }
    }
  } catch (e) {
    return { ok: false, error: String(e), source: src.type === "binding" ? `[binding:${src.name}]` : (src.url + qs) };
  }
}

/* ---------------- util ---------------- */
function flag(v){ return ["1","true","yes","y"].includes(String(v||"").toLowerCase()); }
function int(v, d){ const n = parseInt(v ?? "", 10); return Number.isFinite(n) ? n : d; }
function clamp(n, lo, hi){ return Math.max(lo, Math.min(hi, n)); }
function json(obj, status=200){ return new Response(JSON.stringify(obj), { status, headers: { "content-type":"application/json; charset=utf-8", "access-control-allow-origin":"*" } }); }
function withSlash(s){ s = String(s||"").trim(); return s.endsWith("/") ? s : (s + "/"); }

function prettySourceTag(rSource, eSource){
  if (eSource && eSource.trim()) return eSource.trim();
  const s = String(rSource||"");
  if (s.startsWith("[binding:L_ZOOM]")) return "zoom.lublin.pl";
  if (s.startsWith("[binding:L_OFFICIAL]")) return "lublin.eu";
  try { const u = new URL(s); return u.hostname; } catch { return s; }
}

function hasTime(e){ return !!((e.Time || "").trim()); }
function earliestTimeKey(e){
  if (!hasTime(e)) return "99:99";
  const parts = (e.Time || "").split(",").map(s => s.trim()).filter(Boolean);
  const sorted = parts.map(t => {
    const m = /^(\d{1,2}):(\d{2})$/.exec(t);
    if (!m) return "99:99";
    const hh = String(parseInt(m[1],10)).padStart(2,"0");
    return `${hh}:${m[2]}`;
  }).sort();
  return sorted[0] || "99:99";
}
function orderEvents(a, b){
  const aTimed = hasTime(a), bTimed = hasTime(b);
  if (aTimed !== bTimed) return aTimed ? -1 : 1;                  // timed first
  const ad = a.Date || "", bd = b.Date || "";
  if (ad !== bd) return ad < bd ? -1 : 1;                         // then by date
  if (aTimed && bTimed) {                                         // then by earliest time
    const at = earliestTimeKey(a), bt = earliestTimeKey(b);
    if (at !== bt) return at < bt ? -1 : 1;
  }
  // tie-breaker: title A→Z
  return (a.Title || "").localeCompare(b.Title || "", "pl", { sensitivity: "base" });
}

/* ---------------- dedupe & scoring ---------------- */
function toRow(e){
  // 8 columns: Title, Date, Time, Venue, Category, Link, Payment for Entry, Source
  return { values: [
    e.Title || "",
    e.Date || "",
    e.Time || "",
    e.Venue || "",
    e.Category || "",
    e.Link || "",
    e["Payment for Entry"] || "",
    e.Source || ""
  ]};
}

function normalizeForKey(s){ return (s||"").normalize("NFKD").replace(/[\u0300-\u036f]/g,"").toLowerCase().replace(/[^a-z0-9 ]/g," ").replace(/\s+/g," ").trim(); }
function urlPath(u){ try { return new URL(u).pathname.replace(/\/+$/,""); } catch { return ""; } }
function titleDateVenueKey(e){ return `${normalizeForKey(e.Title)}|${e.Date||""}|${normalizeForKey(e.Venue)}`; }

function tokenSet(s){ return new Set(normalizeForKey(s).split(" ").filter(Boolean)); }
function jaccardSets(A, B){ if(!A.size && !B.size) return 1; if(!A.size || !B.size) return 0; let c=0; for(const t of A) if(B.has(t)) c++; return c/(A.size + B.size - c); }
function overlap(a,b){ const A=tokenSet(a),B=tokenSet(b); if(!A.size||!B.size) return 0; let c=0; for(const t of A) if(B.has(t)) c++; return c/Math.min(A.size,B.size); }
function sameDate(a,b){ return (a||"") === (b||""); }

function parseTimes(s){
  const set=new Set();
  (s||"").split(",").map(x=>x.trim()).filter(Boolean).forEach(t=>{
    const m=/^(\d{1,2}):(\d{2})$/.exec(t);
    if(m){ const hh=Number(m[1]); const mm=Number(m[2]); if(hh>=0 && hh<=23 && mm>=0 && mm<=59){ set.add(`${String(hh).padStart(2,"0")}:${String(mm).padStart(2,"0")}`); } }
  });
  return set;
}
function timesOverlap(a, b, tolMin=5){
  const A=[...parseTimes(a)].map(t=>{const [h,m]=t.split(":");return Number(h)*60+Number(m);});
  const B=[...parseTimes(b)].map(t=>{const [h,m]=t.split(":");return Number(h)*60+Number(m);});
  if(!A.length || !B.length) return false;
  for(const x of A) for(const y of B) if (Math.abs(x-y) <= tolMin) return true;
  return false;
}
function mergeTimes(a,b){ const out=parseTimes(a); for(const t of parseTimes(b)) out.add(t); return Array.from(out).sort().join(", "); }

function slugTokens(u){
  const p = (typeof u === "string" && u) ? urlPath(u) : "";
  const seg = p ? p.split("/").filter(Boolean).pop() || "" : "";
  return new Set(seg.split(/[^a-z0-9]+/g).filter(Boolean));
}

// Quality score WITHOUT Image URL; prefer Payment/Time/Category/Venue presence
function scoreQuality(e){
  let s = 0;
  if ((e["Payment for Entry"]||"").trim()) s += 2; // payment is valuable
  if ((e.Time||"").trim()) s += 2;
  if ((e.Category||"").trim()) s += 1;
  if ((e.Venue||"").trim()) s += 1;
  return s;
}

function chooseSource(aSrc, bSrc){
  const rank = (s) => {
    const t = (s||"").toLowerCase();
    if (t.includes("zoom")) return 2;
    if (t.includes("lublin.eu") || t.includes("official")) return 1;
    return 0;
  };
  return rank(aSrc) >= rank(bSrc) ? aSrc : bSrc;
}

function pickBetter(a, b){
  const sa = scoreQuality(a), sb = scoreQuality(b);

  // pick the richer record, but don't lose times
  let winner, other;
  if (sa > sb) { winner = a; other = b; }
  else if (sb > sa) { winner = b; other = a; }
  else {
    const aPay = (a["Payment for Entry"]||"");
    const bPay = (b["Payment for Entry"]||"");
    if (aPay && !bPay) { winner = a; other = b; }
    else if (bPay && !aPay) { winner = b; other = a; }
    else if ((a.Time||"") && !(b.Time||"")) { winner = a; other = b; }
    else if ((b.Time||"") && !(a.Time||"")) { winner = b; other = a; }
    else { winner = a; other = b; }
  }

  if (!winner.event_ref && other.event_ref) winner.event_ref = other.event_ref;


  // --- ALWAYS union showtimes ---
  if (winner.Time && other.Time) winner.Time = mergeTimes(winner.Time, other.Time);
  else if (!winner.Time && other.Time) winner.Time = other.Time;

  // --- Payment merge policy (S2-07A) ---
  // We only emit: "No" (FREE) or empty/unknown. If either side is FREE, keep FREE.
  // This prevents losing a reliable FREE signal (e.g., from lublin.eu) when Zoom is preferred as Source.
  const payA = String(winner["Payment for Entry"] || "").trim();
  const payB = String(other["Payment for Entry"] || "").trim();
  const isFree = (p) => p.toLowerCase() === "no";
  if (isFree(payA) || isFree(payB)) {
    winner["Payment for Entry"] = "No";
  } else if (!payA && payB) {
    // Keep any future non-empty values from the other record, but trim whitespace-only.
    winner["Payment for Entry"] = payB;
  }

  // Prefer explicit _EndDate if winner lacks it
  if (!winner._EndDate && other._EndDate) winner._EndDate = other._EndDate;

  // Prefer Category/Venue if missing
  if (!winner.Category && other.Category) winner.Category = other.Category;
  if (!winner.Venue && other.Venue) winner.Venue = other.Venue;

  // Prefer higher-priority Source (Zoom > Official)
  const preferred = chooseSource(winner.Source, other.Source);
  if (preferred !== winner.Source) {
  winner.Source = preferred;

  // keep Source/Link/event_ref aligned
  if (other.Link) winner.Link = other.Link;
  if (other._fp_url) winner._fp_url = other._fp_url;
  if (other.event_ref) winner.event_ref = other.event_ref;
}

  return winner;
}

function ensureCache(e){
  if (!e._fp_url) e._fp_url = urlPath(e.Link);
  if (!e._norm_title) e._norm_title = tokenSet(e.Title || "");
  if (!e._slug_tokens) e._slug_tokens = slugTokens(e._fp_url || e.Link || "");
}

function dedupe(list, stats){
  stats = stats || { merges: 0, time_merges: 0, fallback_merges: 0 };
  const out = [];
  const keyToIdx = new Map();

  for (const e of list) {
    ensureCache(e);

    const d = e.Date || "";
    const urlCore = e._fp_url || urlPath(e.Link);
    const tdvCore = e._fp_tdv || titleDateVenueKey(e);
    const urlKey = urlCore ? `${d}|${urlCore}` : "";
    const tdvKey = tdvCore ? `${d}|${tdvCore}` : "";

    let idx = -1;
    if (urlKey && keyToIdx.has(urlKey)) idx = keyToIdx.get(urlKey);
    else if (tdvKey && keyToIdx.has(tdvKey)) idx = keyToIdx.get(tdvKey);
    else {
      for (let i = 0; i < out.length; i++) {
        const ex = out[i];
        if (!sameDate(d, ex.Date || "")) continue;

        // Ensure cache on candidate
        ensureCache(ex);

        // Primary rule: both have Venue → use existing title+venue overlap thresholds
        const bothHaveVenue = (e.Venue||"").trim() && (ex.Venue||"").trim();
        if (bothHaveVenue) {
          if (overlap(e.Title || "", ex.Title || "") >= 0.85 &&
              overlap(e.Venue || "", ex.Venue || "") >= 0.60) { idx = i; break; }
        } else {
          // Fallback rule (venue-less): Date equal AND times overlap AND (title OR slug sufficiently similar)
          const timesOk = timesOverlap(e.Time, ex.Time, 5);
          if (timesOk) {
            const titleJac = jaccardSets(e._norm_title, ex._norm_title);  // very strict
            const slugJac  = jaccardSets(e._slug_tokens, ex._slug_tokens);
            if (titleJac >= 0.92 || slugJac >= 0.70) { idx = i; stats.fallback_merges++; break; }
          }
        }
      }
    }

    if (idx === -1) {
      idx = out.length;
      const copy = { ...e };
      if (!Array.isArray(copy._via)) copy._via = (copy.Source ? [copy.Source] : []);
      out.push(copy);
    } else {
      const beforeTime = out[idx].Time;
      out[idx] = pickBetter(out[idx], e);
      stats.merges++;
      const beforeSize = parseTimes(beforeTime).size;
      const afterSize  = parseTimes(out[idx].Time).size;
      if (beforeSize && parseTimes(e.Time).size && afterSize > beforeSize) stats.time_merges++;

      const prevVia = Array.isArray(out[idx]._via) ? new Set(out[idx]._via) : new Set();
      const add = Array.isArray(e._via) ? e._via : (e.Source ? [e.Source] : []);
      for (const v of add) prevVia.add(v);
      out[idx]._via = Array.from(prevVia);
    }

    if (urlKey) keyToIdx.set(urlKey, idx);
    if (tdvKey) keyToIdx.set(tdvKey, idx);
  }

  return out;
}
