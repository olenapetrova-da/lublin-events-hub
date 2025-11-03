/** refresh.gs — Hub → raw_events (list-only, one batch write) */
/** This writes one 7-day batch from the Hub into the raw_events sheet in a single write. 
 * Uses Hub JSON (no sheet rows from Hub).
 * Defaults _EndDate = Date when missing.
 * Minimal logging; single batch write.
*/
function refresh() {
  const p = PropertiesService.getScriptProperties().getProperties();
  const HUB = ensureSlash(p.HUB_URL || '');
  const SHEET_ID = p.SHEET_ID || '';
  const TZ = p.TZ || Session.getScriptTimeZone() || 'Europe/Warsaw';
  if (!HUB || !SHEET_ID) throw new Error('Missing HUB_URL or SHEET_ID in Script Properties');

  // Date (today in TZ)
  const dateISO = Utilities.formatDate(new Date(), TZ, 'yyyy-MM-dd');

  // Hub JSON call (ADR-0004): single 7-day window, JSON mode (sheet=0)
  const qs = 'period=week&days=7&group_times=1&pages=3&limit=1000&sheet=0';
  const url = `${HUB}?date=${encodeURIComponent(dateISO)}&${qs}`;

  const resp = UrlFetchApp.fetch(url, { headers: { 'Accept': 'application/json' }, muteHttpExceptions: true });
  const status = resp.getResponseCode();
  if (status !== 200) throw new Error(`Hub HTTP ${status}: ${resp.getContentText().slice(0, 300)}`);

  const data = JSON.parse(resp.getContentText() || '{}');
  const events = Array.isArray(data.events) ? data.events : [];

  // 9 columns (Image URL removed)
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

  // One batch write
  sh.clearContents();
  if (!sh.getMaxColumns || sh.getMaxColumns() < headers.length) {
    sh.insertColumnsAfter(sh.getMaxColumns(), headers.length - sh.getMaxColumns());
  }
  sh.getRange(1, 1, 1, headers.length).setValues([headers]);
  if (rows.length) sh.getRange(2, 1, rows.length, headers.length).setValues(rows);

  Logger.log('refresh(): date=%s url=%s count=%s', dateISO, url, rows.length);
}

/* utils */
function ensureSlash(u){ return u && !u.endsWith('/') ? (u + '/') : u; }
