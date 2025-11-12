/**
 * OPS-TR1 — Daily automation (refresh → materialize + alerting)
 * Globals exposed: runDaily, setupDailyTrigger, removeAllTriggers
 * Script Properties: SHEET_ID, TZ="Europe/Warsaw", ALERT_EMAIL (optional)
 */
/**
 * OPS-TR1 — Daily automation (refresh → materialize)
 * --------------------------------------------------
 * Purpose
 *   Run the daily pipeline in Apps Script with a single time-based trigger.
 *   Sequence: refresh() → materialize(), then log + health row, alert on failure.
 *
 * Entry points
 *   - runDaily(): main job. Acquires a script lock (20s), runs refresh/materialize,
 *                 logs one summary line, appends a health record, sends alert on error/lock-skip.
 *   - setupDailyTrigger(hourLocal = 7, minuteLocal = 5): create one daily trigger (Europe/Warsaw).
 *   - removeAllTriggers(): remove all triggers for this project (use to reschedule/clean duplicates).
 *
 * Script Properties (required)
 *   - SHEET_ID         : Google Sheet ID (staging/normalized/health live here)
 *   - TZ               : IANA TZ, e.g. "Europe/Warsaw"
 *   - ALERT_EMAIL      : (optional) email address for error notifications
 *
 * Health sheet
 *   - Tab name: "ops_health"
 *   - Columns (appended per run): 
 *       date_utc (ISO), ran_at_warsaw (HH:mm:ss), ok (TRUE/FALSE), 
 *       raw_rows (int), events_rows (int), elapsed_ms (int), error (string, truncated)
 *   - If missing, the tab is created with header row.
 *
 * Logging (execution log)
 *   OPS runDaily: ok=<true|false> raw=<n> events=<n> ms=<elapsed> at=<YYYY-MM-DD HH:MM Europe/Warsaw>
 *
 * Staleness helpers (optional, in ops_health)
 *   H1: last_ok
 *   H2: =MAX(ARRAYFORMULA(IF(C2:C=TRUE, DATEVALUE(LEFT(A2:A,10))+TIMEVALUE(MID(A2:A,12,8)), )))
 *   I1: fresh_<24h
 *   I2: =IF((NOW()-H2)*24<24, TRUE, FALSE)
 *
 * Error handling
 *   - Lock conflict: job is skipped; alert email is sent (if ALERT_EMAIL set).
 *   - Any exception in refresh()/materialize(): alert email + health row with ok=FALSE + error text.
 *
 * Idempotency / safety
 *   - One batch read/write per step; no per-row network calls here.
 *   - Safe to re-run manually; lock prevents overlap with scheduled run.
 *
 * Typical usage
 *   // one-time setup (clean + schedule at 07:05 Warsaw)
 *   removeAllTriggers();
 *   setupDailyTrigger(7, 5);
 *
 *   // manual test run
 *   runDaily();
 *
 * Version note
 *   Matches pipeline as of v0.3.0-rc.3 (Query API live). Daily job feeds doGet() with fresh data.
 */


const HEALTH_SHEET_NAME = 'ops_health';
const DEFAULT_TZ = 'Europe/Warsaw';

/** Entry point for time trigger */
function runDaily() {
  const tz = opsGetTZ();
  const t0 = Date.now();
  let ok = false;
  let errMsg = '';
  let rawRows = -1;
  let eventsRows = -1;

  const lock = LockService.getScriptLock();
  try {
    lock.waitLock(20 * 1000);
  } catch (e) {
    errMsg = 'Locked: another run in progress';
    opsSendAlert('OPS runDaily: skipped (locked)', [
      `When: ${opsFmtTZ(new Date(), tz, 'yyyy-MM-dd HH:mm:ss')} ${tz}`,
      `Reason: ${errMsg}`,
    ].join('\n'));
    opsAppendHealth({ ok: false, rawRows: opsSafeCount('raw_events'), eventsRows: opsSafeCount('events'), elapsedMs: Date.now() - t0, errMsg });
    opsLogSummary(false, opsSafeCount('raw_events'), opsSafeCount('events'), Date.now() - t0, tz);
    return;
  }

  try {
    refresh();      // fills raw_events
    materialize();  // writes events
    ok = true;
  } catch (e) {
    ok = false;
    errMsg = (e && e.stack) ? String(e.stack) : String(e);
    opsSendAlert('OPS runDaily: FAILED', [
      `When: ${opsFmtTZ(new Date(), tz, 'yyyy-MM-dd HH:mm:ss')} ${tz}`,
      `Error: ${errMsg}`
    ].join('\n'));
  } finally {
    rawRows = opsSafeCount('raw_events');
    eventsRows = opsSafeCount('events');
    const elapsedMs = Date.now() - t0;

    opsAppendHealth({ ok, rawRows, eventsRows, elapsedMs, errMsg });
    opsLogSummary(ok, rawRows, eventsRows, elapsedMs, tz);

    try { lock.releaseLock(); } catch (_) {}
  }
}

/** Create one daily trigger in Europe/Warsaw, default 07:05 */
function setupDailyTrigger(hourLocal = 7, minuteLocal = 5) {
  ScriptApp.newTrigger('runDaily')
    .timeBased()
    .everyDays(1)
    .atHour(Number(hourLocal))
    .nearMinute(Number(minuteLocal))
    .inTimezone(opsGetTZ())
    .create();
}

/** Remove all triggers (use to avoid duplicates) */
function removeAllTriggers() {
  ScriptApp.getProjectTriggers().forEach(t => ScriptApp.deleteTrigger(t));
}

/* -------------------- Helpers (prefixed to avoid collisions) -------------------- */

function opsGetSpreadsheet() {
  const sheetId = opsGetProp('SHEET_ID');
  if (sheetId) return SpreadsheetApp.openById(sheetId);
  return SpreadsheetApp.getActiveSpreadsheet();
}

function opsGetProp(key) {
  return (PropertiesService.getScriptProperties().getProperty(key) || '').trim();
}

function opsGetTZ() {
  return opsGetProp('TZ') || DEFAULT_TZ;
}

function opsFmtTZ(date, tz, fmt) {
  return Utilities.formatDate(date, tz, fmt);
}

function opsGetSheetByName(name) {
  return opsGetSpreadsheet().getSheetByName(name);
}

function opsSafeCount(sheetName) {
  const sh = opsGetSheetByName(sheetName);
  if (!sh) return 0;
  const lr = sh.getLastRow();
  return Math.max(0, lr - 1); // assume header
}

function opsLogSummary(ok, rawRows, eventsRows, elapsedMs, tz) {
  const at = opsFmtTZ(new Date(), tz, 'yyyy-MM-dd HH:mm');
  const line = `OPS runDaily: ok=${ok} raw=${rawRows} events=${eventsRows} ms=${elapsedMs} at=${at} ${tz}`;
  console.log(line);
  Logger.log(line);
}

function opsEscapeHtml(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function opsAppendHealth({ ok, rawRows, eventsRows, elapsedMs, errMsg }) {
  const ss = opsGetSpreadsheet();
  let sh = ss.getSheetByName(HEALTH_SHEET_NAME);
  if (!sh) {
    sh = ss.insertSheet(HEALTH_SHEET_NAME);
    sh.appendRow(['date_utc', 'ran_at_warsaw', 'ok', 'raw_rows', 'events_rows', 'elapsed_ms', 'error']);
  }
  if (sh.getLastRow() === 0) {
    sh.appendRow(['date_utc', 'ran_at_warsaw', 'ok', 'raw_rows', 'events_rows', 'elapsed_ms', 'error']);
  }

  const now = new Date();
  const tz = opsGetTZ();

  sh.appendRow([
    now.toISOString(),
    opsFmtTZ(now, tz, 'yyyy-MM-dd HH:mm:ss'),
    Boolean(ok),
    Number(rawRows),
    Number(eventsRows),
    Number(elapsedMs),
    errMsg ? String(errMsg).slice(0, 5000) : ''
  ]);
}

function opsSendAlert(subject, body) {
  const to = opsGetProp('ALERT_EMAIL');
  if (!to) return;
  try {
    MailApp.sendEmail({
      to,
      subject,
      htmlBody: `<pre style="font-family:monospace">${opsEscapeHtml(body)}</pre>`,
      name: 'Lublin Events OPS'
    });
  } catch (e) {
    console.log(`OPS alert send failed: ${e}`);
  }
}
