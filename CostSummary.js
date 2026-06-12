// ============================================================
// CostSummary.js
// Reads TOKEN_LOG (Gemini) + SERPER_LOG (Serper), aggregates
// by Run_ID and by Stage/QueryType, and rewrites COST_SUMMARY.
// Called from the ICP Pipeline custom menu.
// ============================================================

var COST_SUMMARY_SHEET_NAME = 'COST_SUMMARY';

// ─────────────────────────────────────────────────────────────
// ENTRY POINT
// ─────────────────────────────────────────────────────────────

function buildCostSummary() {
  var ui = SpreadsheetApp.getUi();

  try {
    Logger.log('[buildCostSummary START]');

    // Step 1 — Read source sheets (skip header row automatically)
    var geminiRows = readLogSheet_('TOKEN_LOG',  10);
    var serperRows = readLogSheet_('SERPER_LOG', 7);

    if (!geminiRows.length && !serperRows.length) {
      ui.alert('TOKEN_LOG and SERPER_LOG are both empty. Run the pipeline first.');
      return;
    }

    // Step 2 — Aggregate
    var byRun         = aggregateByRun_(geminiRows, serperRows);
    var byGeminiStage = aggregateGeminiByStage_(geminiRows);
    var bySerperType  = aggregateSerperByType_(serperRows);

    // Step 3 — Get or create COST_SUMMARY sheet
    var ss    = SpreadsheetApp.getActiveSpreadsheet();
    var sheet = ss.getSheetByName(COST_SUMMARY_SHEET_NAME);
    if (!sheet) {
      sheet = ss.insertSheet(COST_SUMMARY_SHEET_NAME);
    } else {
      sheet.clearContents();
      sheet.clearFormats();
    }

    // Step 4 — Write sections top-to-bottom
    var cursor = 1;
    cursor = writeTitleRow_(sheet, cursor);
    cursor = writeRunSection_(sheet, cursor, byRun);
    cursor = writeGeminiSection_(sheet, cursor, byGeminiStage);
    cursor = writeSerperSection_(sheet, cursor, bySerperType);

    // Step 5 — Column widths
    sheet.setColumnWidth(1, 165);
    sheet.setColumnWidth(2, 125);
    for (var c = 3; c <= 10; c++) sheet.setColumnWidth(c, 108);

    SpreadsheetApp.flush();

    var totalEntries = geminiRows.length + serperRows.length;
    Logger.log('[buildCostSummary COMPLETE] ' + byRun.length + ' runs, ' + totalEntries + ' log entries');
    ui.alert(
      'Cost Summary rebuilt.\n' +
      byRun.length + ' runs  |  ' + geminiRows.length + ' Gemini calls  |  ' + serperRows.length + ' Serper calls.'
    );

  } catch (err) {
    Logger.log('[buildCostSummary ERROR] ' + err.message);
    ui.alert('Error building Cost Summary:\n' + err.message);
  }
}


// ─────────────────────────────────────────────────────────────
// SECTION 1 — DATA READERS
// ─────────────────────────────────────────────────────────────

function readLogSheet_(sheetName, numCols) {
  var ss    = SpreadsheetApp.getActiveSpreadsheet();
  var sheet = ss.getSheetByName(sheetName);
  if (!sheet || sheet.getLastRow() < 2) return [];
  return sheet.getRange(2, 1, sheet.getLastRow() - 1, numCols).getValues();
}


// ─────────────────────────────────────────────────────────────
// SECTION 2 — AGGREGATION
// ─────────────────────────────────────────────────────────────

function aggregateByRun_(geminiRows, serperRows) {
  var map = {};

  function ensure_(runId, ts) {
    if (!map[runId]) map[runId] = {
      runId: runId, date: ts,
      geminiCalls: 0, geminiUSD: 0, geminiINR: 0,
      serperCalls: 0, serperUSD: 0, serperINR: 0,
    };
  }

  geminiRows.forEach(function(r) {
    var id = String(r[1] || '').trim();
    if (!id) return;
    ensure_(id, r[0]);
    map[id].geminiCalls++;
    map[id].geminiUSD += Number(r[8]) || 0;
    map[id].geminiINR += Number(r[9]) || 0;
  });

  serperRows.forEach(function(r) {
    var id = String(r[1] || '').trim();
    if (!id) return;
    ensure_(id, r[0]);
    map[id].serperCalls++;
    map[id].serperUSD += Number(r[5]) || 0;
    map[id].serperINR += Number(r[6]) || 0;
  });

  return Object.values(map).sort(function(a, b) {
    return String(a.runId).localeCompare(String(b.runId));
  });
}

function aggregateGeminiByStage_(rows) {
  var map = {};
  rows.forEach(function(r) {
    var stage = String(r[3] || 'unknown').trim();
    if (!map[stage]) map[stage] = {
      stage: stage, calls: 0,
      inputT: 0, outputT: 0, thinkT: 0,
      usd: 0, inr: 0,
    };
    map[stage].calls++;
    map[stage].inputT  += Number(r[5]) || 0;
    map[stage].outputT += Number(r[6]) || 0;
    map[stage].thinkT  += Number(r[7]) || 0;
    map[stage].usd     += Number(r[8]) || 0;
    map[stage].inr     += Number(r[9]) || 0;
  });
  return Object.values(map).sort(function(a, b) { return b.usd - a.usd; });
}

function aggregateSerperByType_(rows) {
  var map = {};
  rows.forEach(function(r) {
    var qt = String(r[3] || 'unknown').trim();
    if (!map[qt]) map[qt] = { queryType: qt, calls: 0, results: 0, usd: 0, inr: 0 };
    map[qt].calls++;
    map[qt].results += Number(r[4]) || 0;
    map[qt].usd     += Number(r[5]) || 0;
    map[qt].inr     += Number(r[6]) || 0;
  });
  return Object.values(map).sort(function(a, b) { return b.usd - a.usd; });
}


// ─────────────────────────────────────────────────────────────
// SECTION 3 — ROUNDING HELPERS
// ─────────────────────────────────────────────────────────────

function r6_(n) { return Math.round((Number(n) || 0) * 1e6) / 1e6; }
function r4_(n) { return Math.round((Number(n) || 0) * 1e4) / 1e4; }
function ri_(n) { return Math.round(Number(n) || 0); }

function fmtDate_(d) {
  if (!d) return '';
  try { return Utilities.formatDate(new Date(d), Session.getScriptTimeZone(), 'dd MMM HH:mm'); }
  catch(e) { return String(d); }
}


// ─────────────────────────────────────────────────────────────
// SECTION 4 — SHEET WRITERS
// ─────────────────────────────────────────────────────────────

function writeTitleRow_(sheet, row) {
  var ts = Utilities.formatDate(new Date(), Session.getScriptTimeZone(), 'dd MMM yyyy, HH:mm');
  sheet.getRange(row, 1).setValue('ICP PIPELINE — COST SUMMARY')
    .setFontWeight('bold').setFontSize(14);
  sheet.getRange(row, 8, 1, 3).merge().setValue('Generated: ' + ts)
    .setFontColor('#888888').setFontSize(10).setHorizontalAlignment('right');
  return row + 2; // title row + one blank
}

function writeSectionHdr_(sheet, row, label) {
  sheet.getRange(row, 1, 1, 10)
    .setBackground('#1565c0')
    .setFontColor('#ffffff')
    .setFontWeight('bold')
    .setFontSize(11);
  sheet.getRange(row, 1).setValue(label);
  return row + 1;
}

function writeColHdr_(sheet, row, headers) {
  sheet.getRange(row, 1, 1, headers.length)
    .setValues([headers])
    .setFontWeight('bold')
    .setBackground('#e8eaf6');
  return row + 1;
}

function writeDataRow_(sheet, row, values, isTotalRow) {
  var range = sheet.getRange(row, 1, 1, values.length).setValues([values]);
  if (isTotalRow) range.setFontWeight('bold').setBackground('#fff9c4');
  return row + 1;
}

// ─── Per-Run section ──────────────────────────────────────────
function writeRunSection_(sheet, startRow, byRun) {
  var row = startRow;
  row = writeSectionHdr_(sheet, row, '1.  PER-RUN TOTALS');
  row = writeColHdr_(sheet, row, [
    'Run_ID', 'Date',
    'Gemini Calls', 'Gemini Cost USD', 'Gemini Cost INR',
    'Serper Calls',  'Serper Cost USD',  'Serper Cost INR',
    'Total Cost USD', 'Total Cost INR',
  ]);

  var tGCalls = 0, tGUSD = 0, tGINR = 0;
  var tSCalls = 0, tSUSD = 0, tSINR = 0;

  if (byRun.length === 0) {
    sheet.getRange(row, 1).setValue('(no data)').setFontColor('#888888');
    row++;
  } else {
    byRun.forEach(function(r) {
      row = writeDataRow_(sheet, row, [
        r.runId,      fmtDate_(r.date),
        r.geminiCalls, r6_(r.geminiUSD), r4_(r.geminiINR),
        r.serperCalls, r6_(r.serperUSD), r4_(r.serperINR),
        r6_(r.geminiUSD + r.serperUSD), r4_(r.geminiINR + r.serperINR),
      ], false);
      tGCalls += r.geminiCalls; tGUSD += r.geminiUSD; tGINR += r.geminiINR;
      tSCalls += r.serperCalls; tSUSD += r.serperUSD; tSINR += r.serperINR;
    });
    row = writeDataRow_(sheet, row, [
      'TOTAL', '',
      tGCalls, r6_(tGUSD), r4_(tGINR),
      tSCalls, r6_(tSUSD), r4_(tSINR),
      r6_(tGUSD + tSUSD), r4_(tGINR + tSINR),
    ], true);
  }

  return row + 1; // blank row after section
}

// ─── Gemini per-stage section ─────────────────────────────────
function writeGeminiSection_(sheet, startRow, byStage) {
  var row = startRow;
  row = writeSectionHdr_(sheet, row, '2.  GEMINI — PER-STAGE BREAKDOWN');
  row = writeColHdr_(sheet, row, [
    'Stage', 'Calls',
    'Input Tokens', 'Output Tokens', 'Thinking Tokens', 'Avg Input Tokens',
    'Total Cost USD', 'Total Cost INR', 'Avg Cost/Call USD',
  ]);

  var tCalls = 0, tInput = 0, tOutput = 0, tThink = 0, tUSD = 0, tINR = 0;

  if (byStage.length === 0) {
    sheet.getRange(row, 1).setValue('(no Gemini data)').setFontColor('#888888');
    row++;
  } else {
    byStage.forEach(function(s) {
      row = writeDataRow_(sheet, row, [
        s.stage, s.calls,
        ri_(s.inputT), ri_(s.outputT), ri_(s.thinkT),
        s.calls > 0 ? ri_(s.inputT / s.calls) : 0,
        r6_(s.usd), r4_(s.inr),
        s.calls > 0 ? r6_(s.usd / s.calls) : 0,
      ], false);
      tCalls  += s.calls;  tInput  += s.inputT; tOutput += s.outputT;
      tThink  += s.thinkT; tUSD    += s.usd;    tINR    += s.inr;
    });
    row = writeDataRow_(sheet, row, [
      'TOTAL', tCalls,
      ri_(tInput), ri_(tOutput), ri_(tThink),
      tCalls > 0 ? ri_(tInput / tCalls) : 0,
      r6_(tUSD), r4_(tINR),
      tCalls > 0 ? r6_(tUSD / tCalls) : 0,
    ], true);
  }

  return row + 1;
}

// ─── Serper per-query-type section ───────────────────────────
function writeSerperSection_(sheet, startRow, byType) {
  var row = startRow;
  row = writeSectionHdr_(sheet, row, '3.  SERPER — PER-QUERY-TYPE BREAKDOWN');
  row = writeColHdr_(sheet, row, [
    'Query_Type', 'Calls', 'Total Results', 'Avg Results/Call',
    'Total Cost USD', 'Total Cost INR', 'Avg Cost/Call USD',
  ]);

  var tCalls = 0, tResults = 0, tUSD = 0, tINR = 0;

  if (byType.length === 0) {
    sheet.getRange(row, 1).setValue('(no Serper data)').setFontColor('#888888');
    row++;
  } else {
    byType.forEach(function(t) {
      row = writeDataRow_(sheet, row, [
        t.queryType, t.calls,
        ri_(t.results),
        t.calls > 0 ? r4_(t.results / t.calls) : 0,
        r6_(t.usd), r4_(t.inr),
        t.calls > 0 ? r6_(t.usd / t.calls) : 0,
      ], false);
      tCalls   += t.calls; tResults += t.results;
      tUSD     += t.usd;   tINR     += t.inr;
    });
    row = writeDataRow_(sheet, row, [
      'TOTAL', tCalls,
      ri_(tResults),
      tCalls > 0 ? r4_(tResults / tCalls) : 0,
      r6_(tUSD), r4_(tINR),
      tCalls > 0 ? r6_(tUSD / tCalls) : 0,
    ], true);
  }

  return row + 1;
}
