// ============================================================
// DiagnoseCorruption.js
// READ-ONLY diagnostic for the STAGE1_RESULTS column-corruption
// report (~5100 rows, values landing in the wrong column).
//
// Does NOT modify STAGE1_RESULTS. Writes findings to a new
// "CORRUPTION_REPORT" sheet (cleared and rebuilt each run) so the
// exact shift pattern can be inspected with real cell values,
// not pasted/copied text that can lose empty-cell tabs.
//
// Run diagnoseStage1Corruption() from the Apps Script editor.
// ============================================================

function diagnoseStage1Corruption() {
  Logger.log('=== diagnoseStage1Corruption START ===');

  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var stage1Sheet = ss.getSheetByName(SHEETS.STAGE1);
  if (!stage1Sheet || stage1Sheet.getLastRow() < 2) {
    Logger.log('[diagnoseStage1Corruption] STAGE1_RESULTS empty or missing.');
    return;
  }

  var lastRow = stage1Sheet.getLastRow();
  var numCols = stage1Sheet.getLastColumn();
  var data = stage1Sheet.getRange(2, 1, lastRow - 1, numCols).getValues();

  var FLAG_VALUES = ['YES', 'NO', ''];
  var counts = {};
  var findings = [];

  function flag(rowNum, company, anomaly, raw) {
    counts[anomaly] = (counts[anomaly] || 0) + 1;
    if (findings.length < 2000) {
      findings.push([
        rowNum,
        company,
        anomaly,
        raw.mfg, raw.acq, raw.band, raw.conf, raw.evid, raw.src, raw.status, raw.fail,
      ]);
    }
  }

  data.forEach(function(row, idx) {
    var rowNum = idx + 2;
    var company = String(row[0] || '').trim();
    if (!company) return;

    var raw = {
      mfg:    String(row[3]  || '').trim(),
      acq:    String(row[4]  || '').trim(),
      band:   String(row[5]  || '').trim(),
      conf:   String(row[6]  || '').trim(),
      evid:   String(row[7]  || '').trim(),
      src:    String(row[8]  || '').trim(),
      status: String(row[9]  || '').trim(),
      fail:   String(row[10] || '').trim(),
    };

    // Signature 1: Revenue_Band holds a literal flag value — impossible
    // for a real band string ("<50Cr", "50-500Cr", "500-1500Cr", ">1500Cr",
    // "Unknown", "PENDING_REVENUE", "-").
    if (raw.band === 'YES' || raw.band === 'NO') {
      flag(rowNum, company, 'BAND_HOLDS_FLAG_VALUE', raw);
    }

    // Signature 2: Manufacturer_Flag or Acquired_Flag holds something
    // other than YES/NO/empty — likely holds a band string instead.
    if (FLAG_VALUES.indexOf(raw.mfg) === -1) {
      flag(rowNum, company, 'MFG_FLAG_HOLDS_NON_FLAG_VALUE', raw);
    }
    if (FLAG_VALUES.indexOf(raw.acq) === -1) {
      flag(rowNum, company, 'ACQ_FLAG_HOLDS_NON_FLAG_VALUE', raw);
    }

    // Signature 3: status PASS requires manufacturer YES, acquired NO,
    // and a real revenue band (Gate1 passed before Gate2/3 ran).
    if (raw.status === 'PASS') {
      if (raw.mfg !== 'YES') flag(rowNum, company, 'PASS_BUT_MFG_NOT_YES', raw);
      if (raw.acq !== 'NO')  flag(rowNum, company, 'PASS_BUT_ACQ_NOT_NO', raw);
      if (!raw.band || raw.band === 'YES' || raw.band === 'NO') {
        flag(rowNum, company, 'PASS_BUT_BAND_MISSING', raw);
      }
    }

    // Signature 4: PE/acquired fail reason requires acquired=YES,
    // manufacturer=YES (Gate2 passed before Gate3 ran), and a real band.
    if (raw.fail.indexOf('PE/acquired detected') === 0) {
      if (raw.acq !== 'YES') flag(rowNum, company, 'PEFAIL_BUT_ACQ_NOT_YES', raw);
      if (raw.mfg !== 'YES') flag(rowNum, company, 'PEFAIL_BUT_MFG_NOT_YES', raw);
      if (!raw.band || raw.band === 'YES' || raw.band === 'NO') {
        flag(rowNum, company, 'PEFAIL_BUT_BAND_MISSING', raw);
      }
    }

    // Signature 5: "No manufacturing signal found" / CRO / Trader fail
    // requires manufacturer=NO and acquired=NO (gate3 never ran), and
    // still a real band (Gate1 already passed).
    if (raw.fail.indexOf('No manufacturing signal found') === 0 ||
        raw.fail.indexOf('CRO/service detected') === 0 ||
        raw.fail.indexOf('Trader/distributor only') === 0) {
      if (raw.mfg !== 'NO') flag(rowNum, company, 'MFGFAIL_BUT_MFG_NOT_NO', raw);
      if (raw.acq !== 'NO') flag(rowNum, company, 'MFGFAIL_BUT_ACQ_NOT_NO', raw);
      if (!raw.band || raw.band === 'YES' || raw.band === 'NO') {
        flag(rowNum, company, 'MFGFAIL_BUT_BAND_MISSING', raw);
      }
    }

    // Signature 6: "Revenue band rejected: X" fail reason — the band
    // actually found was X; the Revenue_Band cell should equal X.
    var rejectMatch = raw.fail.match(/^Revenue band rejected: (.+)$/);
    if (rejectMatch && raw.band !== rejectMatch[1]) {
      flag(rowNum, company, 'BAND_MISMATCHES_FAIL_REASON', raw);
    }
  });

  // ── Write report sheet ──────────────────────────────────────
  var reportSheet = ss.getSheetByName('CORRUPTION_REPORT');
  if (reportSheet) ss.deleteSheet(reportSheet);
  reportSheet = ss.insertSheet('CORRUPTION_REPORT');

  reportSheet.appendRow([
    'Row', 'Company', 'Anomaly',
    'Manufacturer_Flag', 'Acquired_Flag', 'Revenue_Band', 'Revenue_Confidence',
    'Revenue_Evidence', 'Revenue_Source', 'Stage1_Status', 'Fail_Reason',
  ]);
  if (findings.length) {
    reportSheet.getRange(2, 1, findings.length, findings[0].length).setValues(findings);
  }
  reportSheet.getRange(1, 1, 1, 11).setFontWeight('bold');
  reportSheet.setFrozenRows(1);

  Logger.log('[diagnoseStage1Corruption] Anomaly counts:');
  Object.keys(counts).sort().forEach(function(k) {
    Logger.log('  ' + k + ': ' + counts[k]);
  });
  Logger.log('[diagnoseStage1Corruption] Total flagged rows (capped at 2000 written to sheet): ' + findings.length);
  Logger.log('[diagnoseStage1Corruption] See CORRUPTION_REPORT sheet for full detail.');
  Logger.log('=== diagnoseStage1Corruption COMPLETE ===');
}
