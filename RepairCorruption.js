// ============================================================
// RepairCorruption.js
// ONE-OFF script to fix the ~5100 STAGE1_RESULTS rows where
// Manufacturer_Flag, Acquired_Flag, and/or Revenue_Band ended up
// wrong/blank (see DiagnoseCorruption.js / CORRUPTION_REPORT).
//
// Root cause confirmed via git history: updateStage1Revenue()
// never wrote Manufacturer_Flag/Acquired_Flag at all from the
// first commit until 04e963e — those columns were stuck at
// stale placeholder values for every company resolved through
// the Gemini batch path. Several other historical write-path
// versions compound this for different row subsets. Rather than
// reverse-engineer every historical bug, this re-derives the
// correct values from Stage1_Status + Fail_Reason, which are
// intact in every row inspected so far, plus the fact that
// CONFIG.PIPELINE.STAGE1_PASS_BANDS has only ever been
// ["50-500Cr"] — so any row where Gate 1 passed has exactly one
// possible true band.
//
// Rules (status / fail reason → manufacturer, acquired, band):
//   Fail_Reason starts "PE/acquired detected"          → YES, YES, 50-500Cr
//   Stage1_Status === "PASS"                            → YES, NO,  50-500Cr
//   Fail_Reason starts "No manufacturing signal found"
//     / "CRO/service detected" / "Trader/distributor only" → NO, NO, 50-500Cr
//   Fail_Reason matches "Revenue band rejected: X"      → NO, NO,  X
//   Fail_Reason === "No revenue evidence found", or an
//     "Unknown revenue..." variant, or status MANUAL_REVIEW → NO, NO, Unknown
//   Anything else (incl. PENDING_REVENUE — never actually
//     resolved) → left untouched, logged for manual review.
//
// Run repairStage1Corruption() first (dry run, default) — logs
// what would change without touching the sheet. Review the log,
// then run repairStage1Corruption_EXECUTE() to apply for real.
// ============================================================

function repairStage1Corruption_EXECUTE() {
  repairStage1Corruption(false);
}

function repairStage1Corruption(dryRun) {
  if (dryRun === undefined) dryRun = true;
  Logger.log('=== repairStage1Corruption START ' + (dryRun ? '(DRY RUN — nothing will be changed)' : '(LIVE — will modify the sheet)') + ' ===');

  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sheet = ss.getSheetByName(SHEETS.STAGE1);
  if (!sheet || sheet.getLastRow() < 2) {
    Logger.log('[repairStage1Corruption] STAGE1_RESULTS empty or missing.');
    return;
  }

  var lastRow = sheet.getLastRow();
  var data = sheet.getRange(2, 1, lastRow - 1, 11).getValues();

  var fixes = [];          // { rowNum, mfg, acq, band }
  var unrecognized = [];   // { rowNum, company, status, failReason }
  var skippedPending = 0;
  var alreadyCorrect = 0;

  data.forEach(function(row, idx) {
    var rowNum  = idx + 2;
    var company = String(row[0] || '').trim();
    if (!company) return;

    var curMfg  = String(row[3]  || '').trim();
    var curAcq  = String(row[4]  || '').trim();
    var curBand = String(row[5]  || '').trim();
    var status  = String(row[9]  || '').trim();
    var fail    = String(row[10] || '').trim();

    var mfg = null, acq = null, band = null;

    var rejectMatch = fail.match(/^Revenue band rejected: (.+)$/);

    if (fail.indexOf('PE/acquired detected') === 0) {
      mfg = 'YES'; acq = 'YES'; band = '50-500Cr';
    } else if (status === 'PASS') {
      mfg = 'YES'; acq = 'NO'; band = '50-500Cr';
    } else if (
      fail.indexOf('No manufacturing signal found') === 0 ||
      fail.indexOf('CRO/service detected') === 0 ||
      fail.indexOf('Trader/distributor only') === 0
    ) {
      mfg = 'NO'; acq = 'NO'; band = '50-500Cr';
    } else if (rejectMatch) {
      mfg = 'NO'; acq = 'NO'; band = rejectMatch[1];
    } else if (
      fail === 'No revenue evidence found' ||
      fail.indexOf('Unknown revenue') === 0 ||
      status === 'MANUAL_REVIEW'
    ) {
      mfg = 'NO'; acq = 'NO'; band = 'Unknown';
    } else if (status === 'PENDING_REVENUE') {
      skippedPending++;
      return;
    } else {
      unrecognized.push({ rowNum: rowNum, company: company, status: status, failReason: fail });
      return;
    }

    if (mfg === curMfg && acq === curAcq && band === curBand) {
      alreadyCorrect++;
      return;
    }

    fixes.push({ rowNum: rowNum, mfg: mfg, acq: acq, band: band });
  });

  Logger.log('[repairStage1Corruption] ' + fixes.length + ' rows need fixing.');
  Logger.log('[repairStage1Corruption] ' + alreadyCorrect + ' rows already correct — left alone.');
  Logger.log('[repairStage1Corruption] ' + skippedPending + ' rows still PENDING_REVENUE — never resolved, re-run the pipeline for these, not this script.');
  Logger.log('[repairStage1Corruption] ' + unrecognized.length + ' rows did not match any known pattern — manual review needed.');

  if (unrecognized.length) {
    var reportSheet = ss.getSheetByName('REPAIR_UNRECOGNIZED');
    if (reportSheet) ss.deleteSheet(reportSheet);
    reportSheet = ss.insertSheet('REPAIR_UNRECOGNIZED');
    reportSheet.appendRow(['Row', 'Company', 'Stage1_Status', 'Fail_Reason']);
    reportSheet.getRange(2, 1, unrecognized.length, 4).setValues(
      unrecognized.map(function(u) { return [u.rowNum, u.company, u.status, u.failReason]; })
    );
    reportSheet.getRange(1, 1, 1, 4).setFontWeight('bold');
    Logger.log('[repairStage1Corruption] Unrecognized rows written to REPAIR_UNRECOGNIZED sheet.');
  }

  if (dryRun) {
    Logger.log('[repairStage1Corruption] Sample of first 10 planned fixes:');
    fixes.slice(0, 10).forEach(function(f) {
      Logger.log('  row ' + f.rowNum + ' → Manufacturer_Flag=' + f.mfg + ', Acquired_Flag=' + f.acq + ', Revenue_Band=' + f.band);
    });
    Logger.log('[repairStage1Corruption] Run repairStage1Corruption_EXECUTE() to apply for real.');
    Logger.log('=== repairStage1Corruption DRY RUN COMPLETE ===');
    return;
  }

  // ── Apply fixes in batches, columns D:F (4-6) per row ──────────
  var BATCH_SIZE = 500;
  for (var i = 0; i < fixes.length; i += BATCH_SIZE) {
    var batch = fixes.slice(i, i + BATCH_SIZE);
    batch.forEach(function(f) {
      sheet.getRange(f.rowNum, 4, 1, 3).setValues([[f.mfg, f.acq, f.band]]);
    });
    SpreadsheetApp.flush();
    Logger.log('[repairStage1Corruption] Applied ' + Math.min(i + BATCH_SIZE, fixes.length) + ' / ' + fixes.length);
  }

  Logger.log('[repairStage1Corruption] Done — ' + fixes.length + ' rows repaired.');
  Logger.log('=== repairStage1Corruption COMPLETE ===');
}
