/**
 * Lublin Events — Query API (doGet)
 *
 * Reads normalized `events` for logic (start_dt/end_dt, payment, categories, source, url),
 * joins display `times` from `raw_events` by (Source, Link, Date),
 * filters/sorts/paginates, and returns a stable JSON contract.
 *
 * Script Properties required:
 *  - SHEET_ID : Spreadsheet ID
 *  - TZ       : e.g., "Europe/Warsaw"
 *  - ALERT_EMAIL (optional)
 */

/** ENTRY */
function doGet(e) {
  const started = Date.now();
  try {
    const props = PropertiesService.getScriptProperties();
    const TZ = props.getProperty('TZ') || 'Europe/Warsaw';
    const SHEET_ID = props.getProperty('SHEET_ID');
    if (!SHEET_ID) return json({ ok: false, error: 'Missing SHEET_ID script property' }, 500);

    const p = parseParams(e, TZ);
    if (!p.ok) return json({ ok: false, error: p.error }, 400);

    const { winStart, winEnd, payment, categoriesReq, sourcesReq, limit, offset } = p;

    // Load once
    const { events, colmap } = loadEvents(SHEET_ID);
    const timesIdx = loadTimesIndex(SHEET_ID, TZ); // key: `${source}|${url}|${dateISO}` -> "09:00, 11:00"

    // Pre-compute mapped request categories (alias -> canonical)
    const requestedCanon = mapAliases(SHEET_ID, categoriesReq); // Set<string> (lowercased)
    const requestHasCategory = requestedCanon.size > 0;

    // Filter (date overlap first, then by payment/category/source)
    const filtered = [];
    for (const ev of events) {
      // Overlap rule on date parts only
      if (ev.end_date < winStart || ev.start_date > winEnd) continue;

      // Category filter (if requested)
      if (requestHasCategory) {
        if (!ev.categories || typeof ev.categories !== 'string') continue;
        const evCats = ev.categories.split('|').map(s => (s || '').trim().toLowerCase()).filter(Boolean);
        let hit = false;
        for (const c of requestedCanon) {
          if (evCats.includes(c)) { hit = true; break; }
        }
        if (!hit) continue;
      }

      // Payment filter
      if (payment !== 'any') {
        const pay = (ev.payment || '').toLowerCase();
        if (pay !== payment) continue;
      }

      // Source filter
      if (sourcesReq.length) {
        if (!sourcesReq.includes(ev.source)) continue; // exact match on hostname token
      }

      // Compute display date (earliest date inside window, not expanding multi-day)
      const displayDate = ev.start_date < winStart ? winStart : ev.start_date;

      // Join display times from raw_events by (Source, Link, Date)
      const timesKey = `${ev.source}|${ev.url}|${displayDate}`;
      const times = timesIdx.get(timesKey) || '';

      filtered.push({
        _sort: {
          date: displayDate,
          timed: ev.timed ? 0 : 1,            // 0 (timed first), 1 (untimed)
          timeHHMM: ev.timeHHMM || '99:99',
          titleKey: (ev.title || '').toString().toLocaleLowerCase('pl')
        },
        date: displayDate,
        title: ev.title || '',
        times,
        payment: (ev.payment || 'unknown'),
        categories: (ev.categories || ''),
        venue: (ev.venue || ''),
        source: (ev.source || ''),
        url: (ev.url || ''),
        event_id: ev.event_id || '',
        start_dt: ev.start_dt || '',
        end_dt: ev.end_dt || ''
      });
    }

    // Sort per ADR-0011:
    // date asc → timed first → earliest time asc → title asc
    filtered.sort(sortPerADR0011);

    const total = filtered.length;
    const page = filtered.slice(offset, Math.min(offset + limit, total));
    const next_offset = (offset + limit < total) ? (offset + limit) : null;

    const payload = {
      ok: true,
      start: winStart,
      end: winEnd,
      total,
      limit,
      offset,
      next_offset,
      results: page.map(x => ({
        date: x.date,
        title: x.title,
        times: x.times,
        payment: x.payment,
        categories: x.categories,
        venue: x.venue,
        source: x.source,
        url: x.url,
        event_id: x.event_id,
        start_dt: x.start_dt,
        end_dt: x.end_dt
      }))
    };

    // Log succinct request summary
    console.log(
      `doGet window=${winStart}..${winEnd}, pay=${payment}, ` +
      `cat=[${[...requestedCanon].join(',')}], src=[${sourcesReq.join(',')}], ` +
      `total=${total}, page=${limit}/${offset}, ms=${Date.now() - started}`
    );

    return json(payload, 200);

  } catch (err) {
    const msg = (err && err.stack) ? err.stack : String(err);
    console.error(`doGet error: ${msg}`);
    try { sendAlert(msg); } catch(_) {}
    return json({ ok: false, error: 'Internal error' }, 500);
  }
}

/** ---------- Helpers ---------- */

/**
 * Parse query parameters, validate, and compute window.
 */
function parseParams(e, TZ) {
  const q = (e && e.parameter) ? e.parameter : {};
  const period = (q.period || 'day').toLowerCase();
  const payment = (q.payment || 'any').toLowerCase();
  const limit = clampInt(q.limit, 20, 1, 100);
  const offset = clampInt(q.offset, 0, 0, 1e9);

  // source filter (comma list)
  const sourcesReq = (q.source || '')
    .split(',')
    .map(s => s.trim())
    .filter(Boolean);

  // category filter (comma list; alias → canonical later)
  const categoriesReq = (q.category || '')
    .split(',')
    .map(s => s.trim())
    .filter(Boolean);

  // explicit window
  const hasStart = isISODate(q.start);
  const hasEnd = isISODate(q.end);
  const hasDate = isISODate(q.date);

  if ((hasStart && !hasEnd) || (!hasStart && hasEnd)) {
    return { ok: false, error: 'Provide both start and end, or use date/period' };
  }

  let winStart = null, winEnd = null;

  if (hasStart && hasEnd) {
    winStart = q.start;
    winEnd = q.end;
  } else {
    if (!hasDate) return { ok: false, error: 'Missing required date (YYYY-MM-DD)' };
    const date = q.date;

    if (period === 'day') {
      winStart = date;
      winEnd = date;
    } else if (period === 'week') {
      winStart = date;
      winEnd = addDaysISO(date, 6);
    } else if (period === 'weekend') {
      const wknd = weekendWindow(date);
      winStart = wknd.start;
      winEnd = wknd.end;
    } else if (period === 'range') {
      // days only used if period=range and no explicit start/end
      const days = clampInt(q.days, 1, 1, 366);
      winStart = date;
      winEnd = addDaysISO(date, Math.max(0, days - 1));
    } else {
      return { ok: false, error: 'Invalid period (day|week|weekend|range)' };
    }
  }

  if (winStart > winEnd) return { ok: false, error: 'start > end' };

  // payment enum
  if (!['any', 'free', 'paid', 'unknown'].includes(payment)) {
    return { ok: false, error: 'Invalid payment (any|free|paid|unknown)' };
  }

  return {
    ok: true,
    winStart,
    winEnd,
    payment,
    categoriesReq,
    sourcesReq,
    limit,
    offset,
    TZ
  };
}

/**
 * Compute weekend window (Saturday–Sunday) for the week whose weekend contains `date`.
 * For Sun → take previous Sat; for Mon–Fri → upcoming Sat/Sun; for Sat → that Sat/Sun.
 */
function weekendWindow(dateISO) {
  const d = parseISOAsUTC(dateISO); // Date in UTC (00:00)
  const dow = d.getUTCDay(); // 0..6 (Sun..Sat)
  const satOffset = (dow === 0) ? -1 : (6 - dow);
  const sunOffset = satOffset + 1;
  const sat = addDays(dateISO, satOffset);
  const sun = addDays(dateISO, sunOffset);
  return { start: toISODate(sat), end: toISODate(sun) };
}

/**
 * Load `events` sheet rows into lightweight objects.
 * Schema (9 cols): event_id | title | start_dt | end_dt | venue | payment | categories | source | url
 */
function loadEvents(SHEET_ID) {
  const ss = SpreadsheetApp.openById(SHEET_ID);
  const sh = ss.getSheetByName('events');
  if (!sh) throw new Error('Missing sheet: events');

  const values = sh.getDataRange().getValues(); // 2D array
  if (values.length < 2) return { events: [], colmap: {} };

  const header = values[0].map(String);
  const idx = {};
  header.forEach((h, i) => idx[h] = i);

  const get = (row, name) => row[idx[name]];

  const out = [];
  for (let r = 1; r < values.length; r++) {
    const row = values[r];

    const start_dt = String(get(row, 'start_dt') || '');
    const end_dt   = String(get(row, 'end_dt') || '');

    const start_date = (start_dt.split('T')[0] || '');
    const end_date   = (end_dt.split('T')[0] || '');

    // Timed if start time is not 00:00:00
    const timePart = (start_dt.split('T')[1] || '').substring(0, 8); // HH:MM:SS
    const timed = !!timePart && timePart !== '00:00:00';
    const timeHHMM = (timePart || '').substring(0, 5); // HH:MM

    out.push({
      event_id: String(get(row, 'event_id') || ''),
      title:    String(get(row, 'title') || ''),
      start_dt,
      end_dt,
      start_date,
      end_date,
      venue:    String(get(row, 'venue') || ''),
      payment:  String(get(row, 'payment') || 'unknown').toLowerCase(),
      categories: String(get(row, 'categories') || ''), // pipe-joined canonical
      source:   String(get(row, 'source') || ''),
      url:      String(get(row, 'url') || ''),
      timed,
      timeHHMM
    });
  }

  return { events: out, colmap: idx };
}

/**
 * Build times index from `raw_events` by (Source, Link, Date) → comma string.
 * Schema (9 cols): Title | Date | Time | Venue | Category | Link | Payment for Entry | Source | _EndDate
 */
function loadTimesIndex(SHEET_ID, TZ) {
  const ss = SpreadsheetApp.openById(SHEET_ID);
  const sh = ss.getSheetByName('raw_events');
  const idx = new Map();
  if (!sh) return idx;

  const values = sh.getDataRange().getValues();
  if (values.length < 2) return idx;

  const header = values[0].map(String);
  const col = {};
  header.forEach((h, i) => col[h] = i);

  const get = (row, name) => row[col[name]];

  for (let r = 1; r < values.length; r++) {
    const row = values[r];

    let dateVal = get(row, 'Date');
    const dateISO = toISODate(dateVal, TZ); // tolerate Date objects / strings

    const source = String(get(row, 'Source') || '').trim();
    const link   = String(get(row, 'Link') || '').trim();
    const times  = String(get(row, 'Time') || '').trim();

    if (!source || !link || !dateISO) continue;

    const key = `${source}|${link}|${dateISO}`;
    if (!idx.has(key)) {
      idx.set(key, times);
    } else {
      // merge unique times if duplicates appear
      const prev = idx.get(key) || '';
      const merged = mergeCommaValues(prev, times);
      idx.set(key, merged);
    }
  }
  return idx;
}

/**
 * Map request category aliases → canonical using `taxonomy_alias` (alias, canonical).
 * Returns Set<string> of canonical (lowercased).
 */
function mapAliases(SHEET_ID, reqList) {
  const canon = new Set();
  if (!reqList || !reqList.length) return canon;

  const ss = SpreadsheetApp.openById(SHEET_ID);
  const sh = ss.getSheetByName('taxonomy_alias');
  const aliasMap = new Map(); // alias(lower) -> canonical(lower)

  if (sh) {
    const values = sh.getDataRange().getValues();
    if (values.length >= 2) {
      for (let r = 1; r < values.length; r++) {
        const alias = String(values[r][0] || '').trim().toLowerCase();
        const canonical = String(values[r][1] || '').trim().toLowerCase();
        if (alias && canonical) aliasMap.set(alias, canonical);
      }
    }
  }

  for (const item of reqList) {
    const a = item.trim().toLowerCase();
    const mapped = aliasMap.get(a) || a;
    canon.add(mapped);
  }
  return canon;
}

/** Sorting comparator: date asc → timed first → earliest time asc → title asc (pl, case-insensitive) */
function sortPerADR0011(a, b) {
  if (a._sort.date !== b._sort.date) return a._sort.date < b._sort.date ? -1 : 1;
  if (a._sort.timed !== b._sort.timed) return a._sort.timed - b._sort.timed; // 0 before 1
  if (a._sort.timeHHMM !== b._sort.timeHHMM) return a._sort.timeHHMM < b._sort.timeHHMM ? -1 : 1;
  return a._sort.titleKey.localeCompare(b._sort.titleKey, 'pl', { sensitivity: 'base' });
}

/** JSON response with CORS and status (best-effort; Apps Script doesn’t expose headers in all modes). */
function json(obj, statusCode) {
  const text = JSON.stringify(obj);
  const out = ContentService.createTextOutput(text).setMimeType(ContentService.MimeType.JSON);

  // Best-effort CORS (ignored by Apps Script if unsupported)
  try {
    if (typeof out.setHeader === 'function') out.setHeader('Access-Control-Allow-Origin', '*');
    if (typeof out.setHeader === 'function') out.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
    if (typeof out.setHeader === 'function') out.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    if (typeof out.setStatusCode === 'function') out.setStatusCode(statusCode || 200);
  } catch (_) { /* ignore */ }

  return out;
}

/** Send alert email if ALERT_EMAIL set */
function sendAlert(message) {
  const props = PropertiesService.getScriptProperties();
  const to = props.getProperty('ALERT_EMAIL');
  if (!to) return;
  const subject = 'Lublin Events API alert';
  const body = `[${new Date().toISOString()}]\n\n${message}`;
  MailApp.sendEmail(to, subject, body);
}

/** ---------- Small utils ---------- */

function clampInt(v, def, min, max) {
  const n = parseInt(v, 10);
  if (isNaN(n)) return def;
  return Math.max(min, Math.min(max, n));
}

function isISODate(s) {
  return typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s);
}

function addDaysISO(dateISO, days) {
  return toISODate(addDays(dateISO, days));
}

function addDays(dateISO, days) {
  const d = parseISOAsUTC(dateISO);
  d.setUTCDate(d.getUTCDate() + Number(days || 0));
  return d;
}

function parseISOAsUTC(dateISO) {
  // parse as UTC midnight to avoid DST surprises
  return new Date(dateISO + 'T00:00:00Z');
}

function toISODate(value, TZ) {
  if (!value && value !== 0) return '';
  if (Object.prototype.toString.call(value) === '[object Date]') {
    // Apps Script Date object
    const tz = TZ || (PropertiesService.getScriptProperties().getProperty('TZ') || 'Europe/Warsaw');
    return Utilities.formatDate(value, tz, 'yyyy-MM-dd');
  }
  const s = String(value).trim();
  if (isISODate(s)) return s;
  // Try to parse common cases
  const d = new Date(s);
  if (!isNaN(d.getTime())) {
    const tz = TZ || (PropertiesService.getScriptProperties().getProperty('TZ') || 'Europe/Warsaw');
    return Utilities.formatDate(d, tz, 'yyyy-MM-dd');
  }
  return '';
}

function mergeCommaValues(a, b) {
  const set = new Set();
  for (const part of String(a || '').split(',').map(x => x.trim()).filter(Boolean)) set.add(part);
  for (const part of String(b || '').split(',').map(x => x.trim()).filter(Boolean)) set.add(part);
  return [...set].join(', ');
}
