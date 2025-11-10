/**
 * materialize(): raw_events -> events
 * - One pass, batch read & write
 * - Europe/Warsaw timezone, ISO 8601 with correct +01:00/+02:00 offsets
 * - Category mapping via taxonomy_map + taxonomy_alias
 * - Payment mapping Yes/No/Bezpłatny/Płatny -> paid/free/unknown
 * - event_id = sha1(source + '|' + normalize(title) + '|' + start_dt + '|' + normalize(venue))
 * - Unmapped category tokens upserted into taxonomy_unmapped with idempotent counts (max(existing, runCount))
 */
function materialize() {
  const TZ = 'Europe/Warsaw';

  const SS = SpreadsheetApp.getActive();
  const SH_RAW = SS.getSheetByName('raw_events');
  const SH_OUT = SS.getSheetByName('events');
  const SH_MAP = SS.getSheetByName('taxonomy_map');
  const SH_ALIAS = SS.getSheetByName('taxonomy_alias');
  const SH_UNMAPPED = SS.getSheetByName('taxonomy_unmapped');

  if (!SH_RAW || !SH_OUT || !SH_MAP || !SH_ALIAS || !SH_UNMAPPED) {
    throw new Error('Missing required sheets: raw_events, events, taxonomy_map, taxonomy_alias, taxonomy_unmapped');
  }

  // === Batch reads ===
  const raw = SH_RAW.getDataRange().getValues(); // [ [Title, Date, Time, Venue, Category, Link, Payment for Entry, Source, _EndDate], ... ]
  const mapVals = SH_MAP.getDataRange().getValues();        // [source, source_key, source_label, match_type, canonical]
  const aliasVals = SH_ALIAS.getDataRange().getValues();    // [alias, canonical]
  const unmappedVals = SH_UNMAPPED.getDataRange().getValues(); // [source, raw_label, count]

  if (raw.length <= 1) {
    // Clear events, keep header
    const header = ['event_id','title','start_dt','end_dt','venue','payment','categories','source','url'];
    SH_OUT.clearContents();
    SH_OUT.getRange(1,1,1,header.length).setValues([header]);
    Logger.log('materialize(): in=0 out=0 unmapped_seen=0');
    return;
  }

  // === Build taxonomy indices in memory ===
  const taxIndex = buildTaxonomyIndex(mapVals);   // per-source buckets: exact/contains/regex
  const aliasMap = buildAliasMap(aliasVals);      // aliasLower -> canonical

  // For unmapped logging: in-run counts keyed by (source + \u0001 + tokenKey)
  const runUnmapped = new Map();

  // === Transform rows ===
  const outRows = [];
  const headerOut = ['event_id','title','start_dt','end_dt','venue','payment','categories','source','url'];

  const rawRows = raw.slice(1); // skip header
  for (let i = 0; i < rawRows.length; i++) {
    const row = rawRows[i];
    if (!row || row.length < 9) continue;

    let [
      title,       // 0
      dateStr,     // 1 (YYYY-MM-DD)
      timeStr,     // 2
      venue,       // 3
      categoryStr, // 4
      link,        // 5
      payRaw,      // 6
      source,      // 7 (hostname)
      endDateStr   // 8 (YYYY-MM-DD) defaulted by refresh()
    ] = row;

    title = safeStr(title);
    dateStr = safeStr(dateStr);
    timeStr = safeStr(timeStr);
    venue = safeStr(venue);
    categoryStr = safeStr(categoryStr);
    link = safeStr(link);
    payRaw = safeStr(payRaw);
    source = safeStr(source);
    endDateStr = safeStr(endDateStr);

    if (!dateStr || !endDateStr) {
      // Shouldn’t happen post-refresh; skip defensively
      continue;
    }

    // Times analysis
    const tinfo = analyzeTimes(timeStr);
    const earliestHHmm = tinfo.earliestStart || '00:00';

    // start_dt
    const startISO = toISO(dateStr, earliestHHmm, TZ);

    // end_dt per rules:
    // - If Date == _EndDate AND exactly one range (no other values), use that range's end time
    // - Else cap to _EndDate 23:59
    let endISO;
    if (dateStr === endDateStr && !!tinfo.singleRangeEnd && tinfo.valueCount === 1) {
      endISO = toISO(endDateStr, tinfo.singleRangeEnd, TZ);
    } else {
      endISO = toISO(endDateStr, '23:59', TZ);
    }

    // payment mapping
    const payment = mapPayment(payRaw);

    // categories mapping
    const categories = mapCategories({
      source,
      rawCell: categoryStr,
      taxIndex,
      aliasMap,
      onUnmapped: (token) => incrRunUnmapped(runUnmapped, source, token)
    });

    // event_id
    const id = sha1Hex(
      [source, normalizeForId(title), startISO, normalizeForId(venue)].join('|')
    );

    outRows.push([id, title, startISO, endISO, trimCollapse(venue), payment, categories, source, link]);
  }

  // === Write events (overwrite) ===
  const dataOut = [headerOut, ...outRows];
  SH_OUT.clearContents();
  SH_OUT.getRange(1,1,dataOut.length, headerOut.length).setValues(dataOut);

  // === Upsert taxonomy_unmapped (idempotent: max(existing, runCount)) ===
  upsertUnmappedBulk(SH_UNMAPPED, unmappedVals, runUnmapped);

  Logger.log('materialize(): in=%s out=%s unmapped_seen=%s',
             rawRows.length, outRows.length, runUnmapped.size);
}

/* ---------------- Helpers ---------------- */

function safeStr(v) {
  return (v == null) ? '' : String(v).trim();
}

function trimCollapse(s) {
  return s.replace(/\s+/g, ' ').trim();
}

// Remove diacritics; collapse spaces; lowercase for stable IDs
function normalizeForId(s) {
  if (!s) return '';
  let out = s.normalize('NFD').replace(/[\u0300-\u036f]/g, '');
  // Handle characters that are not pure combining mark decompositions
  out = out.replace(/ł/g, 'l').replace(/Ł/g, 'L');
  out = out.replace(/ß/g, 'ss');
  return trimCollapse(out).toLowerCase();
}

// SHA1 hex
function sha1Hex(str) {
  const bytes = Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_1, str, Utilities.Charset.UTF_8);
  return bytes.map(function(b){ const v=(b<0?b+256:b); return (v<16?'0':'') + v.toString(16); }).join('');
}

// Europe/Warsaw ISO with correct offset
function toISO(yyyyMmDd, hhmm, tz) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(yyyyMmDd);
  if (!m) throw new Error('Bad date: ' + yyyyMmDd);
  const year = +m[1], mon = +m[2], day = +m[3];

  let h = 0, min = 0;
  if (hhmm && /^\d{1,2}:\d{2}$/.test(hhmm)) {
    const t = hhmm.split(':'); h = +t[0]; min = +t[1];
  }
  // Build as UTC then format in tz (ensures DST offset is correct)
  const d = new Date(Date.UTC(year, mon-1, day, h, min, 0));
  // 2025-11-08T10:00:00+0100
  const base = Utilities.formatDate(d, tz, "yyyy-MM-dd'T'HH:mm:ssZ");
  // Insert colon into offset
  return base.replace(/([+-]\d{2})(\d{2})$/, '$1:$2');
}

// Parse times cell:
// - tokens split by , ; |
// - token may be range "HH:mm–HH:mm" or single "HH:mm"
// Returns earliest start, endIfSingleRange (only when exactly one token and it's a range), and valueCount
function analyzeTimes(cell) {
  const res = { earliestStart: null, singleRangeEnd: null, valueCount: 0 };
  if (!cell) return res;

  const tokens = cell.split(/[,\|;]+/).map(s => s.trim()).filter(Boolean);
  let earliestMin = Number.POSITIVE_INFINITY;

  let rangeCount = 0;
  let totalValues = 0;
  let onlyRangeEnd = null;

  for (const tok of tokens) {
    // Ranges: HH:mm–HH:mm (accept -, –, — with optional spaces)
    const r = tok.match(/(\d{1,2}:\d{2})\s*[–—-]\s*(\d{1,2}:\d{2})/);
    if (r) {
      totalValues++;
      rangeCount++;
      const start = r[1], end = r[2];
      const mStart = toMinutes(start);
      if (mStart < earliestMin) { earliestMin = mStart; res.earliestStart = start; }
      onlyRangeEnd = end; // track last; will use only if exactly one value
      continue;
    }
    // Single time
    const s = tok.match(/(\d{1,2}:\d{2})/);
    if (s) {
      totalValues++;
      const start = s[1];
      const mStart = toMinutes(start);
      if (mStart < earliestMin) { earliestMin = mStart; res.earliestStart = start; }
      continue;
    }
  }

  res.valueCount = totalValues;
  if (totalValues === 1 && rangeCount === 1) {
    res.singleRangeEnd = onlyRangeEnd;
  }
  return res;
}

function toMinutes(hhmm) {
  const [h, m] = hhmm.split(':').map(Number);
  return h*60 + m;
}

// Payment mapping: Yes/No/Bezpłatny/Płatny -> paid/free/unknown
function mapPayment(v) {
  const s = safeStr(v).toLowerCase();
  if (!s) return 'unknown';
  if (s === 'yes' || s.indexOf('płat') >= 0) return 'paid';
  if (s === 'no' || s.indexOf('bezpłat') >= 0) return 'free';
  return 'unknown';
}

/**
 * Build taxonomy index from taxonomy_map sheet values.
 * Expected header: source | source_key | source_label | match_type | canonical
 */
function buildTaxonomyIndex(vals) {
  if (!vals || vals.length <= 1) return new Map();
  const hdr = vals[0].map(safeStr).map(s => s.toLowerCase());
  const idxSource = hdr.indexOf('source');
  const idxLabel  = hdr.indexOf('source_label');
  const idxType   = hdr.indexOf('match_type');
  const idxCanon  = hdr.indexOf('canonical');

  const index = new Map(); // source -> { exact: Map<labelLower, Set<canon>>, contains: [ [substrLower, canon] ], regex: [ [RegExp, canon] ] }

  for (let i = 1; i < vals.length; i++) {
    const r = vals[i];
    if (!r || r.length < hdr.length) continue;

    const source = safeStr(r[idxSource]) || '*';
    const label = safeStr(r[idxLabel]);
    const mtype = safeStr(r[idxType]).toLowerCase(); // exact|contains|regex
    const canon = safeStr(r[idxCanon]);
    if (!label || !mtype || !canon) continue;

    const bucket = getOrInitTaxBucket(index, source);
    const labelLower = label.toLowerCase();

    if (mtype === 'exact') {
      if (!bucket.exact.has(labelLower)) bucket.exact.set(labelLower, new Set());
      bucket.exact.get(labelLower).add(canon);
    } else if (mtype === 'contains') {
      bucket.contains.push([labelLower, canon]);
    } else if (mtype === 'regex') {
      const re = compileRegexSafe(label, 'i');
      if (re) bucket.regex.push([re, canon]);
    }
  }
  return index;
}

function getOrInitTaxBucket(map, source) {
  if (!map.has(source)) {
    map.set(source, { exact: new Map(), contains: [], regex: [] });
  }
  return map.get(source);
}

function compileRegexSafe(pattern, flags) {
  try { return new RegExp(pattern, flags || ''); } catch (e) { return null; }
}

function buildAliasMap(vals) {
  if (!vals || vals.length <= 1) return new Map();
  const hdr = vals[0].map(safeStr).map(s => s.toLowerCase());
  const iAlias = hdr.indexOf('alias');
  const iCanon = hdr.indexOf('canonical');

  const map = new Map();
  for (let i = 1; i < vals.length; i++) {
    const r = vals[i];
    if (!r || r.length < hdr.length) continue;
    const a = safeStr(r[iAlias]).toLowerCase();
    const c = safeStr(r[iCanon]);
    if (a && c) map.set(a, c);
  }
  return map;
}

/**
 * Category mapping:
 * - Split raw cell into tokens by , ; |
 * - Try per-source exact -> contains -> regex; also merge with '*' mappings
 * - Apply alias fallback (token -> canonical)
 * - Dedupe/sort; join with '|'
 * - If no hits at all → 'other'
 * - Report each unmapped token via onUnmapped(token)
 */
function mapCategories({ source, rawCell, taxIndex, aliasMap, onUnmapped }) {
  const tokens = splitTokens(rawCell);
  const hits = new Set();

  // Merge source-specific + wildcard buckets for lookup
  const srcBucket = taxIndex.get(source) || { exact: new Map(), contains: [], regex: [] };
  const starBucket = taxIndex.get('*') || { exact: new Map(), contains: [], regex: [] };

  for (const tok of tokens) {
    const tLower = tok.toLowerCase();
    let matched = false;

    // exact
    const exactSet1 = srcBucket.exact.get(tLower);
    const exactSet2 = starBucket.exact.get(tLower);
    if (exactSet1 || exactSet2) {
      if (exactSet1) exactSet1.forEach(c => hits.add(c));
      if (exactSet2) exactSet2.forEach(c => hits.add(c));
      matched = true;
    }

    // contains
    if (!matched) {
      for (const [substr, canon] of srcBucket.contains) {
        if (tLower.indexOf(substr) !== -1) { hits.add(canon); matched = true; }
      }
    }
    if (!matched) {
      for (const [substr, canon] of starBucket.contains) {
        if (tLower.indexOf(substr) !== -1) { hits.add(canon); matched = true; }
      }
    }

    // regex
    if (!matched) {
      for (const [re, canon] of srcBucket.regex) {
        if (re.test(tok)) { hits.add(canon); matched = true; break; }
      }
    }
    if (!matched) {
      for (const [re, canon] of starBucket.regex) {
        if (re.test(tok)) { hits.add(canon); matched = true; break; }
      }
    }

    // alias fallback
    if (!matched) {
      const aliasCanon = aliasMap.get(tLower);
      if (aliasCanon) {
        hits.add(aliasCanon);
        matched = true;
      }
    }

    if (!matched && onUnmapped && tok) {
      onUnmapped(tok);
    }
  }

  if (hits.size === 0) return 'other';

  // Apply alias normalization on resulting canonicals too (in case canonicals have synonyms)
  const final = Array.from(hits).map(c => aliasMap.get(c.toLowerCase()) || c);

  // stable output
  final.sort((a,b) => a.localeCompare(b));
  return final.join('|');
}

function splitTokens(cell) {
  if (!cell) return [];
  return cell
    .split(/[,\|;]+/)
    .map(s => s.trim())
    .filter(Boolean);
}

// Track unmapped in-run counts
function incrRunUnmapped(map, source, label) {
  const key = unmappedKey(source, label);
  map.set(key, (map.get(key) || 0) + 1);
}

function unmappedKey(source, label) {
  return source + '\u0001' + normalizeForId(label); // normalized for stable key, keeps display separately
}

/**
 * Upsert taxonomy_unmapped in one write:
 * - existing: [source, raw_label, count]
 * - runUnmapped: Map(key -> countThisRun)
 * - policy: count := max(existing, countThisRun)
 * - keep the first seen display label for a key
 */
function upsertUnmappedBulk(sheet, existingVals, runUnmapped) {
  // Build existing index
  const rows = (existingVals && existingVals.length > 0) ? existingVals : [['source','raw_label','count']];
  const hasHeader = rows.length > 0;
  const startIdx = hasHeader ? 1 : 0;

  const existingByKey = new Map(); // key -> {rowIndex, displaySource, displayLabel, count}
  for (let i = startIdx; i < rows.length; i++) {
    const r = rows[i];
    if (!r || r.length < 3) continue;
    const source = safeStr(r[0]);
    const label = safeStr(r[1]);
    const count = Number(r[2] || 0);
    if (!source || !label) continue;

    const key = unmappedKey(source, label);
    if (!existingByKey.has(key)) {
      existingByKey.set(key, { source, label, count });
    } else {
      // If duplicates exist, keep max count
      const prev = existingByKey.get(key);
      if (count > prev.count) prev.count = count;
    }
  }

  // Merge run counts
  for (const [key, runCount] of runUnmapped.entries()) {
    if (!existingByKey.has(key)) {
      // Recover source & a display label from key
      const parts = key.split('\u0001');
      const source = parts[0];
      // We don't have the original case; store normalized label as display (good enough for log)
      const normLabel = parts[1];
      existingByKey.set(key, { source, label: normLabel, count: runCount });
    } else {
      const entry = existingByKey.get(key);
      entry.count = Math.max(entry.count, runCount);
    }
  }

  // Emit rows sorted by source then label
  const outRows = Array.from(existingByKey.values())
    .sort((a,b) => (a.source.localeCompare(b.source) || a.label.localeCompare(b.label)))
    .map(e => [e.source, e.label, e.count]);

  const header = ['source','raw_label','count'];
  sheet.clearContents();
  sheet.getRange(1,1,1,header.length).setValues([header]);
  if (outRows.length > 0) {
    sheet.getRange(2,1,outRows.length, header.length).setValues(outRows);
  }
}
