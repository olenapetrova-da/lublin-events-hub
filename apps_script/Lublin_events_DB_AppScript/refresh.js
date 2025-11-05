/** CHANGELOG — 2025-11-05 (addendum #2)
 * - Log upgrade: append include_in_progress flag and a compact per_source summary to the log line
 *   (e.g., "per_source=zoom:58; lublin:51").  :contentReference[oaicite:2]{index=2}
 */

/** CHANGELOG — 2025-11-05 (addendum)
 * - Note: Zoom adapter now includes ongoing multi-day events from /w-trakcie by default.
 *         No parameter needed in refresh(); Hub forwards defaults (include_in_progress=1, inprog_pages=1).
 */

/** refresh.gs — Hub → raw_events (list-only, one batch write) */
/** This writes one 7-day batch from the Hub into the raw_events sheet in a single write. 
 * Uses Hub JSON (no sheet rows from Hub).
 * Defaults _EndDate = Date when missing.
 * Minimal logging; single batch write.
*/

/** CHANGELOG — 2025-11-05
 * - Force Date (B), Time (C) and _EndDate (I) to TEXT with setNumberFormat('@') to avoid auto date/time.
 */

function refresh() {
  const p = PropertiesService.getScriptProperties().getProperties();
  const HUB = ensureSlash(p.HUB_URL || '');
  const SHEET_ID = p.SHEET_ID || '';
  const TZ = p.TZ || Session.getScriptTimeZone() || 'Europe/Warsaw';
  if (!HUB || !SHEET_ID) throw new Error('Missing HUB_URL or SHEET_ID in Script Properties');

  const dateISO = Utilities.formatDate(new Date(), TZ, 'yyyy-MM-dd');

  const qs = 'period=week&days=7&group_times=1&pages=3&limit=1000&sheet=0';
  const url = `${HUB}?date=${encodeURIComponent(dateISO)}&${qs}`;

  const resp = UrlFetchApp.fetch(url, { headers: { 'Accept': 'application/json' }, muteHttpExceptions: true });
  const status = resp.getResponseCode();
  if (status !== 200) throw new Error(`Hub HTTP ${status}: ${resp.getContentText().slice(0, 300)}`);

  const data = JSON.parse(resp.getContentText() || '{}');
  const events = Array.isArray(data.events) ? data.events : [];

  const headers = ['Title','Date','Time','Venue','Category','Link','Payment for Entry','Source','_EndDate'];
  const rows = events.map(e => [
    e.Title || '',
    e.Date || '',
    e.Time || '',
    e.Venue || '',
    e.Category || '',
    e.Link || '',
    (e['Payment for Entry'] || ''),
    (e.Source || data.source || ''),
    (e._EndDate || e['End Date'] || e.Date || '')
  ]);

  const ss = SpreadsheetApp.openById(SHEET_ID);
  const sh = ss.getSheetByName('raw_events') || ss.insertSheet('raw_events');

  sh.clearContents();
  if (!sh.getMaxColumns || sh.getMaxColumns() < headers.length) {
    sh.insertColumnsAfter(sh.getMaxColumns(), headers.length - sh.getMaxColumns());
  }
  sh.getRange(1, 1, 1, headers.length).setValues([headers]);

  const n = Math.max(rows.length, 1);
  sh.getRange(2, 2, n, 1).setNumberFormat('@'); // B: Date
  sh.getRange(2, 3, n, 1).setNumberFormat('@'); // C: Time
  sh.getRange(2, 9, n, 1).setNumberFormat('@'); // I: _EndDate

  if (rows.length) sh.getRange(2, 1, rows.length, headers.length).setValues(rows);

  // --- New: richer log line with include_in_progress + per_source summary
  const inc = data && data.include_in_progress ? 1 : 0;
  const perSource = Array.isArray(data && data.per_source ? data.per_source : []) ? data.per_source : [];
  const perSummary = perSource.map(ps => {
    // normalize label
    let label = 'src';
    const s = String(ps.source || '');
    if (s.startsWith('[binding:L_ZOOM]') || /zoom/i.test(s)) label = 'zoom';
    else if (s.startsWith('[binding:L_OFFICIAL]') || /lublin\.eu|official/i.test(s)) label = 'lublin';
    else {
      try { label = (new URL(s)).hostname; } catch (e) { label = s; }
    }
    return `${label}:${ps.got}`;
  }).join('; ');

  Logger.log('refresh(): date=%s url=%s count=%s include_in_progress=%s per_source=%s',
             dateISO, url, rows.length, inc, perSummary);
}

/* utils */
function ensureSlash(u){ return u && !u.endsWith('/') ? (u + '/') : u; }
