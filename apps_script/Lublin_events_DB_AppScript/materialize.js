/** materialize.gs — Enrich a small batch via Hub and patch raw_events in one write 
 * Calls Hub with enrich=1&enrich_max=15
 * Normalizes row dates to 'yyyy-MM-dd'
 * Compares scheme-agnostic URLs (host + path, strips query/hash and trailing slash)
 * Matches rows: Uses 3 keys (in order): Link|Date → Title|Date|Venue → Title|Date.
 * Updates in memory and writes back once (single batch write)
Rules:
  * Payment: “Yes” overrides “No/blank”; “No” fills blanks only
  * Time: merge CSV times (unique, sorted)
  * Venue/Category: fill blanks only
*/

function materialize() {
  const p = PropertiesService.getScriptProperties().getProperties();
  const HUB = ensureSlash(p.HUB_URL || '');
  const SHEET_ID = p.SHEET_ID || '';
  const TZ = p.TZ || Session.getScriptTimeZone() || 'Europe/Warsaw';
  const BATCH = Number(p.ENRICH_BATCH || 15);

  if (!HUB || !SHEET_ID) throw new Error('Missing HUB_URL or SHEET_ID');

  // same window as refresh()
  const dateISO = Utilities.formatDate(new Date(), TZ, 'yyyy-MM-dd');
  const baseQS = 'period=week&days=7&group_times=1&pages=3&limit=1000&sheet=0';
  const url = `${HUB}?date=${encodeURIComponent(dateISO)}&${baseQS}&enrich=1&enrich_max=${encodeURIComponent(BATCH)}`;

  const resp = UrlFetchApp.fetch(url, { headers: { 'Accept': 'application/json' }, muteHttpExceptions: true });
  const status = resp.getResponseCode();
  if (status !== 200) throw new Error(`Hub enrich HTTP ${status}: ${resp.getContentText().slice(0,300)}`);

  const data = JSON.parse(resp.getContentText() || '{}');
  const enriched = Array.isArray(data.events) ? data.events : [];
  if (!enriched.length) { Logger.log('materialize(): no events returned this pass.'); return; }

  // Build lookups from payload
  const byLD  = new Map();
  const byTDV = new Map();
  const byTD  = new Map();
  for (const e of enriched) {
    const payload = {
      pay: s(e['Payment for Entry']),
      time: s(e.Time),
      venue: s(e.Venue),
      cat: s(e.Category),
      date: s(e.Date),
      title: s(e.Title),
      link: s(e.Link)
    };
    const kLD  = keyLD_payload(e.Link, e.Date);
    const kTDV = keyTDV_payload(e.Title, e.Date, e.Venue);
    const kTD  = keyTD_payload(e.Title, e.Date);
    if (kLD)  byLD.set(kLD, payload);
    if (kTDV) byTDV.set(kTDV, payload);
    if (kTD)  byTD.set(kTD, payload);
  }

  const sh = SpreadsheetApp.openById(SHEET_ID).getSheetByName('raw_events');
  if (!sh) throw new Error('raw_events sheet not found');

  const rng = sh.getDataRange();
  const values = rng.getValues();
  if (!values.length) return;

  const headers = values[0].map(String);
  const idx = need(headers, ['Title','Date','Time','Venue','Category','Link','Payment for Entry','Source','_EndDate']);

  let changed = 0, hitLD=0, hitTDV=0, hitTD=0;

  for (let r = 1; r < values.length; r++) {
    const row = values[r];

    // Normalize row date to ISO string; normalize URL
    const rowDateISO = toISO(row[idx['Date']], TZ);
    const kLD_row  = keyLD_row(row[idx['Link']], rowDateISO);
    const kTDV_row = keyTDV_row(row[idx['Title']], rowDateISO, row[idx['Venue']]);
    const kTD_row  = keyTD_row(row[idx['Title']], rowDateISO);

    const from =
      (kLD_row  && byLD.get(kLD_row)) ||
      (kTDV_row && byTDV.get(kTDV_row)) ||
      (kTD_row  && byTD.get(kTD_row));

    if (!from) {
      // still default _EndDate
      if (!row[idx['_EndDate']] && rowDateISO) { row[idx['_EndDate']] = rowDateISO; changed++; }
      continue;
    }
    if (kLD_row && byLD.has(kLD_row)) hitLD++;
    else if (kTDV_row && byTDV.has(kTDV_row)) hitTDV++;
    else if (kTD_row && byTD.has(kTD_row)) hitTD++;

    // Payment: Yes overrides No/blank; No fills blank only
    const curPay = s(row[idx['Payment for Entry']]);
    if (from.pay === 'Yes' && curPay !== 'Yes') { row[idx['Payment for Entry']] = 'Yes'; changed++; }
    else if (from.pay === 'No' && !curPay)      { row[idx['Payment for Entry']] = 'No';  changed++; }

    // Time: merge CSV times
    const curTime = s(row[idx['Time']]);
    if (from.time) {
      const merged = mergeTimes(curTime, from.time);
      if (merged !== curTime) { row[idx['Time']] = merged; changed++; }
    }

    // Venue / Category: fill blanks only
    if (!row[idx['Venue']]    && from.venue) { row[idx['Venue']]    = from.venue; changed++; }
    if (!row[idx['Category']] && from.cat)   { row[idx['Category']] = from.cat;   changed++; }

    // _EndDate default to Date
    if (!row[idx['_EndDate']] && rowDateISO) { row[idx['_EndDate']] = rowDateISO; changed++; }
  }

  if (changed > 0) {
    sh.getRange(1, 1, values.length, headers.length).setValues(values);
  }
  Logger.log('materialize(): events=%s; rows_changed=%s; matches LD/TDV/TD=%s/%s/%s; url=%s',
             enriched.length, changed, hitLD, hitTDV, hitTD, url);

  // ==== helpers ====
  function s(v){ return (v == null) ? '' : String(v).trim(); }
  function need(h, names){ const pos={}; h.forEach((n,i)=>pos[n]=i); names.forEach(n=>{ if(!(n in pos)) throw new Error('Missing column: '+n); }); return pos; }

  function toISO(cell, tz){
    if (cell instanceof Date) return Utilities.formatDate(cell, tz, 'yyyy-MM-dd');
    const t = s(cell);
    return /^\d{4}-\d{2}-\d{2}$/.test(t) ? t : t;
  }

  // --- URL normalization: scheme-agnostic host+path, no query/hash, no trailing slash
  function canonUrl(u){
    u = s(u);
    try {
      const x = new URL(u);
      const host = x.hostname.toLowerCase();
      const path = x.pathname.replace(/\/+$/,'');
      return host + path;
    } catch {
      return u.replace(/^https?:\/\//i,'').replace(/\/+$/,'').toLowerCase();
    }
  }

  // payload keys (already ISO date)
  function keyLD_payload(link,date){ const L=canonUrl(link), D=s(date); return (L&&D)?(L+'|'+D):''; }
  function keyTDV_payload(title,date,venue){ const D=s(date), T=norm(title), V=norm(venue); return (D&&T)?(T+'|'+D+'|'+V):''; }
  function keyTD_payload(title,date){ const D=s(date), T=norm(title); return (D&&T)?(T+'|'+D):''; }

  // row keys (row date may be Date)
  function keyLD_row(link,dateISO){ const L=canonUrl(link), D=s(dateISO); return (L&&D)?(L+'|'+D):''; }
  function keyTDV_row(title,dateISO,venue){ const D=s(dateISO), T=norm(title), V=norm(venue); return (D&&T)?(T+'|'+D+'|'+V):''; }
  function keyTD_row(title,dateISO){ const D=s(dateISO), T=norm(title); return (D&&T)?(T+'|'+D):''; }

  function mergeTimes(a,b){
    const toArr = s => (s||'').split(',').map(x=>x.trim()).filter(Boolean);
    const set = new Set([...toArr(a), ...toArr(b)]);
    return Array.from(set).sort().join(', ');
  }
  function norm(str){
    str = s(str).toLowerCase();
    str = str.normalize('NFKD').replace(/[\u0300-\u036f]/g,'');
    str = str.replace(/[ł]/g,'l').replace(/[ś]/g,'s').replace(/[ć]/g,'c')
             .replace(/[źż]/g,'z').replace(/[ó]/g,'o').replace(/[ń]/g,'n')
             .replace(/[ą]/g,'a').replace(/[ę]/g,'e');
    return str.replace(/[^a-z0-9 ]/g,' ').replace(/\s+/g,' ').trim();
  }
}

/* util also used by refresh() */
function ensureSlash(u){ return u && !u.endsWith('/') ? (u + '/') : u; }
