// ============================================================
// PipelineSummary.js
// Builds a live funnel dashboard in PIPELINE_SUMMARY sheet.
// Shows aggregate counts at every gate — no per-company rows.
//
// Auto-called every N companies during pipeline runs and at
// every clean exit (time limit, circuit breaker, completion).
// Also available as a menu item for on-demand refresh.
//
// Public surface:
//   buildPipelineSummary()   menu item + internal call
// ============================================================

function buildPipelineSummary() {
  try {
    var ss = SpreadsheetApp.getActiveSpreadsheet();

    // ── 1. MASTER — initial dataset size ───────────────────
    var masterSheet    = ss.getSheetByName(SHEETS.MASTER);
    var initialDataset = (masterSheet && masterSheet.getLastRow() > 1)
      ? masterSheet.getLastRow() - 1
      : 0;

    // ── 2. STAGE1_RESULTS — gate-level counts ──────────────
    var s1Sheet = ss.getSheetByName(SHEETS.STAGE1);
    var s1Rows  = (s1Sheet && s1Sheet.getLastRow() > 1)
      ? s1Sheet.getRange(2, 1, s1Sheet.getLastRow() - 1, 11).getValues()
      : [];

    var processed = s1Rows.length;
    var g1Pass = 0, g2Pass = 0, g3Pass = 0;
    var manualReview = 0, failed = 0, errors = 0, pendingRev = 0;

    s1Rows.forEach(function(row) {
      var mfr    = String(row[3] || '').trim();
      var acq    = String(row[4] || '').trim();
      var status = String(row[9] || '').trim();
      if (mfr === 'YES')                    g1Pass++;
      if (mfr === 'YES' && acq === 'NO')    g2Pass++;
      if      (status === 'PASS')           g3Pass++;
      else if (status === 'MANUAL_REVIEW')  manualReview++;
      else if (status === 'FAIL')           failed++;
      else if (status === 'ERROR')          errors++;
      else if (status === 'PENDING_REVENUE') pendingRev++;
    });

    // ── 3. SCORES — band counts ────────────────────────────
    var scSheet   = ss.getSheetByName(SHEETS.SCORES);
    var scRows    = (scSheet && scSheet.getLastRow() > 1)
      ? scSheet.getRange(2, 1, scSheet.getLastRow() - 1, 20).getValues()
      : [];

    var bandA = 0, bandB = 0, bandC = 0, bandD = 0;
    scRows.forEach(function(row) {
      var band = String(row[19] || '').trim();
      if      (band === 'A') bandA++;
      else if (band === 'B') bandB++;
      else if (band === 'C') bandC++;
      else if (band === 'D') bandD++;
    });

    var scored          = bandA + bandB + bandC + bandD;
    var pendingScoring  = Math.max(0, g3Pass - scored);
    var yieldPct        = initialDataset > 0
      ? Math.round((bandA + bandB) / initialDataset * 1000) / 10  // 1 decimal
      : 0;

    // ── 4. Get or create PIPELINE_SUMMARY sheet ────────────
    var sheet = ss.getSheetByName(CONFIG.PIPELINE_SUMMARY.SHEET_NAME);
    if (!sheet) {
      sheet = ss.insertSheet(CONFIG.PIPELINE_SUMMARY.SHEET_NAME);
    } else {
      sheet.clearContents();
      sheet.clearFormats();
    }

    // ── 5. Write dashboard ─────────────────────────────────
    var r  = 1;
    var ts = Utilities.formatDate(new Date(), Session.getScriptTimeZone(), 'dd MMM yyyy, HH:mm');

    // Title
    sheet.getRange(r, 1).setValue('ICP PIPELINE — FUNNEL SUMMARY')
      .setFontWeight('bold').setFontSize(14);
    sheet.getRange(r, 3).setValue('Updated: ' + ts)
      .setFontColor('#888888').setFontSize(10).setHorizontalAlignment('right');
    r += 2;

    // ── STAGE 1 ─────────────────────────────────────────────
    r = psFunnelHdr_(sheet, r, 'STAGE 1 — SCREENING');
    r = psDataRow_(sheet, r, 'Initial Dataset',          initialDataset, '');
    r = psDataRow_(sheet, r, 'Processed',                processed,      psFmt_(processed,   initialDataset));
    r = psDataRow_(sheet, r, 'Not yet processed',        initialDataset - processed,
                                                         psFmt_(initialDataset - processed, initialDataset));
    r++; // blank
    r = psDataRow_(sheet, r, '  Gate 1 — Manufacturer Pass', g1Pass,  psFmt_(g1Pass, processed));
    r = psDataRow_(sheet, r, '  Gate 2 — Not Acquired',      g2Pass,  psFmt_(g2Pass, g1Pass));
    r = psDataRow_(sheet, r, '  Gate 3 — Revenue PASS',      g3Pass,  psFmt_(g3Pass, g2Pass));
    r++;
    r = psDataRow_(sheet, r, '  Manual Review',              manualReview, psFmt_(manualReview, processed));
    r = psDataRow_(sheet, r, '  Failed',                     failed,       psFmt_(failed,       processed));
    if (errors > 0)     r = psDataRow_(sheet, r, '  Errors',                    errors,    psFmt_(errors,    processed));
    if (pendingRev > 0) r = psDataRow_(sheet, r, '  Pending Revenue Resolution', pendingRev, psFmt_(pendingRev, processed));
    r++;

    // ── FINAL SCORING ───────────────────────────────────────
    r = psFunnelHdr_(sheet, r, 'FINAL SCORING');
    r = psDataRow_(sheet, r, 'Input (Stage 1 PASS)',     g3Pass,  '');
    r = psDataRow_(sheet, r, 'Scored',                   scored,  psFmt_(scored, g3Pass));
    r++;
    r = psDataRow_(sheet, r, '  Band A — Strong Federer',  bandA, psFmt_(bandA, scored));
    r = psDataRow_(sheet, r, '  Band B — Probable Federer', bandB, psFmt_(bandB, scored));
    r = psDataRow_(sheet, r, '  Band C — Borderline',       bandC, psFmt_(bandC, scored));
    r = psDataRow_(sheet, r, '  Band D — Not ICP',          bandD, psFmt_(bandD, scored));
    r++;
    r = psDataRow_(sheet, r, '  Manual Review (pending your decision)', manualReview, '');
    r = psDataRow_(sheet, r, '  Pending Scoring',            pendingScoring, psFmt_(pendingScoring, g3Pass));
    r++;

    // ── PIPELINE YIELD ──────────────────────────────────────
    r = psFunnelHdr_(sheet, r, 'PIPELINE YIELD');
    r = psDataRow_(sheet, r, 'Band A + Band B',  bandA + bandB, '');
    r = psDataRow_(sheet, r, 'Initial Dataset',  initialDataset, '');
    // Yield — highlighted, large, prominent
    var yieldLabel = 'Yield  (' + (bandA + bandB) + ' / ' + initialDataset + ')';
    var yieldValue = initialDataset > 0 ? yieldPct + '%' : '—';
    sheet.getRange(r, 1).setValue(yieldLabel).setFontWeight('bold');
    sheet.getRange(r, 2).setValue(yieldValue).setFontWeight('bold').setFontSize(18)
      .setHorizontalAlignment('left').setFontColor('#1565c0');
    sheet.getRange(r, 1, 1, 3).setBackground('#fff9c4');
    r++;

    // ── Column widths ───────────────────────────────────────
    sheet.setColumnWidth(1, 270);
    sheet.setColumnWidth(2, 80);
    sheet.setColumnWidth(3, 120);

    SpreadsheetApp.flush();
    Logger.log('[buildPipelineSummary] Updated — yield: ' + yieldValue +
      '  (A=' + bandA + ' B=' + bandB + ' / ' + initialDataset + ')');

  } catch(e) {
    Logger.log('[buildPipelineSummary ERROR] ' + e.message);
  }
}


// ── Private helpers ─────────────────────────────────────────

function psFunnelHdr_(sheet, row, label) {
  sheet.getRange(row, 1, 1, 3)
    .setBackground('#1565c0')
    .setFontColor('#ffffff')
    .setFontWeight('bold')
    .setFontSize(11);
  sheet.getRange(row, 1).setValue(label);
  return row + 1;
}

function psDataRow_(sheet, row, label, count, pctStr) {
  sheet.getRange(row, 1).setValue(label);
  sheet.getRange(row, 2).setValue(count).setHorizontalAlignment('right');
  if (pctStr) sheet.getRange(row, 3).setValue(pctStr).setFontColor('#888888');
  return row + 1;
}

// Returns "X%" or "" when denominator is 0.
function psFmt_(num, denom) {
  if (!denom || denom === 0) return '';
  return Math.round(num / denom * 100) + '%';
}
