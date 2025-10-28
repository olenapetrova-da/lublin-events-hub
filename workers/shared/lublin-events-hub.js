// lublin-events-hub — Service Bindings first (L_ZOOM / L_OFFICIAL), HTTP fallback
// Global dedupe + limit. Adds per-source stats, merged Sources list per event,
// and showtime merge stats. Returns events[] (sheet=0) or rows[] (9 cols, sheet=1).

export default {
  async fetch(request, env, ctx) {
    const u = new URL(request.url);
    const q = u.searchParams;

    // ---- inputs ----
    const date   = (q.get("date") || "").trim();
    const period = (q.get("period") || "day").toLowerCase(); // day|week
    const days   = q.get("days") || (period === "week" ? "7" : "1");
    const limit  = clamp(int(q.get("limit"), 30), 1, 1000);
    const pages  = clamp(int(q.get("pages"), 3), 1, 5);
    const sheet  = flag(q.get("sheet"));
    const groupTimes = flag(q.get("group_times"));
    if (!date) return json({ error: "Missing ?date=YYYY-MM-DD" }, 400);

    // ---- source resolution (bindings > explicit src list > CSV > legacy URLs) ----
    const hasZoomBinding   = !!env.L_ZOOM;
    const hasLublinBinding = !!env.L_OFFICIAL;

    const legacyZoom   = q.get("lublin_zoom")     || "https://zoom-lublin-2hub.elenipster.workers.dev/";
    const legacyLublin = q.get("lublin_official") || "https://official-lublin-2hub.elenipster.workers.dev/";

    // alias → binding (keep "lublin" as synonym if you want)
    const aliasToBinding = { zoom: "L_ZOOM", official: "L_OFFICIAL", lublin: "L_OFFICIAL" };

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
      // default: prefer bindings if present, else fallback to legacy URLs
      if (hasZoomBinding)   sources.push({ type: "binding", name: "L_ZOOM"     }); else sources.push({ type: "http", url: withSlash(legacyZoom)   });
      if (hasLublinBinding) sources.push({ type: "binding", name: "L_OFFICIAL" }); else sources.push({ type: "http", url: withSlash(legacyLublin) });
    }

    // ---- over-fetch per source (more if grouping is on) ----
    const overFactor = groupTimes ? 3 : 2;
    const perSource  = Math.max((limit * overFactor) / Math.max(1, sources.length), limit);
    const per = Math.min(Math.ceil(perSource), 1000);

    // Query string for adapters
    const qs = `?date=${encodeURIComponent(date)}&period=${period}&days=${days}&limit=${per}` +
               `&sheet=0&group_times=${groupTimes ? "1" : "0"}&pages=${pages}`;

    // ---- run all sources in parallel ----
    const fetches = sources.map((src) => callAdapter(src, qs, env));
    const results = await Promise.all(fetches);

    // ---- collect ----
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

    // ---- dedupe + cap ----
    const stats = { merges: 0, time_merges: 0 };
    const uniq = dedupe(allEvents, stats);
    const top = uniq.slice(0, limit);

    // enrich + rows
    const rows = top.map(toRow);
    const topEnriched = top.map(e => ({
      ...e,
      Sources: (Array.isArray(e._via) ? Array.from(new Set(e._via)).join(", ") : (e.Source || ""))
    }));

    return json({
      source: "events-hub",
      date, period, days,
      sources_count: sources.length,
      received: allEvents.length,
      deduped: uniq.length,
      count: top.length,
      per_source,
      dedupe_stats: { merges: stats.merges, showtime_merges: stats.time_merges },
      errors: errors.length ? errors : undefined,
      rows: sheet ? rows : undefined,
      events: sheet ? undefined : topEnriched
    });
  }
};

/* ---------------- calls & utils ---------------- */
async function callAdapter(src, qs, env){
  const headers = { "Accept": "application/json" };
  try {
    if (src.type === "binding") {
      const url = new URL("https://internal/" + qs);
      const req = new Request(url, { headers, method: "GET" });
      const res = await env[src.name].fetch(req);
      const raw = await res.text();
      let data = {}; try { data = JSON.parse(raw); } catch { data = { raw: raw.slice(0,800) }; }
      return { ok: res.ok, data, source: `[binding:${src.name}]` , status: res.status };
    } else {
      const url = withSlash(src.url) + qs; // http
      const ctrl = new AbortController();
      const t = setTimeout(() => ctrl.abort(), 20000);
      try {
        let res = await fetch(url, { signal: ctrl.signal, headers, redirect: "follow" });
        if (!res.ok && [520,522,523,524].includes(res.status)) res = await fetch(url, { signal: ctrl.signal, headers, redirect: "follow" });
        const raw = await res.text();
        let data = {}; try { data = JSON.parse(raw); } catch { data = { raw: raw.slice(0,800) }; }
        return { ok: res.ok, data, source: url, status: res.status };
      } finally { clearTimeout(t); }
    }
  } catch (e) {
    return { ok: false, error: String(e), source: src.type === "binding" ? `[binding:${src.name}]` : (src.url + qs) };
  }
}

function flag(v){ return ["1","true","yes","y"].includes(String(v||"").toLowerCase()); }
function int(v, d){ const n = parseInt(v ?? "", 10); return Number.isFinite(n) ? n : d; }
function clamp(n, lo, hi){ return Math.max(lo, Math.min(hi, n)); }
function json(obj, status=200){ return new Response(JSON.stringify(obj), { status, headers: { "content-type":"application/json; charset=utf-8", "access-control-allow-origin":"*" } }); }
function withSlash(s){ s = String(s||"").trim(); return s.endsWith("/") ? s : (s + "/"); }

function prettySourceTag(rSource, eSource){
  if (eSource && eSource.trim()) return eSource.trim();
  const s = String(rSource||"");
  if (s.startsWith("[binding:L_ZOOM]")) return "zoom";
  if (s.startsWith("[binding:L_OFFICIAL]")) return "official";
  try { const u = new URL(s); return u.hostname; } catch { return s; }
}

/* ---- dedupe & helpers ---- */
function toRow(e){ return { values: [ e.Title||"", e.Date||"", e.Time||"", e.Venue||"", e.Category||"", e.Link||"", e["Image URL"]||"", e["Payment for Entry"]||"", e.Source||"" ]}; }
function normalizeForKey(s){ return (s||"").normalize("NFKD").replace(/[\u0300-\u036f]/g,"").toLowerCase().replace(/[^a-z0-9 ]/g," ").replace(/\s+/g," ").trim(); }
function urlPath(u){ try { return new URL(u).pathname.replace(/\/+$/,""); } catch { return ""; } }
function titleDateVenueKey(e){ return `${normalizeForKey(e.Title)}|${e.Date||""}|${normalizeForKey(e.Venue)}`; }
function tokenSet(s){ return new Set(normalizeForKey(s).split(" ").filter(Boolean)); }
function overlap(a,b){ const A=tokenSet(a),B=tokenSet(b); if(!A.size||!B.size) return 0; let c=0; for(const t of A) if(B.has(t)) c++; return c/Math.min(A.size,B.size); }
function sameDate(a,b){ return (a||"") === (b||""); }
function parseTimes(s){ const set=new Set(); (s||"").split(",").map(x=>x.trim()).filter(Boolean).forEach(t=>set.add(t)); return set; }
function mergeTimes(a,b){ const out=parseTimes(a); for(const t of parseTimes(b)) out.add(t); return Array.from(out).sort().join(", "); }
function scoreQuality(e){ let s=0; if(e["Image URL"]) s++; if((e.Category||"").trim()) s++; if((e["Payment for Entry"]||"").trim()) s++; if((e.Time||"").trim()) s++; return s; }

function pickBetter(a, b){
  const sa = scoreQuality(a), sb = scoreQuality(b);

  // pick the richer record, but don't lose times
  let winner, other;
  if (sa > sb) { winner = a; other = b; }
  else if (sb > sa) { winner = b; other = a; }
  else {
    // tie-breakers, but still decide a single "winner"
    if ((a["Payment for Entry"]||"") && !(b["Payment for Entry"]||"")) { winner = a; other = b; }
    else if ((b["Payment for Entry"]||"") && !(a["Payment for Entry"]||"")) { winner = b; other = a; }
    else if ((a["Image URL"]||"") && !(b["Image URL"]||"")) { winner = a; other = b; }
    else if ((b["Image URL"]||"") && !(a["Image URL"]||"")) { winner = b; other = a; }
    else { winner = a; other = b; }
  }

  // --- ALWAYS union showtimes ---
  if (winner.Time && other.Time) winner.Time = mergeTimes(winner.Time, other.Time);
  else if (!winner.Time && other.Time) winner.Time = other.Time;

  return winner;
}


function dedupe(list, stats){
  stats = stats || { merges: 0, time_merges: 0 };
  const out = [];
  const keyToIdx = new Map(); // both URL and TDV keys map to one index in out

  for (const e of list) {
    const d = e.Date || "";
    const urlCore = e._fp_url || urlPath(e.Link);
    const tdvCore = e._fp_tdv || titleDateVenueKey(e);
    const urlKey = urlCore ? `${d}|${urlCore}` : "";
    const tdvKey = tdvCore ? `${d}|${tdvCore}` : "";

    // exact match first
    let idx = -1;
    if (urlKey && keyToIdx.has(urlKey)) idx = keyToIdx.get(urlKey);
    else if (tdvKey && keyToIdx.has(tdvKey)) idx = keyToIdx.get(tdvKey);
    else {
      // fuzzy fallback against already-kept items
      for (let i = 0; i < out.length; i++) {
        const ex = out[i];
        if (d !== (ex.Date || "")) continue;
        if (overlap(e.Title || "", ex.Title || "") >= 0.85 &&
            overlap(e.Venue || "", ex.Venue || "") >= 0.60) { idx = i; break; }
      }
    }

    if (idx === -1) {
      idx = out.length;
      const copy = { ...e };
      if (!Array.isArray(copy._via)) copy._via = (copy.Source ? [copy.Source] : []);
      out.push(copy);
    } else {
      const beforeTime = out[idx].Time;
      const beforeVia = Array.isArray(out[idx]._via) ? new Set(out[idx]._via) : new Set();
      out[idx] = pickBetter(out[idx], e);
      stats.merges++;
      const beforeSize = parseTimes(beforeTime).size;
      const afterSize  = parseTimes(out[idx].Time).size;
      if (beforeSize && parseTimes(e.Time).size && afterSize > beforeSize) stats.time_merges++;

      // union sources
      const add = Array.isArray(e._via) ? e._via : (e.Source ? [e.Source] : []);
      for (const v of add) beforeVia.add(v);
      out[idx]._via = Array.from(beforeVia);
    }

    if (urlKey) keyToIdx.set(urlKey, idx);
    if (tdvKey) keyToIdx.set(tdvKey, idx);
  }

  return out;
}
