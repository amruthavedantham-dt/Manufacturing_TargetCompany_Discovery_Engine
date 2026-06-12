// ============================================================
// TokenLog.js
// Two separate ledger sheets:
//   TOKEN_LOG  — one row per Gemini API call (tokens + cost)
//   SERPER_LOG — one row per Serper search call (results + cost)
// Never throws. Auto-creates sheets if missing.
// ============================================================

var TokenLog = (function () {

  // ── TOKEN_LOG (Gemini) ─────────────────────────────────────

  var GEMINI_SHEET_NAME = 'TOKEN_LOG';
  var GEMINI_HEADERS    = [
    'Timestamp', 'Run_ID', 'Company', 'Stage',
    'Model', 'Input_Tokens', 'Output_Tokens', 'Thinking_Tokens',
    'Cost_USD', 'Cost_INR',
  ];

  function geminiSheet_() {
    var ss = SpreadsheetApp.getActiveSpreadsheet();
    var s  = ss.getSheetByName(GEMINI_SHEET_NAME);
    if (!s) {
      s = ss.insertSheet(GEMINI_SHEET_NAME);
      formatGeminiSheet_(s);
    } else if (s.getLastRow() === 0) {
      formatGeminiSheet_(s);
    }
    return s;
  }

  function formatGeminiSheet_(s) {
    s.appendRow(GEMINI_HEADERS);
    s.getRange(1, 1, 1, GEMINI_HEADERS.length)
      .setFontWeight('bold')
      .setBackground('#fce8b2');
    s.setFrozenRows(1);
    s.getRange(1, 1, 1, GEMINI_HEADERS.length).createFilter();

    s.setColumnWidth(1, 160);  // Timestamp
    s.setColumnWidth(2, 130);  // Run_ID
    s.setColumnWidth(3, 180);  // Company
    s.setColumnWidth(4, 110);  // Stage
    s.setColumnWidth(5, 160);  // Model
    s.setColumnWidth(6, 110);  // Input_Tokens
    s.setColumnWidth(7, 120);  // Output_Tokens
    s.setColumnWidth(8, 130);  // Thinking_Tokens
    s.setColumnWidth(9, 90);   // Cost_USD
    s.setColumnWidth(10, 90);  // Cost_INR
  }

  function calcGeminiCost_(model, inputTokens, outputTokens, thinkingTokens) {
    var rates = (CONFIG.COST_RATES && CONFIG.COST_RATES[model]) || {
      inputPerMillion:    0.075,
      outputPerMillion:   0.30,
      thinkingPerMillion: 3.50,
    };
    var usd =
      (inputTokens    / 1e6) * rates.inputPerMillion    +
      (outputTokens   / 1e6) * rates.outputPerMillion   +
      (thinkingTokens / 1e6) * rates.thinkingPerMillion;
    var inr = usd * (CONFIG.INR_PER_USD || 84);
    return {
      usd: Math.round(usd * 1e6) / 1e6,
      inr: Math.round(inr * 1e4) / 1e4,
    };
  }


  // ── SERPER_LOG ─────────────────────────────────────────────

  var SERPER_SHEET_NAME = 'SERPER_LOG';
  var SERPER_HEADERS    = [
    'Timestamp', 'Run_ID', 'Company', 'Query_Type', 'Results_Count', 'Cost_USD', 'Cost_INR',
  ];

  function serperSheet_() {
    var ss = SpreadsheetApp.getActiveSpreadsheet();
    var s  = ss.getSheetByName(SERPER_SHEET_NAME);
    if (!s) {
      s = ss.insertSheet(SERPER_SHEET_NAME);
      formatSerperSheet_(s);
    } else if (s.getLastRow() === 0) {
      formatSerperSheet_(s);
    }
    return s;
  }

  function formatSerperSheet_(s) {
    s.appendRow(SERPER_HEADERS);
    s.getRange(1, 1, 1, SERPER_HEADERS.length)
      .setFontWeight('bold')
      .setBackground('#d9ead3');
    s.setFrozenRows(1);
    s.getRange(1, 1, 1, SERPER_HEADERS.length).createFilter();

    s.setColumnWidth(1, 160);  // Timestamp
    s.setColumnWidth(2, 130);  // Run_ID
    s.setColumnWidth(3, 180);  // Company
    s.setColumnWidth(4, 130);  // Query_Type
    s.setColumnWidth(5, 120);  // Results_Count
    s.setColumnWidth(6, 90);   // Cost_USD
    s.setColumnWidth(7, 90);   // Cost_INR
  }


  // ── Public API ─────────────────────────────────────────────

  return {

    // Called from callGeminiWithRetry in ai.js
    append: function (runId, company, stage, model, usage) {
      try {
        var inputTokens    = (usage && usage.inputTokens)    || 0;
        var outputTokens   = (usage && usage.outputTokens)   || 0;
        var thinkingTokens = (usage && usage.thinkingTokens) || 0;
        var cost = calcGeminiCost_(model, inputTokens, outputTokens, thinkingTokens);

        geminiSheet_().appendRow([
          new Date(),
          runId   || '',
          company || '',
          stage   || '',
          model   || '',
          inputTokens,
          outputTokens,
          thinkingTokens,
          cost.usd,
          cost.inr,
        ]);
      } catch (e) {
        console.warn('[TokenLog] append failed: ' + e.message);
      }
    },

    // Called from callSerper in ai.js and c4_searchPersonBackground in c4.js
    appendSerper: function (runId, company, queryType, resultsCount) {
      try {
        var rate = (CONFIG.COST_RATES && CONFIG.COST_RATES.serper && CONFIG.COST_RATES.serper.perCall) || 0.001;
        var usd  = rate;
        var inr  = Math.round(usd * (CONFIG.INR_PER_USD || 84) * 1e4) / 1e4;

        serperSheet_().appendRow([
          new Date(),
          runId        || '',
          company      || '',
          queryType    || '',
          resultsCount || 0,
          usd,
          inr,
        ]);
      } catch (e) {
        console.warn('[TokenLog] appendSerper failed: ' + e.message);
      }
    },

  };

})();


// ============================================================
// Run from the editor to verify both sheets create correctly.
// No API calls — safe to run anytime.
// ============================================================
function testTokenLog() {
  var runId = 'TEST-' + Utilities.formatDate(new Date(), Session.getScriptTimeZone(), 'MMdd-HHmm');

  // TOKEN_LOG rows (Gemini)
  TokenLog.append(runId, 'Avra Synthesis',  'c3',               'gemini-2.5-flash', { inputTokens: 1200, outputTokens: 350, thinkingTokens: 0   });
  TokenLog.append(runId, 'Avra Synthesis',  'c4-name',          'gemini-2.5-flash', { inputTokens: 800,  outputTokens: 120, thinkingTokens: 0   });
  TokenLog.append(runId, 'Avra Synthesis',  'c4-depth',         'gemini-2.5-flash', { inputTokens: 950,  outputTokens: 200, thinkingTokens: 0   });
  TokenLog.append(runId, 'Avra Synthesis',  'c6',               'gemini-2.5-flash', { inputTokens: 700,  outputTokens: 150, thinkingTokens: 0   });
  TokenLog.append(runId, '[batch-10]',      's1-revenue-batch', 'gemini-2.5-flash', { inputTokens: 4500, outputTokens: 900, thinkingTokens: 0   });
  TokenLog.append(runId, "Divi's Labs",     'c3',               'gemini-2.5-flash', { inputTokens: 1400, outputTokens: 400, thinkingTokens: 100 });

  // SERPER_LOG rows
  TokenLog.appendSerper(runId, 'Avra Synthesis', 'C3',           8);
  TokenLog.appendSerper(runId, 'Avra Synthesis', 'C4_TOFLER',    8);
  TokenLog.appendSerper(runId, 'Avra Synthesis', 'C4_ZAUBA',     8);
  TokenLog.appendSerper(runId, 'Avra Synthesis', 'C4_BG',        6);
  TokenLog.appendSerper(runId, 'Avra Synthesis', 'STAGE1_MFG',   8);
  TokenLog.appendSerper(runId, 'Avra Synthesis', 'REVENUE_DIRECT', 8);

  Logger.log('testTokenLog complete — check TOKEN_LOG and SERPER_LOG sheets');
}
