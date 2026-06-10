// ============================================================
// EventLog.gs
// Persistent user-visible event log — appends to EVENT_LOG sheet.
// One row per pipeline stage per company. Never throws.
// ============================================================

var EventLog = (function () {

  var SHEET_NAME = 'EVENT_LOG';
  var HEADERS    = ['Timestamp', 'Run_ID', 'Company', 'Website', 'Stage', 'Level', 'Outcome', 'Message'];

  function sheet_() {
    var ss = SpreadsheetApp.getActiveSpreadsheet();
    var s  = ss.getSheetByName(SHEET_NAME);
    if (!s) {
      s = ss.insertSheet(SHEET_NAME);
      formatSheet_(s);
    } else if (s.getLastRow() === 0) {
      formatSheet_(s);
    }
    return s;
  }

  function formatSheet_(s) {
    s.appendRow(HEADERS);
    s.getRange(1, 1, 1, HEADERS.length)
      .setFontWeight('bold')
      .setBackground('#e8f0fe');
    s.setFrozenRows(1);
    s.getRange(1, 1, 1, HEADERS.length).createFilter();

    s.setColumnWidth(1, 160); // Timestamp
    s.setColumnWidth(2, 130); // Run_ID
    s.setColumnWidth(3, 180); // Company
    s.setColumnWidth(4, 140); // Website
    s.setColumnWidth(5, 130); // Stage
    s.setColumnWidth(6, 70);  // Level
    s.setColumnWidth(7, 90);  // Outcome
    s.setColumnWidth(8, 500); // Message

    // Row color driven by Level column (col F = col 6)
    var dataRange = s.getRange('A2:H2000');
    s.setConditionalFormatRules([
      SpreadsheetApp.newConditionalFormatRule()
        .whenFormulaSatisfied('=$F2="ERROR"')
        .setBackground('#f4cccc').setFontColor('#990000')
        .setRanges([dataRange]).build(),
      SpreadsheetApp.newConditionalFormatRule()
        .whenFormulaSatisfied('=$F2="WARN"')
        .setBackground('#fff2cc').setFontColor('#7f6000')
        .setRanges([dataRange]).build(),
      SpreadsheetApp.newConditionalFormatRule()
        .whenFormulaSatisfied('=$F2="INFO"')
        .setBackground('#e8f0fe').setFontColor('#1a73e8')
        .setRanges([dataRange]).build(),
    ]);
  }

  function write_(runId, company, website, stage, level, outcome, message) {
    try {
      sheet_().appendRow([
        new Date(),
        runId   || '',
        company || '',
        website || '',
        stage   || '',
        level   || 'INFO',
        outcome || '-',
        String(message || '').slice(0, 500),
      ]);
    } catch (e) {
      console.warn('[EventLog] write failed: ' + e.message);
    }
  }

  return {
    info:  function (runId, company, website, stage, outcome, message) { write_(runId, company, website, stage, 'INFO',  outcome, message); },
    warn:  function (runId, company, website, stage, outcome, message) { write_(runId, company, website, stage, 'WARN',  outcome, message); },
    error: function (runId, company, website, stage, outcome, message) { write_(runId, company, website, stage, 'ERROR', outcome, message); },
  };

})();

// ============================================================
// Run this from the Apps Script editor to verify the sheet
// is created correctly and color-coding works.
// No API calls — safe to run anytime.
// ============================================================
function testEventLog() {
  var runId = 'TEST-' + Utilities.formatDate(new Date(), Session.getScriptTimeZone(), 'MMdd-HHmm');

  EventLog.info (runId, '',              '',            'sys-run-start',    'OK',      'Stage 1 started — 150 companies in queue');
  EventLog.info (runId, '',              '',            'sys-checkpoint',   '-',       'Resuming from index 0 of 150');
  EventLog.info (runId, 'Aarti Ind.',    'aarti.com',   's1-start',         '-',       'Entering Stage 1');
  EventLog.info (runId, 'Aarti Ind.',    'aarti.com',   's1-revenue-l1',    'OK',      'Revenue via direct search: 50-500Cr (High)');
  EventLog.info (runId, 'Aarti Ind.',    'aarti.com',   's1-gate1',         'PASS',    'Revenue band accepted: 50-500Cr');
  EventLog.info (runId, 'Aarti Ind.',    'aarti.com',   's1-gate2',         'PASS',    'Manufacturer signal confirmed: "manufacturing"');
  EventLog.info (runId, 'Aarti Ind.',    'aarti.com',   's1-gate3',         'PASS',    'No acquisition signal found');
  EventLog.info (runId, 'Aarti Ind.',    'aarti.com',   's1-done',          'PASS',    'Stage 1 PASS — revenue: 50-500Cr');
  EventLog.warn (runId, 'XYZ Corp',      'xyz.com',     's1-gate2',         'FAIL',    'CRO/service detected: "contract research organization"');
  EventLog.warn (runId, 'XYZ Corp',      'xyz.com',     's1-done',          'FAIL',    'Stage 1 FAIL — CRO/service detected: "contract research"');
  EventLog.info (runId, 'Aarti Ind.',    'aarti.com',   'sc-start',         '-',       'Entering scoring pipeline (1/43)');
  EventLog.info (runId, 'Aarti Ind.',    'aarti.com',   'sc-c3',            'OK',      'C3: 18/25 (High) — Patents (Strong), DSIR (Strong), Regulatory_Approvals (Weak)');
  EventLog.info (runId, 'Aarti Ind.',    'aarti.com',   'sc-c4-name',       'OK',      'DM name found via tofler_snippet: "Rajesh Kumar"');
  EventLog.info (runId, 'Aarti Ind.',    'aarti.com',   'sc-c4',            'OK',      'C4: 20/20 — Strong | DM: Rajesh Kumar');
  EventLog.info (runId, 'Aarti Ind.',    'aarti.com',   'sc-c5',            'OK',      'C5: 20/20 — sector: Pharma intermediates (keyword: "active pharmaceutical ingredient")');
  EventLog.info (runId, 'Aarti Ind.',    'aarti.com',   'sc-c6',            'OK',      'C6: 20/20 — 3 signals (merged): Hiring (hiring), Export_Growth (exports), Certifications (usfda)');
  EventLog.info (runId, 'Aarti Ind.',    'aarti.com',   'sc-done',          'Band_A',  'Final score 88/100 — Band A: Strong Federer | C3=18 C4=20 C5=20 C6=20');
  EventLog.error(runId, 'ABC Ltd',       'abc.com',     'sc-c3',            'ERROR',   'C3: 0/25 — Gemini returned null, flagged for manual review');
  EventLog.info (runId, '',              '',            'sys-run-complete',  'OK',      'Scoring complete — processed 43, skipped 5');

  Logger.log('testEventLog complete — check the EVENT_LOG sheet');
}
