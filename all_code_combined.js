// ===== FILE: AutoRun.js =====
// ============================================================
// AutoRun.js
// Chains Stage 1 → Scoring with a single self-managing trigger.
// The trigger fires autoRunHandler() every 10 minutes.
// Stage 1 completion → PIPELINE_MODE switches to 'SCORING'.
// Scoring completion → trigger self-destructs.
//
// Public surface:
//   startAutoRun()     create trigger + start immediately (menu)
//   stopAutoRun()      emergency abort (menu)
//   autoRunHandler()   GAS trigger target — do not rename
// ============================================================

var AUTO_RUN_TRIGGER_KEY = 'AUTO_RUN_TRIGGER_ID';
var PIPELINE_MODE_KEY    = 'PIPELINE_MODE';


function startAutoRun() {
  var props = PropertiesService.getScriptProperties();
  var ui    = SpreadsheetApp.getUi();

  // Guard: don't create duplicate triggers
  var existingId = props.getProperty(AUTO_RUN_TRIGGER_KEY);
  if (existingId) {
    var alreadyExists = ScriptApp.getProjectTriggers().some(function(t) {
      return t.getUniqueId() === existingId;
    });
    if (alreadyExists) {
      ui.alert(
        'Auto-run is already active.\n\n' +
        'Click "Stop Auto-Run" first if you want to restart.'
      );
      return;
    }
  }

  // Set initial mode and create the recurring trigger
  props.setProperty(PIPELINE_MODE_KEY, 'STAGE1');

  var trigger = ScriptApp.newTrigger('autoRunHandler')
    .timeBased()
    .everyMinutes(10)
    .create();

  props.setProperty(AUTO_RUN_TRIGGER_KEY, trigger.getUniqueId());
  Logger.log('[AutoRun] Started — mode: STAGE1, trigger: ' + trigger.getUniqueId());

  ui.alert(
    'Overnight run started!\n\n' +
    'Stage 1 → Scoring will chain automatically.\n' +
    'You can close this tab — the pipeline runs on Google\'s servers.\n\n' +
    'Check PIPELINE_SUMMARY for progress anytime.'
  );

  // Fire immediately — don't wait 10 minutes for the first execution
  autoRunHandler();
}


function stopAutoRun() {
  var wasActive = deleteAutoRunTrigger_();
  var ui        = SpreadsheetApp.getUi();
  if (wasActive) {
    ui.alert('Auto-run stopped.\n\nPipeline is paused at its last checkpoint.\nRun "Start Overnight Run" again to resume.');
  } else {
    ui.alert('No active auto-run found.');
  }
}


// ── GAS trigger target ──────────────────────────────────────
// Called every 10 minutes while the auto-run is active.
// Reads PIPELINE_MODE and calls the correct pipeline function.
// Do NOT rename — the trigger is registered against this name.
function autoRunHandler() {
  var mode = PropertiesService.getScriptProperties().getProperty(PIPELINE_MODE_KEY);
  Logger.log('[AutoRun] Handler fired — mode: ' + (mode || 'none'));

  if      (mode === 'STAGE1')  runInitialPipeline();
  else if (mode === 'SCORING') runFinalScoringPipeline();
  else    Logger.log('[AutoRun] No active mode — nothing to do');
}


// ── Internal helper ─────────────────────────────────────────
// Called at scoring completion and by stopAutoRun().
// Returns true if a trigger was found and deleted.
function deleteAutoRunTrigger_() {
  var props     = PropertiesService.getScriptProperties();
  var triggerId = props.getProperty(AUTO_RUN_TRIGGER_KEY);
  var deleted   = false;

  if (triggerId) {
    ScriptApp.getProjectTriggers().forEach(function(t) {
      if (t.getUniqueId() === triggerId) {
        ScriptApp.deleteTrigger(t);
        deleted = true;
        Logger.log('[AutoRun] Trigger deleted: ' + triggerId);
      }
    });
    props.deleteProperty(AUTO_RUN_TRIGGER_KEY);
  }

  props.deleteProperty(PIPELINE_MODE_KEY);
  return deleted;
}


// ===== FILE: CircuitBreaker.js =====
// ============================================================
// CircuitBreaker.js
// Tracks consecutive API failures for Gemini and Serper.
// After N consecutive failures on one API, sets a halt flag,
// and schedules a timed trigger to auto-resume the pipeline
// after a cooldown period.
//
// Public surface:
//   CircuitBreaker.isHalted(api)      fast in-memory check
//   CircuitBreaker.recordSuccess(api) resets consecutive counter
//   CircuitBreaker.recordFailure(api) increments; halts at threshold
//   CircuitBreaker.reset(api)         clears halt (called by resume handler)
//   resumeAfterCircuitBreaker()       global — GAS trigger handler
// ============================================================

var CircuitBreaker = (function() {

  var CB_STATE_KEY = 'CB_STATE';

  // In-memory cache — loaded once per execution from PropertiesService.
  // Avoids a PropertiesService read on every API call.
  var _state = null;

  function defaultState_() {
    return {
      GEMINI: { consecutive: 0, halted: false, haltedAt: '' },
      SERPER: { consecutive: 0, halted: false, haltedAt: '' },
    };
  }

  function loadState_() {
    if (_state) return _state;
    try {
      var raw = PropertiesService.getScriptProperties().getProperty(CB_STATE_KEY);
      _state  = raw ? JSON.parse(raw) : defaultState_();
    } catch(e) {
      _state = defaultState_();
    }
    // Guard against stale schema missing one of the keys
    if (!_state.GEMINI) _state.GEMINI = defaultState_().GEMINI;
    if (!_state.SERPER) _state.SERPER = defaultState_().SERPER;
    return _state;
  }

  function saveState_() {
    try {
      PropertiesService.getScriptProperties().setProperty(CB_STATE_KEY, JSON.stringify(_state));
    } catch(e) {
      Logger.log('[CircuitBreaker] saveState_ error: ' + e.message);
    }
  }

  function inferResumeFn_() {
    // CURRENT_RUN_ID is set in main.js — prefix tells us which pipeline is running.
    if (typeof CURRENT_RUN_ID === 'string' && CURRENT_RUN_ID.startsWith('SC')) {
      return 'runFinalScoringPipeline';
    }
    return 'runInitialPipeline';
  }

  function scheduleResumeTrigger_(resumeFn) {
    try {
      var cooldownMs = CONFIG.CIRCUIT_BREAKER.COOLDOWN_MINUTES * 60 * 1000;
      var trigger    = ScriptApp.newTrigger('resumeAfterCircuitBreaker')
        .timeBased()
        .after(cooldownMs)
        .create();
      var props = PropertiesService.getScriptProperties();
      props.setProperty('CB_RESUME_FN',   resumeFn);
      props.setProperty('CB_TRIGGER_ID',  trigger.getUniqueId());
      Logger.log('[CircuitBreaker] Resume trigger scheduled: ' + resumeFn +
        ' in ' + CONFIG.CIRCUIT_BREAKER.COOLDOWN_MINUTES + ' min' +
        ' (trigger: ' + trigger.getUniqueId() + ')');
    } catch(e) {
      Logger.log('[CircuitBreaker] scheduleResumeTrigger_ error: ' + e.message);
    }
  }

  // ── Public API ──────────────────────────────────────────────

  function isHalted(api) {
    var s = loadState_();
    return !!(s[api] && s[api].halted);
  }

  function recordSuccess(api) {
    var s = loadState_();
    if (!s[api] || s[api].consecutive === 0) return; // nothing to reset
    s[api].consecutive = 0;
    saveState_();
  }

  function recordFailure(api) {
    var s = loadState_();
    if (!s[api] || s[api].halted) return; // already halted — don't double-schedule

    s[api].consecutive++;
    var threshold = api === 'GEMINI'
      ? CONFIG.CIRCUIT_BREAKER.GEMINI_THRESHOLD
      : CONFIG.CIRCUIT_BREAKER.SERPER_THRESHOLD;

    Logger.log('[CircuitBreaker] ' + api + ' consecutive failures: ' +
      s[api].consecutive + '/' + threshold);

    if (s[api].consecutive >= threshold) {
      s[api].halted   = true;
      s[api].haltedAt = new Date().toISOString();
      saveState_();
      Logger.log('[CircuitBreaker] HALT — ' + api + ' threshold reached');
      scheduleResumeTrigger_(inferResumeFn_());
    } else {
      saveState_();
    }
  }

  function reset(api) {
    var s = loadState_();
    if (!s[api]) return;
    s[api] = { consecutive: 0, halted: false, haltedAt: '' };
    saveState_();
    Logger.log('[CircuitBreaker] ' + api + ' reset');
  }

  return {
    isHalted:      isHalted,
    recordSuccess: recordSuccess,
    recordFailure: recordFailure,
    reset:         reset,
  };

})();


// ============================================================
// TRIGGER HANDLER — called by GAS after the cooldown period.
// Deletes itself, resets both breakers, restarts the pipeline.
// The checkpoint saved when the breaker tripped ensures the
// pipeline resumes from the correct company index.
// ============================================================

// ============================================================
// TEST — run from the Apps Script editor (no API calls needed).
// Simulates failures directly against the module's public API.
// Cleans up after itself: deletes any test trigger created,
// and restores whatever CB_STATE was in place before the test.
// ============================================================

function testCircuitBreaker() {
  Logger.log('=== testCircuitBreaker START ===\n');
  var passed = 0;
  var failed = 0;

  function assert(label, condition) {
    if (condition) { Logger.log('PASS — ' + label); passed++; }
    else           { Logger.log('FAIL — ' + label); failed++; }
  }

  var props = PropertiesService.getScriptProperties();

  // Save pre-test state so we can restore it cleanly
  var savedState     = props.getProperty('CB_STATE');
  var savedResumeFn  = props.getProperty('CB_RESUME_FN');
  var savedTriggerId = props.getProperty('CB_TRIGGER_ID');

  try {

    // ── Test 1: reset leaves both breakers clear ──────────────
    CircuitBreaker.reset('GEMINI');
    CircuitBreaker.reset('SERPER');
    assert('GEMINI not halted after reset', !CircuitBreaker.isHalted('GEMINI'));
    assert('SERPER not halted after reset', !CircuitBreaker.isHalted('SERPER'));

    // ── Test 2: counter increments but does not halt early ────
    var gThreshold = CONFIG.CIRCUIT_BREAKER.GEMINI_THRESHOLD;
    for (var i = 0; i < gThreshold - 1; i++) CircuitBreaker.recordFailure('GEMINI');
    assert('GEMINI not halted with ' + (gThreshold - 1) + ' failures (below threshold)',
      !CircuitBreaker.isHalted('GEMINI'));

    // ── Test 3: halts exactly at threshold ────────────────────
    CircuitBreaker.recordFailure('GEMINI'); // Nth failure
    assert('GEMINI halted at threshold (' + gThreshold + ' failures)',
      CircuitBreaker.isHalted('GEMINI'));

    // ── Test 4: PropertiesService state written correctly ─────
    var rawState = props.getProperty('CB_STATE');
    var cbState  = rawState ? JSON.parse(rawState) : null;
    assert('CB_STATE written to PropertiesService', !!cbState);
    assert('CB_STATE.GEMINI.halted = true', !!(cbState && cbState.GEMINI && cbState.GEMINI.halted));
    assert('CB_STATE.GEMINI.consecutive >= threshold',
      !!(cbState && cbState.GEMINI && cbState.GEMINI.consecutive >= gThreshold));

    // ── Test 5: resume function persisted ─────────────────────
    var resumeFn = props.getProperty('CB_RESUME_FN');
    assert('CB_RESUME_FN saved to PropertiesService', !!resumeFn);
    Logger.log('    CB_RESUME_FN = ' + resumeFn);

    // ── Test 6: time-based trigger actually created ───────────
    var triggerId = props.getProperty('CB_TRIGGER_ID');
    assert('CB_TRIGGER_ID saved', !!triggerId);
    var triggerExists = ScriptApp.getProjectTriggers().some(function(t) {
      return t.getUniqueId() === triggerId;
    });
    assert('Time-based trigger exists in ScriptApp', triggerExists);
    Logger.log('    Trigger ID = ' + triggerId);

    // ── Test 7: recordSuccess resets counter ──────────────────
    CircuitBreaker.reset('SERPER');
    for (var j = 0; j < 3; j++) CircuitBreaker.recordFailure('SERPER');
    var stateBeforeSuccess = JSON.parse(props.getProperty('CB_STATE') || '{}');
    assert('SERPER counter = 3 before success',
      stateBeforeSuccess.SERPER && stateBeforeSuccess.SERPER.consecutive === 3);
    CircuitBreaker.recordSuccess('SERPER');
    var stateAfterSuccess = JSON.parse(props.getProperty('CB_STATE') || '{}');
    assert('SERPER counter = 0 after success',
      stateAfterSuccess.SERPER && stateAfterSuccess.SERPER.consecutive === 0);
    assert('SERPER not halted after success reset (was below threshold)',
      !CircuitBreaker.isHalted('SERPER'));

    // ── Test 8: double-halt does not schedule a second trigger ─
    var triggerCountBefore = ScriptApp.getProjectTriggers().length;
    CircuitBreaker.recordFailure('GEMINI'); // already halted — should be a no-op
    var triggerCountAfter  = ScriptApp.getProjectTriggers().length;
    assert('No second trigger scheduled when already halted',
      triggerCountBefore === triggerCountAfter);

    // ── Cleanup: delete the test trigger ─────────────────────
    ScriptApp.getProjectTriggers().forEach(function(t) {
      if (t.getUniqueId() === triggerId) {
        ScriptApp.deleteTrigger(t);
        Logger.log('\n    [cleanup] test trigger deleted');
      }
    });

  } catch(e) {
    Logger.log('ERROR during test: ' + e.message);
  }

  // Always restore original state
  CircuitBreaker.reset('GEMINI');
  CircuitBreaker.reset('SERPER');
  if (savedState)     props.setProperty('CB_STATE',     savedState);
  else                props.deleteProperty('CB_STATE');
  if (savedResumeFn)  props.setProperty('CB_RESUME_FN', savedResumeFn);
  else                props.deleteProperty('CB_RESUME_FN');
  if (savedTriggerId) props.setProperty('CB_TRIGGER_ID', savedTriggerId);
  else                props.deleteProperty('CB_TRIGGER_ID');

  Logger.log('\n=== RESULT: ' + passed + ' passed, ' + failed + ' failed ===');
  Logger.log('=== testCircuitBreaker COMPLETE ===');
}


// ============================================================
function resumeAfterCircuitBreaker() {
  Logger.log('[CircuitBreaker] auto-resume trigger fired');

  var props = PropertiesService.getScriptProperties();

  // Delete this one-shot trigger so it never fires again
  var savedId = props.getProperty('CB_TRIGGER_ID');
  if (savedId) {
    ScriptApp.getProjectTriggers().forEach(function(t) {
      if (t.getUniqueId() === savedId) {
        ScriptApp.deleteTrigger(t);
        Logger.log('[CircuitBreaker] trigger deleted: ' + savedId);
      }
    });
    props.deleteProperty('CB_TRIGGER_ID');
  }

  // Reset both breakers (clears halted flag + consecutive counter)
  CircuitBreaker.reset('GEMINI');
  CircuitBreaker.reset('SERPER');
  props.deleteProperty('CB_RESUME_FN');

  // Do NOT call the pipeline here — autoRunHandler fires every 10 minutes and will
  // pick up automatically now that the breakers are clear. Calling the pipeline
  // directly here causes autoRunHandler to also fire (within 10 min) and both
  // scripts hit the same rate-limited APIs simultaneously, re-tripping the breaker.
  Logger.log('[CircuitBreaker] Both breakers reset. autoRunHandler will resume on its next fire (within 10 min).');
}


// ===== FILE: Cleanup.js =====
// ============================================================
// Cleanup.js
// ONE-OFF script to fix data corrupted by the Serper "Not enough
// credits" outage — the free-tier key ran out of credits, every
// Serper call returned HTTP 400, and the pipeline silently
// recorded that as Stage1 FAIL ("no evidence found") instead of
// recognizing the API never actually ran.
//
// purgeFalseFails() finds those false-FAIL rows and requeues the
// companies for a real attempt. A row is flagged ONLY when:
//   1. status === FAIL, AND
//   2. failReason is one that can ONLY be produced by empty
//      search text (i.e. could mean "genuinely found nothing"
//      OR "API call never ran" — ambiguous from the row alone), AND
//   3. SEARCH_CACHE has NO entry at all for that company+query.
//      saveToCache() only ever runs after a successful (200) call,
//      even when the result is empty — so a missing cache row is
//      proof the call never completed, not that it came back empty.
//
// Genuine Stage1 fails (e.g. "Revenue band rejected: <50Cr", or
// "CRO/service detected: ...") are never touched — those reasons
// require real matched data and can't be produced by an API
// failure.
//
// Run with no args (or `true`) first — DRY RUN, logs what would
// happen without changing anything. Review the log, then run
// purgeFalseFails(false) to actually execute.
// ============================================================

// The Run dropdown in the Apps Script editor always calls the
// selected function with zero arguments, so purgeFalseFails(false)
// can't be invoked directly from the UI. Select THIS function
// instead to actually execute the purge.
function purgeFalseFails_EXECUTE() {
  purgeFalseFails(false);
}

function purgeFalseFails(dryRun) {
  if (dryRun === undefined) dryRun = true;
  Logger.log('=== purgeFalseFails START ' + (dryRun ? '(DRY RUN — nothing will be changed)' : '(LIVE — will modify the sheet)') + ' ===');

  var ss          = SpreadsheetApp.getActiveSpreadsheet();
  var stage1Sheet = ss.getSheetByName(SHEETS.STAGE1);
  var cacheSheet  = ss.getSheetByName(SHEETS.CACHE);

  if (!stage1Sheet || stage1Sheet.getLastRow() < 2) {
    Logger.log('[purgeFalseFails] STAGE1_RESULTS empty or missing — nothing to do.');
    return;
  }
  if (!cacheSheet || cacheSheet.getLastRow() < 2) {
    Logger.log('[purgeFalseFails] SEARCH_CACHE empty or missing — cannot verify safely, aborting.');
    return;
  }

  // ── Build "company|QUERYTYPE" set of every query that actually
  //    got a live 200 response. saveToCache() only runs on success,
  //    even when the result itself is empty. ────────────────────
  var cacheRows = cacheSheet.getRange(2, 1, cacheSheet.getLastRow() - 1, 2).getValues();
  var attempted = new Set();
  cacheRows.forEach(function(row) {
    var name  = String(row[0] || '').trim().toLowerCase();
    var qtype = String(row[1] || '').trim().toUpperCase();
    if (name && qtype) attempted.add(name + '|' + qtype);
  });
  Logger.log('[purgeFalseFails] ' + attempted.size + ' attempted (company|queryType) pairs found in SEARCH_CACHE.');

  // ── Scan STAGE1_RESULTS for false-FAILs ────────────────────────
  var lastRow = stage1Sheet.getLastRow();
  var numCols = stage1Sheet.getLastColumn();
  var data    = stage1Sheet.getRange(2, 1, lastRow - 1, numCols).getValues();

  var rowsToDelete    = []; // sheet row numbers, 1-indexed
  var purgedCompanies = []; // exact company strings

  data.forEach(function(row, idx) {
    var company    = String(row[0]  || '').trim();
    var status     = String(row[9]  || '').trim();
    var failReason = String(row[10] || '').trim();
    if (!company || status !== 'FAIL') return;

    var nameKey    = company.toLowerCase();
    var isFalseFail = false;

    if (failReason === 'No revenue evidence found') {
      isFalseFail = !attempted.has(nameKey + '|REVENUE_DIRECT');
    } else if (failReason === 'No manufacturing signal found') {
      isFalseFail = !attempted.has(nameKey + '|STAGE1_MFG');
    }

    if (isFalseFail) {
      rowsToDelete.push(idx + 2); // +2: 0-indexed array + header row
      purgedCompanies.push(company);
    }
  });

  Logger.log('[purgeFalseFails] Found ' + rowsToDelete.length + ' false-FAIL rows.');
  if (!rowsToDelete.length) {
    Logger.log('[purgeFalseFails] Nothing to purge. Done.');
    return;
  }
  Logger.log('[purgeFalseFails] Companies: ' + purgedCompanies.join(', '));

  // ── Figure out the checkpoint rollback target regardless of
  //    dry-run, so the dry-run log shows the full intended effect ──
  var companies = getCompanies();
  var purgedSet = new Set(purgedCompanies.map(function(c) { return c.trim().toLowerCase(); }));
  var minIndex  = null;
  companies.forEach(function(c, i) {
    if (purgedSet.has(c.company.trim().toLowerCase())) {
      if (minIndex === null || i < minIndex) minIndex = i;
    }
  });
  var currentCheckpoint = getCheckpoint();

  if (dryRun) {
    Logger.log('[purgeFalseFails] DRY RUN — would delete ' + rowsToDelete.length + ' rows from STAGE1_RESULTS.');
    Logger.log('[purgeFalseFails] DRY RUN — would delete any matching SEARCH_CACHE rows for these companies.');
    if (minIndex !== null) {
      Logger.log('[purgeFalseFails] DRY RUN — earliest purged company is at MASTER index ' + minIndex +
        '. Current checkpoint: ' + currentCheckpoint + '.' +
        (minIndex < currentCheckpoint ? ' Would roll checkpoint back to ' + minIndex + '.' : ' Checkpoint already covers this range — no rollback needed.'));
    } else {
      Logger.log('[purgeFalseFails] DRY RUN — WARNING: could not find purged companies in MASTER list.');
    }
    Logger.log('[purgeFalseFails] Run purgeFalseFails(false) to execute for real.');
    Logger.log('=== purgeFalseFails DRY RUN COMPLETE ===');
    return;
  }

  // ── 1. Delete the false-FAIL rows from STAGE1_RESULTS ──────────
  // (descending order so earlier deletions don't shift later row numbers)
  rowsToDelete.sort(function(a, b) { return b - a; });
  rowsToDelete.forEach(function(rowNum) { stage1Sheet.deleteRow(rowNum); });
  Logger.log('[purgeFalseFails] Deleted ' + rowsToDelete.length + ' rows from STAGE1_RESULTS.');

  // ── 2. Delete any partial/orphaned SEARCH_CACHE rows for the
  //    same companies, so there's zero stale residue ─────────────
  var cacheLastRow = cacheSheet.getLastRow();
  if (cacheLastRow >= 2) {
    var cacheNameCol = cacheSheet.getRange(2, 1, cacheLastRow - 1, 1).getValues();
    var cacheRowsToDelete = [];
    cacheNameCol.forEach(function(row, idx) {
      var name = String(row[0] || '').trim().toLowerCase();
      if (purgedSet.has(name)) cacheRowsToDelete.push(idx + 2);
    });
    cacheRowsToDelete.sort(function(a, b) { return b - a; });
    cacheRowsToDelete.forEach(function(rowNum) { cacheSheet.deleteRow(rowNum); });
    Logger.log('[purgeFalseFails] Deleted ' + cacheRowsToDelete.length + ' stray SEARCH_CACHE rows for purged companies.');
  }

  // ── 3. Roll back the pipeline checkpoint. It's a numeric index
  //    into the MASTER list, NOT derived from STAGE1_RESULTS row
  //    count — deleting rows alone does not make the loop revisit
  //    them, since the loop only ever walks index >= checkpoint ──
  if (minIndex !== null) {
    Logger.log('[purgeFalseFails] Earliest purged company is at MASTER index ' + minIndex +
      '. Current checkpoint: ' + currentCheckpoint + '.');
    if (minIndex < currentCheckpoint) {
      saveCheckpoint(minIndex);
      Logger.log('[purgeFalseFails] Checkpoint rolled back to ' + minIndex + ' — purged companies will be revisited on next run.');
    } else {
      Logger.log('[purgeFalseFails] Checkpoint already before purged range — no rollback needed.');
    }
  } else {
    Logger.log('[purgeFalseFails] WARNING — could not find purged companies in MASTER list. Checkpoint NOT adjusted — verify manually.');
  }

  Logger.log('[purgeFalseFails] Requeued ' + purgedCompanies.length + ' companies for reprocessing.');
  Logger.log('=== purgeFalseFails COMPLETE ===');
}


// ===== FILE: CostSummary.js =====
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


// ===== FILE: DiagnoseCorruption.js =====
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


// ===== FILE: EventLog.js =====
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
    error: function (runId, company, website, stage, outcome, message) { batchFailuresPush_(company, website, stage, message); write_(runId, company, website, stage, 'ERROR', outcome, message); },
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


// ===== FILE: Menu.js =====
// ============================================================
// Menu.js
// Custom menu for the ICP Pipeline spreadsheet.
// onOpen() is an Apps Script simple trigger — runs automatically
// whenever the spreadsheet is opened.
// Add new menu items here as features are built.
// ============================================================

function onOpen() {
  SpreadsheetApp.getUi()
    .createMenu('ICP Pipeline')
    .addItem('Start Overnight Run',      'startAutoRun')
    .addItem('Stop Auto-Run',            'stopAutoRun')
    .addSeparator()
    .addItem('Run Stage 1 Pipeline',     'runInitialPipeline')
    .addItem('Run Scoring Pipeline',     'runFinalScoringPipeline')
    .addItem('Build Shortlist',          'buildShortlist')
    .addItem('Mark EST_MISTAKE in Shortlist', 'markEstMistakeInShortlist')
    .addSeparator()
    .addItem('Refresh Pipeline Summary', 'buildPipelineSummary')
    .addItem('Show Cost Summary',        'buildCostSummary')
    .addItem('Show Batch Failures',      'showBatchFailures')
    .addSeparator()
    .addItem('Reset Checkpoint',         'resetAndRunFresh')
    .addToUi();
}


// ===== FILE: PipelineSummary.js =====
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
    var revPass = 0, g1Pass = 0, g2Pass = 0, g3Pass = 0;
    var manualReview = 0, failed = 0, errors = 0, pendingRev = 0;

    s1Rows.forEach(function(row) {
      var band   = String(row[5] || '').trim();
      var mfr    = String(row[3] || '').trim();
      var acq    = String(row[4] || '').trim();
      var status = String(row[9] || '').trim();
      if (CONFIG.PIPELINE.STAGE1_PASS_BANDS.indexOf(band) !== -1) revPass++;
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
    r = psDataRow_(sheet, r, '  Gate 1 — Revenue PASS',      revPass, psFmt_(revPass, processed));
    r = psDataRow_(sheet, r, '  Gate 2 — Manufacturer Pass', g1Pass,  psFmt_(g1Pass, revPass));
    r = psDataRow_(sheet, r, '  Gate 3 — Not Acquired',      g2Pass,  psFmt_(g2Pass, g1Pass));
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

// ============================================================
// testStage1Counts
// Independent sanity check — recomputes the funnel counts with
// explicit AND-conditions on every row (does NOT trust gate
// sequencing the way buildPipelineSummary's g1Pass/g2Pass do).
// Run this whenever the dashboard numbers look off.
// ============================================================
function testStage1Counts() {
  Logger.log('=== testStage1Counts START ===');

  var ss          = SpreadsheetApp.getActiveSpreadsheet();
  var masterSheet = ss.getSheetByName(SHEETS.MASTER);
  var initial     = (masterSheet && masterSheet.getLastRow() > 1)
    ? masterSheet.getLastRow() - 1
    : 0;

  var s1Sheet = ss.getSheetByName(SHEETS.STAGE1);
  var s1Rows  = (s1Sheet && s1Sheet.getLastRow() > 1)
    ? s1Sheet.getRange(2, 1, s1Sheet.getLastRow() - 1, 11).getValues()
    : [];

  var revenuePassed     = 0;
  var manufacturerPassed = 0;
  var notAcquiredPassed  = 0;

  s1Rows.forEach(function(row) {
    var band = String(row[5] || '').trim();
    var mfr  = String(row[3] || '').trim();
    var acq  = String(row[4] || '').trim();

    var revOk = CONFIG.PIPELINE.STAGE1_PASS_BANDS.indexOf(band) !== -1;
    var mfrOk = revOk && mfr === 'YES';
    var acqOk = mfrOk && acq === 'NO';

    if (revOk) revenuePassed++;
    if (mfrOk) manufacturerPassed++;
    if (acqOk) notAcquiredPassed++;
  });

  Logger.log('1. Initial dataset:           ' + initial);
  Logger.log('2. Revenue passed:            ' + revenuePassed + ' (band in ' + CONFIG.PIPELINE.STAGE1_PASS_BANDS.join(',') + ')');
  Logger.log('3. + Manufacturer passed:     ' + manufacturerPassed + ' (revenue PASS AND mfr=YES)');
  Logger.log('4. + Not acquired:            ' + notAcquiredPassed + ' (revenue PASS AND mfr=YES AND acq=NO)');
  Logger.log('=== testStage1Counts COMPLETE ===');

  return { initial: initial, revenuePassed: revenuePassed, manufacturerPassed: manufacturerPassed, notAcquiredPassed: notAcquiredPassed };
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
  sheet.getRange(row, 2).setValue(count).setHorizontalAlignment('right').setNumberFormat('0');
  if (pctStr) sheet.getRange(row, 3).setValue(pctStr).setFontColor('#888888');
  return row + 1;
}

// Returns "X%" or "" when denominator is 0.
function psFmt_(num, denom) {
  if (!denom || denom === 0) return '';
  return Math.round(num / denom * 100) + '%';
}


// ===== FILE: RepairCorruption.js =====
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


// ===== FILE: SheetIO.js =====
// ============================================================
// SheetIO.gs — Sheet names and column indices for the pipeline
// All sheet I/O structure lives here. config.gs holds no
// sheet references — look here first for any sheet constant.
// ============================================================

// ----------------------------------------------------------
// SHEET NAMES
// Keys map to the actual tab names in the spreadsheet.
// ----------------------------------------------------------
const SHEETS = {
  MASTER:    "MASTER",
  STAGE1:    "STAGE1_RESULTS",
  CACHE:     "SEARCH_CACHE",
  SCORES:    "SCORES",
  SHORTLIST: "SHORTLIST",
};


// ----------------------------------------------------------
// MASTER SHEET COLUMNS
// Zero-based column indices for the MASTER input sheet.
// ----------------------------------------------------------
const MASTER_COLS = {
  COMPANY: 0,
  WEBSITE: 1,
  SOURCE:  2,
};


// ===== FILE: TokenLog.js =====
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


// ===== FILE: ai.js =====
// ============================================================
// ai.gs — All API Calls for ICP Pipeline
// Handles: Serper search, Gemini inference, JSON parsing,
//          rate limiting, retry logic, cache integration.
// No sheet logic here. No scoring logic here.
// Just clean API calls that return data or null.
// ============================================================

// ============================================================
// SECTION 1 — ADAPTIVE RATE LIMITER
// Starts at CONFIG defaults each run; backs off on 429/503 and
// gradually speeds up on consecutive successes.
// All API callers use rateLimit() — never Utilities.sleep() directly.
// ============================================================

// Per-type sleep values — initialized lazily from CONFIG on first use.
var _adaptiveSleep = { GEMINI: null, SERPER: null };

function rateLimit(type) {
  var ms;
  if (type === 'GEMINI') {
    if (_adaptiveSleep.GEMINI === null) _adaptiveSleep.GEMINI = CONFIG.BATCH.GEMINI_SLEEP;
    ms = _adaptiveSleep.GEMINI;
  } else if (type === 'SERPER') {
    if (_adaptiveSleep.SERPER === null) _adaptiveSleep.SERPER = CONFIG.BATCH.SERPER_SLEEP;
    ms = _adaptiveSleep.SERPER;
  } else {
    ms = 1000;
  }
  Utilities.sleep(ms);
}

// Called when a 429 or 503 is received — increases sleep for future calls.
function rateLimitBackoff(type) {
  if (type !== 'GEMINI' && type !== 'SERPER') return;
  if (_adaptiveSleep[type] === null) {
    _adaptiveSleep[type] = type === 'GEMINI'
      ? CONFIG.BATCH.GEMINI_SLEEP
      : CONFIG.BATCH.SERPER_SLEEP;
  }
  var maxMs = type === 'GEMINI'
    ? CONFIG.ADAPTIVE_RATE.GEMINI_MAX_SLEEP
    : CONFIG.ADAPTIVE_RATE.SERPER_MAX_SLEEP;
  var prev = _adaptiveSleep[type];
  _adaptiveSleep[type] = Math.min(
    Math.round(prev * CONFIG.ADAPTIVE_RATE.BACKOFF_FACTOR),
    maxMs
  );
  if (_adaptiveSleep[type] !== prev) {
    Logger.log('[RateLimit] ' + type + ' backoff: ' + prev + 'ms → ' + _adaptiveSleep[type] + 'ms');
  }
}

// Called on a successful API response — gradually lowers sleep toward the floor.
function rateLimitSuccess(type) {
  if (type !== 'GEMINI' && type !== 'SERPER') return;
  if (_adaptiveSleep[type] === null) return;
  var minMs = type === 'GEMINI'
    ? CONFIG.ADAPTIVE_RATE.GEMINI_MIN_SLEEP
    : CONFIG.ADAPTIVE_RATE.SERPER_MIN_SLEEP;
  if (_adaptiveSleep[type] <= minMs) return;
  var prev = _adaptiveSleep[type];
  _adaptiveSleep[type] = Math.max(
    Math.round(prev * CONFIG.ADAPTIVE_RATE.DECAY_FACTOR),
    minMs
  );
  if (_adaptiveSleep[type] !== prev) {
    Logger.log('[RateLimit] ' + type + ' decay: ' + prev + 'ms → ' + _adaptiveSleep[type] + 'ms');
  }
}

// Returns the current adaptive sleep for a given type (used by tests).
function getRateLimitSleepMs(type) {
  if (_adaptiveSleep[type] === null) {
    return type === 'GEMINI' ? CONFIG.BATCH.GEMINI_SLEEP : CONFIG.BATCH.SERPER_SLEEP;
  }
  return _adaptiveSleep[type];
}


// ============================================================
// SECTION 2 — HTTP ERROR CLASSIFIER
// Tells callGeminiWithRetry whether to retry or bail.
// ============================================================

function getHttpErrorType(responseCode) {
  const code = parseInt(responseCode, 10);
  switch (code) {
    case 429: return "RATE_LIMIT";   // quota hit — retry with backoff
    case 500: return "SERVER_ERROR"; // transient Gemini error — retry
    case 503: return "SERVER_ERROR"; // service unavailable — retry
    case 400: return "BAD_REQUEST";  // bad prompt/payload — bail
    case 404: return "BAD_REQUEST";  // wrong endpoint — bail
    default:  return "UNKNOWN";      // anything else — bail
  }
}


// ============================================================
// SECTION 3 — SNIPPET BUILDER
// Converts Serper raw JSON response into a clean text string.
// Limits to 2500 chars to control Gemini token usage.
// ============================================================

function buildSnippetText(serperData) {
  if (!serperData || !serperData.organic) return "";

  const snippets = serperData.organic.slice(0, 8).map(item => {
    const title   = String(item.title   || "").trim();
    const snippet = String(item.snippet || "").trim();
    const link    = String(item.link    || "").trim();
    return `TITLE: ${title}\nSNIPPET: ${snippet}\nLINK: ${link}`;
  });

  const joined = snippets.join("\n\n");

  // Hard cap at 2500 chars — enough signal, controlled tokens
  return joined.length > 2500 ? joined.substring(0, 2500) : joined;
}


// ============================================================
// SECTION 4 — SERPER SEARCH
// Checks cache first. On miss: calls API, saves to cache.
// Returns snippet string or "" on failure.
// ============================================================

function callSerper(companyName, queryType) {

  // Step 1: Check cache
  const cached = getCachedSearch(companyName, queryType);
  if (cached) return cached; // cache hit — no API call needed

  if (CircuitBreaker.isHalted('SERPER')) {
    Logger.log(`callSerper: SERPER circuit open — skipping "${companyName}" | ${queryType}`);
    return "";
  }

  // Step 2: Build query from template
  const queryTemplate = CONFIG.QUERIES[queryType];
  if (!queryTemplate) {
    Logger.log(`callSerper: unknown queryType "${queryType}"`);
    return "";
  }
  const query = buildQuery(queryTemplate, companyName);

  // Step 3: Call Serper API
  const options = {
    method:  "post",
    headers: {
      "X-API-KEY":    CONFIG.KEYS.SERPER,
      "Content-Type": "application/json",
    },
    payload:            JSON.stringify({ q: query, num: 8 }),
    muteHttpExceptions: true, // prevents Apps Script from throwing on non-200
  };

  let snippetText = "";

  try {
    const response = UrlFetchApp.fetch("https://google.serper.dev/search", options);
    const code     = response.getResponseCode();

    if (code !== 200) {
      Logger.log(`callSerper: HTTP ${code} for "${companyName}" | ${queryType}`);
      CircuitBreaker.recordFailure('SERPER');
      rateLimitBackoff('SERPER');
      rateLimit("SERPER");
      return "";
    }

    const data       = JSON.parse(response.getContentText());
    const numResults = (data.organic || []).length;
    snippetText      = buildSnippetText(data);
    TokenLog.appendSerper(CURRENT_RUN_ID, companyName, queryType, numResults);
    CircuitBreaker.recordSuccess('SERPER');
    rateLimitSuccess('SERPER');

    if (!snippetText) {
      Logger.log(`callSerper: empty results for "${companyName}" | ${queryType}`);
    } else {
      Logger.log(`callSerper: OK for "${companyName}" | ${queryType} (${snippetText.length} chars)`);
    }

  } catch (e) {
    Logger.log(`callSerper: exception for "${companyName}" | ${queryType}: ${e.message}`);
    CircuitBreaker.recordFailure('SERPER');
    rateLimitBackoff('SERPER');
    rateLimit("SERPER");
    return "";
  }

  // Step 4: Save to cache (even if empty — prevents repeat failed calls)
  saveToCache(companyName, queryType, query, snippetText);

  // Step 5: Rate limit after live call
  rateLimit("SERPER");

  return snippetText;
}


// ============================================================
// SECTION 5 — GEMINI SINGLE CALL
// Makes one API call. Returns raw response text or null.
// Does NOT parse JSON — that's parseGeminiJSON()'s job.
// Always rate limits after call regardless of outcome.
// ============================================================

function callGemini(prompt) {
  const url = CONFIG.GEMINI.ENDPOINT + "?key=" + CONFIG.KEYS.GEMINI;

  const payload = {
    contents: [
      {
        parts: [{ text: prompt }],
      },
    ],
    generationConfig: {
      temperature:     CONFIG.GEMINI.TEMPERATURE,
      maxOutputTokens: CONFIG.GEMINI.MAX_TOKENS,
      thinkingConfig:  { thinkingBudget: 0 },
    },
  };

  const options = {
    method:             "post",
    contentType:        "application/json",
    payload:            JSON.stringify(payload),
    muteHttpExceptions: true,
  };

  let rawText = null;
  let usage   = { inputTokens: 0, outputTokens: 0, thinkingTokens: 0 };

  try {
    Logger.log(`callGemini: sending request to Gemini`);
    const response = UrlFetchApp.fetch(url, options);
    const code     = response.getResponseCode();

    if (code !== 200) {
      // Return the code as a special marker so callGeminiWithRetry can classify it
      Logger.log(`callGemini: HTTP ${code}`);
      Logger.log(response.getContentText());
      rateLimit("GEMINI");
      return { error: true, code: code };
    }

    const data = JSON.parse(response.getContentText());
    const meta = data.usageMetadata || {};
    usage = {
      inputTokens:    meta.promptTokenCount     || 0,
      outputTokens:   meta.candidatesTokenCount || 0,
      thinkingTokens: meta.thoughtsTokenCount   || 0,
    };

    // Extract text from Gemini response structure
    rawText = data?.candidates?.[0]?.content?.parts?.[0]?.text || null;

    if (!rawText) {
      Logger.log("callGemini: response parsed but text content empty");
    } else {
      Logger.log(`callGemini: OK (${rawText.length} chars)`);
    }

  } catch (e) {
    Logger.log(`callGemini: exception: ${e.message}`);
    rateLimit("GEMINI");
    return { error: true, code: "TIMEOUT", message: e.message };
  }

  rateLimit("GEMINI");
  return { text: rawText, usage };
}


// ============================================================
// SECTION 6 — GEMINI WITH RETRY
// Wraps callGemini with exponential backoff.
// Retries ONLY on: 429, 500, 503, timeout.
// Bails immediately on: 400, 404, empty response.
// Returns response text or null.
// ============================================================

function callGeminiWithRetry(prompt, ctx) {
  const company     = (ctx && ctx.company) || '';
  const stage       = (ctx && ctx.stage)   || 'unknown';

  if (CircuitBreaker.isHalted('GEMINI')) {
    Logger.log(`callGeminiWithRetry: GEMINI circuit open — skipping "${company}" | ${stage}`);
    return null;
  }

  const retrySleeps = CONFIG.BATCH.RETRY_SLEEPS; // [5000, 10000, 20000]
  const maxRetries  = CONFIG.BATCH.MAX_RETRIES;  // 3

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    const result = callGemini(prompt);

    // Error object — classify and decide
    if (result && result.error) {
      const errorType = getHttpErrorType(result.code);

      if (errorType === "BAD_REQUEST" || errorType === "UNKNOWN") {
        Logger.log(`callGeminiWithRetry: ${errorType} (${result.code}), not retrying.`);
        return null;
      }

      // RATE_LIMIT or SERVER_ERROR — increase adaptive sleep, then retry
      rateLimitBackoff('GEMINI');
      if (attempt < maxRetries) {
        const sleepMs = retrySleeps[attempt] || 20000;
        Logger.log(`callGeminiWithRetry: ${errorType} (${result.code}), attempt ${attempt + 1}/${maxRetries}. Waiting ${sleepMs}ms...`);
        Utilities.sleep(sleepMs);
        continue;
      }

      Logger.log(`callGeminiWithRetry: exhausted ${maxRetries} retries. Returning null.`);
      CircuitBreaker.recordFailure('GEMINI');
      return null;
    }

    // Success object { text, usage } from HTTP 200
    const text  = result.text;
    const usage = result.usage;

    if (typeof text === "string" && text.length > 0) {
      TokenLog.append(CURRENT_RUN_ID, company, stage, CONFIG.GEMINI.MODEL, usage);
      CircuitBreaker.recordSuccess('GEMINI');
      rateLimitSuccess('GEMINI');
      return text;
    }

    // Empty response — log tokens (wasted call) then bail
    TokenLog.append(CURRENT_RUN_ID, company, stage, CONFIG.GEMINI.MODEL, usage);
    Logger.log("callGeminiWithRetry: empty response, not retrying.");
    CircuitBreaker.recordSuccess('GEMINI'); // HTTP 200 — API is reachable
    rateLimitSuccess('GEMINI');
    return null;
  }

  return null;
}

// ============================================================
// SECTION 7 — JSON PARSER
// Three-layer extraction from Gemini response text.
// Returns parsed object or null — never throws.
//
// Layer 1: strip ```json markdown wrapper → try parse
// Layer 2: extract between first { and last } → try parse
// Layer 3: return null → caller uses safe default object
// ============================================================

function parseGeminiJSON(text) {
  if (!text || typeof text !== "string") return null;

  // Layer 1: strip markdown fences
  let cleaned = text
    .replace(/```json/gi, "")
    .replace(/```/g, "")
    .trim();

  // Layer 2: try direct parse
  try {
    return JSON.parse(cleaned);
  } catch(e1) {}

  // Layer 3: extract between first { and last }
  const start = cleaned.indexOf("{");
  const end   = cleaned.lastIndexOf("}");

  if (start !== -1 && end !== -1 && end > start) {
    try {
      return JSON.parse(cleaned.substring(start, end + 1));
    } catch(e2) {}
  }

  // Layer 4: normalize whitespace and retry
  try {
    const normalized = cleaned
      .replace(/[\r\n\t]/g, " ")  // replace newlines/tabs with spaces
      .replace(/\s+/g, " ")       // collapse multiple spaces
      .trim();
    const s = normalized.indexOf("{");
    const e = normalized.lastIndexOf("}");
    if (s !== -1 && e !== -1) {
      return JSON.parse(normalized.substring(s, e + 1));
    }
  } catch(e3) {}

  // Layer 5: TRUNCATION REPAIR
  try {
    const s = cleaned.indexOf("{");
    if (s !== -1) {
      let partial = cleaned.substring(s);

      // Strategy 1: find last COMPLETE key-value pair
      // A complete pair ends with: ,"  or  "}
      // Look for last occurrence of a closing quote before a comma+quote or end
      const completePattern = /^(\{(?:(?:"[^"]+"\s*:\s*"[^"]*"\s*,\s*)*"[^"]+"\s*:\s*"[^"]*"))/.exec(partial);
      if (completePattern) {
        try { return JSON.parse(completePattern[1] + "}"); } catch(e) {}
      }

      // Strategy 2: walk backwards from end, find last ," boundary
      // Works for both short keys (C3) and long values (C4)
      let cutPoint = partial.length;
      while (cutPoint > 0) {
        cutPoint = partial.lastIndexOf('",', cutPoint - 1);
        if (cutPoint === -1) break;
        const candidate = partial.substring(0, cutPoint) + '"}';
        try { return JSON.parse(candidate); } catch(e) { continue; }
      }

      // Strategy 3: drop entire last field including its key
      // Handles: ..., "key": "truncated value  (no closing quote)
      const lastFieldStart = partial.lastIndexOf(',"');
      if (lastFieldStart > 0) {
        const candidate = partial.substring(0, lastFieldStart) + "}";
        try { return JSON.parse(candidate); } catch(e) {}
      }
    }
  } catch(e5) {}

  Logger.log(`parseGeminiJSON: all layers failed. Raw text: ${text.substring(0, 200)}`);
  return null;
}


// ===========================================================
// SECTION 7.5 — inferRevenueWithGeminiHelper() lives in revenue.gs
// (kept alongside inferRevenueWithGemini() — same domain, same file)
// ===========================================================

// ============================================================
// SECTION 7.6 — SERPER CONNECTION TEST
// Standalone — bypasses cache, circuit breaker, and rate limiter.
// Makes exactly ONE Serper call and logs the full response body
// so the real error (quota/credits/key issue) is visible, not
// just the HTTP status code.
// Select "testSerperConnection" from dropdown and hit Run.
// ============================================================

function testSerperConnection() {
  Logger.log("=== testSerperConnection START ===");

  const key = CONFIG.KEYS.SERPER;
  if (!key) {
    Logger.log("FAIL — SERPER_API_KEY is missing from Script Properties.");
    return;
  }
  Logger.log("Key present — length " + key.length + ", starts with: " + key.substring(0, 4) + "...");

  const options = {
    method:             "post",
    headers: {
      "X-API-KEY":    key,
      "Content-Type": "application/json",
    },
    payload:            JSON.stringify({ q: "Tata Motors", num: 3 }),
    muteHttpExceptions: true,
  };

  try {
    const response = UrlFetchApp.fetch("https://google.serper.dev/search", options);
    const code = response.getResponseCode();
    const body = response.getContentText();

    Logger.log("HTTP status: " + code);
    Logger.log("Response body: " + body);

    if (code === 200) {
      Logger.log("RESULT: PASS — Serper is working normally.");
    } else if (code === 400) {
      Logger.log("RESULT: FAIL — HTTP 400. Check response body above — usually means out of credits/quota, or a malformed key.");
    } else if (code === 401 || code === 403) {
      Logger.log("RESULT: FAIL — HTTP " + code + ". API key is invalid, revoked, or unauthorized.");
    } else if (code === 429) {
      Logger.log("RESULT: FAIL — HTTP 429. Rate limited (this is different from quota exhaustion).");
    } else {
      Logger.log("RESULT: FAIL — unexpected HTTP " + code + ". See response body above.");
    }
  } catch (e) {
    Logger.log("RESULT: FAIL — exception: " + e.message);
  }

  Logger.log("=== testSerperConnection COMPLETE ===");
}


// ============================================================
// SECTION 8 — TEST FUNCTION
// Run this to verify both APIs work before running pipeline.
// Select "testAI" from dropdown and hit Run.
// Check Execution Log for results.
// ============================================================

function testAI() {
  Logger.log("=== testAI() start ===");
  Logger.log("Test company: Avra Synthesis");

  // --- Test 1: Serper ---
  Logger.log("\n--- Test 1: Serper (C3 query) ---");
  const snippets = callSerper("Avra Synthesis", "C3");

  if (snippets && snippets.length > 50) {
    Logger.log(`Serper: PASS — got ${snippets.length} chars`);
    Logger.log(`Preview: ${snippets.substring(0, 300)}...`);
  } else {
    Logger.log("Serper: FAIL — empty or too short. Check SERPER API key in config.gs");
  }

  // --- Test 2: Gemini JSON parsing ---
  Logger.log("\n--- Test 2: Gemini C3 call ---");

  if (!snippets || snippets.length < 50) {
    Logger.log("Skipping Gemini test — no Serper evidence to send.");
  } else {
    const prompt = buildPrompt("C3", "Avra Synthesis", snippets);
    const raw    = callGeminiWithRetry(prompt, { company: 'Avra Synthesis', stage: 'test-c3' });

    if (!raw) {
      Logger.log("Gemini: FAIL — null response. Check GEMINI API key in config.gs");
    } else {
      Logger.log(`Gemini raw response (first 300 chars): ${raw.substring(0, 300)}`);

      Logger.log(`Full raw length: ${raw.length}`);
      Logger.log(`Full raw: ${raw}`);
      const parsed = parseGeminiJSON(raw);
      if (parsed) {
        Logger.log("JSON parsing: PASS");
        Logger.log(`Parsed result: ${JSON.stringify(parsed)}`);
      } else {
        Logger.log("JSON parsing: FAIL — parseGeminiJSON returned null");
        Logger.log("This means Gemini returned something unparseable. Check raw response above.");
      }
    }
  }

  // --- Test 3: JSON repair test ---
  Logger.log("\n--- Test 3: parseGeminiJSON repair layers ---");

  const testCases = [
    {
      label: "Clean JSON",
      input: '{"Patents": "Strong", "DSIR": "Absent"}',
    },
    {
      label: "Markdown wrapped",
      input: '```json\n{"Patents": "Weak", "DSIR": "Absent"}\n```',
    },
    {
      label: "Text before/after",
      input: 'Sure! Here is the result:\n{"Patents": "Absent"}\nHope that helps!',
    },
    {
      label: "Total garbage",
      input: "Sorry, I cannot process this request.",
    },
  ];

  testCases.forEach(({ label, input }) => {
    const result = parseGeminiJSON(input);
    Logger.log(`  ${label}: ${result ? "PASS → " + JSON.stringify(result) : "null (Layer 3 fallback)"}`);
  });

  Logger.log("\n=== testAI() complete ===");
}


// ============================================================
// SECTION 9 — ADAPTIVE RATE LIMITER TEST
// No API calls or sleeping — manipulates _adaptiveSleep directly.
// Run from the Apps Script editor; check Execution log.
// ============================================================

function testAdaptiveRateLimiting() {
  Logger.log('=== testAdaptiveRateLimiting START ===\n');
  var passed = 0;
  var failed = 0;

  function assert(label, condition) {
    if (condition) { Logger.log('PASS — ' + label); passed++; }
    else           { Logger.log('FAIL — ' + label); failed++; }
  }

  // Save whatever was in place before the test
  var origGemini = _adaptiveSleep.GEMINI;
  var origSerper = _adaptiveSleep.SERPER;

  // Start from known defaults
  _adaptiveSleep.GEMINI = CONFIG.BATCH.GEMINI_SLEEP;
  _adaptiveSleep.SERPER = CONFIG.BATCH.SERPER_SLEEP;
  var gStart = _adaptiveSleep.GEMINI;
  var sStart = _adaptiveSleep.SERPER;
  Logger.log('  Starting GEMINI=' + gStart + 'ms  SERPER=' + sStart + 'ms\n');

  // ── Test 1: backoff increases sleep ────────────────────────
  rateLimitBackoff('GEMINI');
  var gAfter = _adaptiveSleep.GEMINI;
  assert('GEMINI sleep increases after backoff', gAfter > gStart);
  assert('GEMINI backoff = round(start × BACKOFF_FACTOR)',
    gAfter === Math.min(
      Math.round(gStart * CONFIG.ADAPTIVE_RATE.BACKOFF_FACTOR),
      CONFIG.ADAPTIVE_RATE.GEMINI_MAX_SLEEP
    ));
  Logger.log('  GEMINI: ' + gStart + ' → ' + gAfter + 'ms');

  // ── Test 2: success reduces sleep ──────────────────────────
  rateLimitSuccess('GEMINI');
  var gDecayed = _adaptiveSleep.GEMINI;
  assert('GEMINI sleep decreases after success', gDecayed < gAfter);
  Logger.log('  GEMINI: ' + gAfter + ' → ' + gDecayed + 'ms');

  // ── Test 3: many successes hit the floor ───────────────────
  for (var i = 0; i < 200; i++) rateLimitSuccess('GEMINI');
  assert('GEMINI hits floor after many successes',
    _adaptiveSleep.GEMINI === CONFIG.ADAPTIVE_RATE.GEMINI_MIN_SLEEP);
  Logger.log('  GEMINI floor = ' + _adaptiveSleep.GEMINI + 'ms');

  // ── Test 4: success is a no-op at floor ────────────────────
  var atFloor = _adaptiveSleep.GEMINI;
  rateLimitSuccess('GEMINI');
  assert('GEMINI unchanged at floor', _adaptiveSleep.GEMINI === atFloor);

  // ── Test 5: many backoffs hit the ceiling ──────────────────
  for (var j = 0; j < 30; j++) rateLimitBackoff('GEMINI');
  assert('GEMINI hits ceiling after many backoffs',
    _adaptiveSleep.GEMINI === CONFIG.ADAPTIVE_RATE.GEMINI_MAX_SLEEP);
  Logger.log('  GEMINI ceiling = ' + _adaptiveSleep.GEMINI + 'ms');

  // ── Test 6: backoff is a no-op at ceiling ──────────────────
  var atCeil = _adaptiveSleep.GEMINI;
  rateLimitBackoff('GEMINI');
  assert('GEMINI unchanged at ceiling', _adaptiveSleep.GEMINI === atCeil);

  // ── Test 7: SERPER adapts independently ────────────────────
  _adaptiveSleep.SERPER = sStart;
  rateLimitBackoff('SERPER');
  assert('SERPER backoff is independent of GEMINI',
    _adaptiveSleep.SERPER > sStart && _adaptiveSleep.GEMINI === atCeil);
  Logger.log('  SERPER: ' + sStart + ' → ' + _adaptiveSleep.SERPER + 'ms');

  // ── Test 8: getRateLimitSleepMs returns live values ────────
  assert('getRateLimitSleepMs(GEMINI) matches live state',
    getRateLimitSleepMs('GEMINI') === _adaptiveSleep.GEMINI);
  assert('getRateLimitSleepMs(SERPER) matches live state',
    getRateLimitSleepMs('SERPER') === _adaptiveSleep.SERPER);

  // ── Test 9: uninitialised type returns config default ──────
  _adaptiveSleep.GEMINI = null;
  assert('getRateLimitSleepMs falls back to CONFIG when null',
    getRateLimitSleepMs('GEMINI') === CONFIG.BATCH.GEMINI_SLEEP);

  // Restore
  _adaptiveSleep.GEMINI = origGemini;
  _adaptiveSleep.SERPER = origSerper;

  Logger.log('\n=== RESULT: ' + passed + ' passed, ' + failed + ' failed ===');
  Logger.log('=== testAdaptiveRateLimiting COMPLETE ===');
}


// ===== FILE: batchFailures.js =====
// ============================================================
// batchFailures.js
// Accumulates technical errors during a pipeline run in Script
// Properties and renders them as a popup dialog on demand.
//
// Public surface:
//   batchFailuresInit_(runId)                     call at run start
//   batchFailuresPush_(company, web, stage, msg)  called by EventLog.error()
//   showBatchFailures()                           menu item handler
//   onOpen()                                      creates Pipeline menu
// ============================================================

var BATCH_FAILURES_KEY = 'BATCH_FAILURES';

// ── Called once at the start of each pipeline run ────────────
// Replaces any data from the previous run.
function batchFailuresInit_(runId) {
  try {
    PropertiesService.getScriptProperties().setProperty(
      BATCH_FAILURES_KEY,
      JSON.stringify({
        runId:     runId || '',
        startedAt: Utilities.formatDate(new Date(), Session.getScriptTimeZone(), 'HH:mm:ss'),
        entries:   [],
      })
    );
  } catch (e) {
    Logger.log('[batchFailuresInit ERROR] ' + e.message);
  }
}

// ── Called by EventLog.error() for every company-level error ─
// Skips system-level errors where company is empty.
// Capped at 200 entries to stay under the 9 KB property limit.
function batchFailuresPush_(company, website, stage, message) {
  if (!company) return;
  try {
    var props = PropertiesService.getScriptProperties();
    var raw   = props.getProperty(BATCH_FAILURES_KEY);
    var data  = raw ? JSON.parse(raw) : { runId: '', startedAt: '', entries: [] };

    if (data.entries.length >= 200) return;

    data.entries.push({
      company: String(company  || ''),
      website: String(website  || '—'),
      stage:   String(stage    || ''),
      message: String(message  || '').slice(0, 200),
      time:    Utilities.formatDate(new Date(), Session.getScriptTimeZone(), 'HH:mm:ss'),
    });

    props.setProperty(BATCH_FAILURES_KEY, JSON.stringify(data));
  } catch (e) {
    Logger.log('[batchFailuresPush ERROR] ' + e.message);
  }
}

// ── Reads Script Properties and renders an HTML modal dialog ─
function showBatchFailures() {
  var raw  = PropertiesService.getScriptProperties().getProperty(BATCH_FAILURES_KEY);
  var data = raw ? JSON.parse(raw) : null;

  var html;

  if (!data) {
    html = '<p style="font-family:Arial;color:#555;padding:16px">'
         + 'No batch run recorded yet. Run <b>runInitialPipeline()</b> first.</p>';
  } else if (!data.entries || data.entries.length === 0) {
    html = '<div style="font-family:Arial;padding:20px;text-align:center">'
         + '<p style="font-size:14px;color:#333"><b>Run:</b> ' + data.runId
         + ' &nbsp;|&nbsp; <b>Started:</b> ' + data.startedAt + '</p>'
         + '<p style="font-size:22px;color:#34a853">&#10003; No failures in this run</p>'
         + '</div>';
  } else {
    var rows = data.entries.map(function(e) {
      return '<tr>'
        + '<td style="padding:6px 10px;border-bottom:1px solid #e0e0e0">' + escapeHtml_(e.company) + '</td>'
        + '<td style="padding:6px 10px;border-bottom:1px solid #e0e0e0;color:#555">' + escapeHtml_(e.website) + '</td>'
        + '<td style="padding:6px 10px;border-bottom:1px solid #e0e0e0;color:#555">' + escapeHtml_(e.stage) + '</td>'
        + '<td style="padding:6px 10px;border-bottom:1px solid #e0e0e0;color:#c0392b">' + escapeHtml_(e.message) + '</td>'
        + '<td style="padding:6px 10px;border-bottom:1px solid #e0e0e0;color:#888;white-space:nowrap">' + e.time + '</td>'
        + '</tr>';
    }).join('');

    html = '<div style="font-family:Arial;font-size:13px">'
         + '<div style="background:#f8f9fa;padding:12px 16px;border-bottom:1px solid #ddd">'
         + '<b>Run:</b> ' + data.runId + ' &nbsp;|&nbsp; <b>Started:</b> ' + data.startedAt
         + ' &nbsp;|&nbsp; <b style="color:#c0392b">' + data.entries.length + ' failure'
         + (data.entries.length !== 1 ? 's' : '') + '</b>'
         + (data.entries.length >= 200 ? ' <span style="color:#888">(capped at 200)</span>' : '')
         + '</div>'
         + '<div style="overflow-y:auto;max-height:360px">'
         + '<table style="width:100%;border-collapse:collapse">'
         + '<thead><tr style="background:#f1f3f4">'
         + '<th style="padding:8px 10px;text-align:left;font-weight:600">Company</th>'
         + '<th style="padding:8px 10px;text-align:left;font-weight:600">Website</th>'
         + '<th style="padding:8px 10px;text-align:left;font-weight:600">Stage</th>'
         + '<th style="padding:8px 10px;text-align:left;font-weight:600">Error</th>'
         + '<th style="padding:8px 10px;text-align:left;font-weight:600">Time</th>'
         + '</tr></thead>'
         + '<tbody>' + rows + '</tbody>'
         + '</table></div></div>';
  }

  var output = HtmlService.createHtmlOutput(html)
    .setWidth(820)
    .setHeight(460);

  SpreadsheetApp.getUi().showModalDialog(output, 'Batch Failures');
}

// ── Escapes HTML special characters for safe inline rendering ─
function escapeHtml_(str) {
  return String(str || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

// onOpen() lives in Menu.js — all menu items are managed there.


// ===== FILE: c3.js =====
// ============================================================
// c3.gs — C3 Technical Differentiation Scoring
// Uses: Serper (evidence retrieval) + Gemini (interpretation)
//       + deterministic weighted scoring
// Depends on: config.gs, ai.gs, sheetManager.gs
// ============================================================


// ============================================================
// SECTION 1 — MASTER FUNCTION
// Call this from main.gs for each company that passes Stage 1.
// Returns a scores object — never throws.
// ============================================================

function runC3(companyObj) {
  const company = companyObj.company;
  Logger.log(`\nC3: starting for "${company}"`);

  // --------------------------------------------------------
  // Step 1: Get search evidence (cache first, live on miss)
  // --------------------------------------------------------
  const snippets = callSerper(company, "C3");

  // --------------------------------------------------------
  // Step 2: Handle empty evidence
  // --------------------------------------------------------
  if (!snippets || snippets.trim().length < 50) {
    Logger.log(`C3: insufficient evidence for "${company}" — scoring 0`);
    EventLog.warn(CURRENT_RUN_ID, company, companyObj.website || '', 'sc-c3', 'OK',
      'C3: 0/25 — no search evidence found');
    return {
      c3:             0,
      c3Evidence:     "No search evidence found",
      c3Confidence:   "Low",
      manualReview:   false,
    };
  }

  // --------------------------------------------------------
  // Step 3: Build prompt and call Gemini
  // --------------------------------------------------------
  const prompt = buildPrompt("C3", company, snippets);
  const raw    = callGeminiWithRetry(prompt, { company, stage: 'c3' });

  // --------------------------------------------------------
  // Step 4: Handle null Gemini response
  // --------------------------------------------------------
  if (!raw) {
    Logger.log(`C3: Gemini returned null for "${company}" — flagging for review`);
    EventLog.error(CURRENT_RUN_ID, company, companyObj.website || '', 'sc-c3', 'ERROR',
      'C3: 0/25 — Gemini returned null, flagged for manual review');
    return {
      c3:             0,
      c3Evidence:     "Gemini call failed — manual review needed",
      c3Confidence:   "Low",
      manualReview:   true,
    };
  }

  // --------------------------------------------------------
  // Step 5: Parse JSON
  // --------------------------------------------------------
  const parsed = parseGeminiJSON(raw);

  // --------------------------------------------------------
  // Step 6: Handle parse failure
  // --------------------------------------------------------
  if (!parsed) {
    Logger.log(`C3: JSON parse failed for "${company}" — flagging for review`);
    return {
      c3:             0,
      c3Evidence:     "JSON parse failed — manual review needed",
      c3Confidence:   "Low",
      manualReview:   true,
    };
  }

  // --------------------------------------------------------
  // Step 7: Deterministic weighted scoring
  // --------------------------------------------------------
  // AFTER:
  const { totalWeight, ccPenalty, detectedSignals } = calculateC3Score(parsed);

  // Count strong signals (positive only)
  const strongCount = detectedSignals.filter(s => 
    s.includes("(Strong)") && !s.includes("Commodity")
  ).length;

  // Rule 1: CC penalty with weak total → force 0
  const commodityKill = (ccPenalty < 0 && totalWeight <= 0);

  // Rule 2: No strong signals at all → cap at 0, not 12
  const effectiveWeight = commodityKill ? 0 : totalWeight;

  const c3Score      = getC3Score(effectiveWeight);
  const c3Confidence = getC3Confidence(effectiveWeight);
  const c3Evidence   = buildC3Evidence(parsed, detectedSignals);

  Logger.log(`C3: "${company}" → weight=${totalWeight}, effective=${effectiveWeight}, score=${c3Score}`);
  Logger.log(`C3: strongCount=${strongCount}, ccPenalty=${ccPenalty}, commodityKill=${commodityKill}`);
  Logger.log(`C3: signals: ${detectedSignals.join(", ") || "none"}`);
  EventLog.info(CURRENT_RUN_ID, company, companyObj.website || '', 'sc-c3', 'OK',
    'C3: ' + c3Score + '/25 (' + c3Confidence + ') — ' + (detectedSignals.join(', ') || 'no signals'));

  return {
    c3:             c3Score,
    c3Evidence:     c3Evidence,
    c3Confidence:   c3Confidence,
    manualReview:   false,
  };
}


// ============================================================
// SECTION 2 — WEIGHTED SCORING
// Reads signal weights from CONFIG.C3.SIGNAL_WEIGHTS.
// Strong = full weight, Weak = half weight, Absent = 0.
// Returns totalWeight and list of detected signals.
// ============================================================

function calculateC3Score(parsed) {
  const keyMap = {
    "P":  "Patents",
    "D":  "DSIR",
    "R":  "Regulatory_Approvals",
    "PR": "Proprietary_Products",
    "PC": "Pioneer_Claims",
    "CS": "Custom_Synthesis",
    "CC": "Commodity_Chemicals",
  };

  const weights = CONFIG.C3.SIGNAL_WEIGHTS;
  let totalWeight = 0;
  let ccPenalty = 0;          // track CC contribution separately
  const detectedSignals = [];

  for (const [shortKey, signalName] of Object.entries(keyMap)) {
    const value = String(parsed[shortKey] || "A").trim().toUpperCase();
    const weight = weights[signalName] || 0;

    if (value === "S") {
      totalWeight += weight;
      detectedSignals.push(`${signalName} (Strong)`);   // removed weight > 0 guard
      if (signalName === "Commodity_Chemicals") ccPenalty += weight; // weight is -2
    } else if (value === "W") {
      totalWeight += weight * 0.5;
      detectedSignals.push(`${signalName} (Weak)`);     // removed weight > 0 guard
      if (signalName === "Commodity_Chemicals") ccPenalty += weight * 0.5; // -1
    }
  }

  totalWeight = Math.round(totalWeight * 10) / 10;
  ccPenalty   = Math.round(ccPenalty   * 10) / 10;

  Logger.log(`Raw Gemini signals: ${JSON.stringify(parsed)}`);
  Logger.log(`totalWeight=${totalWeight}, ccPenalty=${ccPenalty}`);

  return { totalWeight, ccPenalty, detectedSignals };
}


// ============================================================
// SECTION 3 — CONFIDENCE LEVEL
// Reads thresholds from CONFIG.C3.CONFIDENCE_MAP.
// ============================================================

function getC3Confidence(totalWeight) {
  for (const entry of CONFIG.C3.CONFIDENCE_MAP) {
    if (totalWeight >= entry.minWeight) return entry.level;
  }
  return "Low";
}


// ============================================================
// SECTION 4 — EVIDENCE STRING BUILDER
// Builds a concise one-line evidence string for the SCORES sheet.
// Format: "Custom_Synthesis (Strong), Patents (Weak) | reason"
// ============================================================

function buildC3Evidence(parsed, detectedSignals) {
  const signals = detectedSignals.length > 0
    ? detectedSignals.join(", ")
    : "No positive signals detected";

  const reason = String(parsed.x || "").trim();

  return reason
    ? `${signals} | ${reason.substring(0, 150)}`
    : signals;
}


// ============================================================
// SECTION 5 — TEST FUNCTION
// Run this to verify C3 works end-to-end on a real company.
// Select "testC3" from the dropdown and hit Run.
// ============================================================

function testC3() {
  Logger.log("=== testC3() start ===");

  // Use a known Hyderabad pharma manufacturer for testing
  const testCompany = {
    company: "Avra Synthesis",
    website: "avrasynthesis.com",
    source:  "Test",
  };

  const result = runC3(testCompany);

  Logger.log("\n--- C3 Result ---");
  Logger.log(`Score:        ${result.c3}`);
  Logger.log(`Evidence:     ${result.c3Evidence}`);
  Logger.log(`Confidence:   ${result.c3Confidence}`);
  Logger.log(`ManualReview: ${result.manualReview}`);

  // Show what band this score contributes toward
  Logger.log("\n--- Score context ---");
  Logger.log(`C3 contributes ${result.c3}/25 toward final score`);
  Logger.log(`Max possible final score with this C3: ${10 + 5 + result.c3 + 20 + 20 + 20}`);

  Logger.log("\n=== testC3() complete ===");
}

// ===== FILE: c4.js =====
// ============================================================
// c4.gs — C4 Technical Decision-Maker Scoring
// Flow: Gate1(Tofler scrape) → Gate2(Zauba scrape) → Gate3(General+Gemini)
// Serper: 1–3 calls  |  Gemini: 0–1 calls (name) + 0–1 calls (depth)
// ============================================================


// ============================================================
// SECTION 1 — MASTER FUNCTION
// ============================================================

function runC4(companyObj) {
  const company = companyObj.company;
  Logger.log(`\nC4: starting for "${company}"`);

  // ── Gated DM name resolution ──────────────────────────────
  const nameResult = c4_getNameGated(company);
  const dmName     = nameResult.name;

  Logger.log(`C4: DM name="${dmName}" | source="${nameResult.source}" | failReason="${nameResult.failReason || "ok"}"`);

  if (dmName === "Unknown") {
    EventLog.warn(CURRENT_RUN_ID, company, companyObj.website || '', 'sc-c4-name', 'ERROR',
      'DM name not found — all 3 gates failed (' + nameResult.failReason + ')');
    EventLog.warn(CURRENT_RUN_ID, company, companyObj.website || '', 'sc-c4', 'OK',
      'C4: 0/20 — DM name unknown, manual review needed');
    return {
      c4: 0, c4DmName: "Unknown",
      c4Background: `Name not found: ${nameResult.failReason}`,
      c4Confidence: "Low", manualReview: true,
      c4FailReason: nameResult.failReason,
    };
  }

  EventLog.info(CURRENT_RUN_ID, company, companyObj.website || '', 'sc-c4-name', 'OK',
    'DM name found via ' + nameResult.source + ': "' + dmName + '"');

  // ── Serper: targeted background search ───────────────────
  let bgSnippets = c4_searchPersonBackground(dmName, company);
  if (!bgSnippets || bgSnippets.trim().length <= 50) {
    Logger.log(`C4: no background snippets for "${dmName}"`);
    bgSnippets = "";
  } else {
    Logger.log(`C4: background snippets found (${bgSnippets.length} chars)`);
  }

  // ── Deterministic check — skip Gemini if strong keyword ──
  if (bgSnippets) {
    const bgLower   = bgSnippets.toLowerCase();
    const strongHit = CONFIG.C4.STRONG_SIGNALS.find(kw => bgLower.includes(kw.toLowerCase()));
    if (strongHit) {
      Logger.log(`C4: deterministic Strong (keyword: "${strongHit}") — skipping Gemini depth call`);
      EventLog.info(CURRENT_RUN_ID, company, companyObj.website || '', 'sc-c4', 'OK',
        'C4: ' + CONFIG.C4.SCORE_MAP["Strong"] + '/20 — Strong (deterministic keyword: "' + strongHit + '")');
      return {
        c4: CONFIG.C4.SCORE_MAP["Strong"], c4DmName: dmName,
        c4Background: `Strong | keyword: "${strongHit}"`,
        c4Confidence: "High", manualReview: false,
      };
    }
  }

  // ── Gemini: depth classification ─────────────────────────
  const evidenceForDepth = bgSnippets.trim().length > 50 ? bgSnippets : nameResult.allSnippets;
  const depthPrompt      = buildPrompt("C4_DEPTH", company, evidenceForDepth);
  const depthRaw         = callGeminiWithRetry(depthPrompt, { company, stage: 'c4-depth' });

  if (!depthRaw) {
    Logger.log(`C4: Gemini depth null for "${company}"`);
    const allLower    = (nameResult.allSnippets + " " + bgSnippets).toLowerCase();
    const strongHit   = CONFIG.C4.STRONG_SIGNALS.find(kw => allLower.includes(kw.toLowerCase()));
    const moderateHit = CONFIG.C4.MODERATE_SIGNALS.find(kw => allLower.includes(kw.toLowerCase()));
    return c4_deterministicFallback(company, dmName, strongHit, moderateHit, true);
  }

  const depthParsed = parseGeminiJSON(depthRaw);
  if (!depthParsed) {
    Logger.log(`C4: depth parse fail for "${company}"`);
    return c4_deterministicFallback(company, dmName, null, null, true);
  }

  let depth = String(depthParsed.depth || "None").trim();

  // ── Deterministic override on all accumulated evidence ────
  const allLower    = (nameResult.allSnippets + " " + bgSnippets).toLowerCase();
  const strongHit   = CONFIG.C4.STRONG_SIGNALS.find(kw => allLower.includes(kw.toLowerCase()));
  const moderateHit = CONFIG.C4.MODERATE_SIGNALS.find(kw => allLower.includes(kw.toLowerCase()));

  if (strongHit && depth !== "Strong") {
    depth = "Strong";
    Logger.log(`C4: deterministic override → Strong (keyword: "${strongHit}")`);
  } else if (moderateHit && depth === "None") {
    depth = "Moderate";
    Logger.log(`C4: deterministic bump → Moderate (keyword: "${moderateHit}")`);
  }

  const c4Score      = CONFIG.C4.SCORE_MAP[depth] ?? 0;
  const c4Background = buildC4Background(depthParsed, depth, strongHit, moderateHit);
  const c4Confidence = getC4Confidence(depth, depthParsed, strongHit);

  Logger.log(`C4: "${company}" → depth=${depth}, score=${c4Score}, name=${dmName}`);
  EventLog.info(CURRENT_RUN_ID, company, companyObj.website || '', 'sc-c4', 'OK',
    'C4: ' + c4Score + '/20 — ' + depth + ' | DM: ' + dmName);
  return { c4: c4Score, c4DmName: dmName, c4Background, c4Confidence, manualReview: false };
}


// ============================================================
// SECTION 2 — GATED NAME RESOLUTION
// Each gate accumulates snippets into a shared buffer.
// Scraping is attempted before Gemini in Gates 1 & 2.
// Gate 3 sends the full buffer to Gemini as a last resort.
// Returns: { name, designation, source, allSnippets, failReason }
// ============================================================

function c4_getNameGated(company) {
  const buf = [];   // snippet accumulator — fed to Gemini in Gate 3

  // ── Gate 1: Tofler ────────────────────────────────────────
  Logger.log(`C4 Gate1: Tofler — "${company}"`);
  const toflerSnippets = callSerper(company, "C4_TOFLER");

  if (toflerSnippets && toflerSnippets.length > 30) {
    buf.push(toflerSnippets);

    // Fast path: name already in snippet text
    const fromSnippet = c4_extractNameFromSnippets(toflerSnippets, company);
    if (fromSnippet !== "Unknown") {
      Logger.log(`C4 Gate1: name in Tofler snippet: "${fromSnippet}"`);
      return { name: fromSnippet, designation: "", source: "tofler_snippet", allSnippets: toflerSnippets, failReason: null };
    }

    // Slow path: fetch and scrape the actual Tofler page
    const toflerUrl = c4_extractUrl(toflerSnippets, "tofler.in");
    if (toflerUrl) {
      const scraped = c4_scrapePage(toflerUrl);
      if (scraped) {
        Logger.log(`C4 Gate1: Tofler scrape → "${scraped.name}"`);
        return { name: scraped.name, designation: scraped.designation, source: "tofler_scrape", allSnippets: toflerSnippets, failReason: null };
      }
      Logger.log(`C4 Gate1: Tofler page scrape returned nothing`);
    } else {
      Logger.log(`C4 Gate1: no Tofler URL in snippets`);
    }
  } else {
    Logger.log(`C4 Gate1: no Tofler results`);
  }

  // ── Gate 2: Zauba ─────────────────────────────────────────
  Logger.log(`C4 Gate2: Zauba — "${company}"`);
  const zaubaSnippets = callSerper(company, "C4_ZAUBA");

  if (zaubaSnippets && zaubaSnippets.length > 30) {
    buf.push(zaubaSnippets);

    const fromSnippet = c4_extractNameFromSnippets(zaubaSnippets, company);
    if (fromSnippet !== "Unknown") {
      Logger.log(`C4 Gate2: name in Zauba snippet: "${fromSnippet}"`);
      return { name: fromSnippet, designation: "", source: "zauba_snippet", allSnippets: buf.join("\n\n---\n\n"), failReason: null };
    }

    const zaubaUrl = c4_extractUrl(zaubaSnippets, "zaubacorp.com");
    if (zaubaUrl) {
      const scraped = c4_scrapePage(zaubaUrl);
      if (scraped) {
        Logger.log(`C4 Gate2: Zauba scrape → "${scraped.name}"`);
        return { name: scraped.name, designation: scraped.designation, source: "zauba_scrape", allSnippets: buf.join("\n\n---\n\n"), failReason: null };
      }
      Logger.log(`C4 Gate2: Zauba page scrape returned nothing (likely paywall)`);
    } else {
      Logger.log(`C4 Gate2: no Zauba URL in snippets`);
    }
  } else {
    Logger.log(`C4 Gate2: no Zauba results`);
  }

  // ── Gate 3: General query → snippet regex → Gemini ────────
  Logger.log(`C4 Gate3: general query — "${company}"`);
  const generalSnippets = callSerper(company, "C4_GENERAL");
  if (generalSnippets && generalSnippets.length > 30) buf.push(generalSnippets);

  const allSnippets = buf.join("\n\n---\n\n");

  if (allSnippets.length < 50) {
    Logger.log(`C4 Gate3: no snippets from any gate`);
    return { name: "Unknown", designation: "", source: "none", allSnippets: "", failReason: "no_snippets" };
  }

  // Try regex on the full accumulated buffer before spending a Gemini call
  const fromSnippet = c4_extractNameFromSnippets(allSnippets, company);
  if (fromSnippet !== "Unknown") {
    Logger.log(`C4 Gate3: name found in snippets (no Gemini needed): "${fromSnippet}"`);
    return { name: fromSnippet, designation: "", source: "general_snippet", allSnippets, failReason: null };
  }

  Logger.log(`C4 Gate3: sending ${allSnippets.length} chars to Gemini`);
  const namePrompt = buildPrompt("C4_NAME", company, allSnippets);
  const nameRaw    = callGeminiWithRetry(namePrompt, { company, stage: 'c4-name' });

  if (!nameRaw) {
    return { name: "Unknown", designation: "", source: "gemini", allSnippets, failReason: "gemini_null" };
  }

  const nameParsed = parseGeminiJSON(nameRaw);
  if (!nameParsed) {
    return { name: "Unknown", designation: "", source: "gemini", allSnippets, failReason: "gemini_parse_fail" };
  }

  const dmName = String(nameParsed.name || "Unknown").trim();
  if (!dmName || dmName === "Unknown" || dmName.toLowerCase() === "null") {
    return { name: "Unknown", designation: "", source: "gemini", allSnippets, failReason: "gemini_unknown" };
  }

  Logger.log(`C4 Gate3: Gemini → "${dmName}"`);
  return { name: dmName, designation: nameParsed.designation || "", source: "gemini", allSnippets, failReason: null };
}


// ============================================================
// SECTION 3 — URL EXTRACTOR
// Pulls the first matching URL for a given domain from the
// snippet text produced by buildSnippetText() ("LINK: url").
// ============================================================

function c4_extractUrl(snippets, domain) {
  const escaped = domain.replace(/\./g, '\\.');
  const re      = new RegExp('LINK:\\s*(https?:\\/\\/(?:www\\.)?' + escaped + '\\/[^\\s\\n]+)', 'i');
  const m       = snippets.match(re);
  return m ? m[1].trim() : null;
}


// ============================================================
// SECTION 4 — PAGE SCRAPER
// Fetches a Tofler or Zauba URL and delegates to the parser.
// Returns { name, designation } or null.
// ============================================================

function c4_scrapePage(url) {
  Logger.log(`C4 scrape: fetching ${url}`);
  try {
    const response = UrlFetchApp.fetch(url, {
      muteHttpExceptions: true,
      followRedirects:    true,
      headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120 Safari/537.36' },
    });

    const code = response.getResponseCode();
    if (code !== 200) {
      Logger.log(`C4 scrape: HTTP ${code} for ${url}`);
      return null;
    }

    const html = response.getContentText();
    if (!html || html.length < 500) return null;

    if (/get pro|subscribe|unlock|sign up to view|login to view|please login/i.test(html)) {
      Logger.log(`C4 scrape: paywall detected at ${url}`);
      return null;
    }

    return c4_parseDirectorFromHtml(html);

  } catch(e) {
    Logger.log(`C4 scrape error: ${e.message}`);
    return null;
  }
}


// ============================================================
// SECTION 5 — JSON-LD PARSER
// Tofler and other modern pages embed structured data.
// This is the most reliable extraction path when present.
// ============================================================

function c4_parseFromJsonLd(html) {
  const re = /<script[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi;
  const seniorTitles = ['managing director', 'chairman', 'founder', 'ceo', 'md', 'proprietor', 'promoter'];
  let m;

  while ((m = re.exec(html)) !== null) {
    try {
      const data  = JSON.parse(m[1]);
      const items = Array.isArray(data) ? data : [data];

      for (const item of items) {
        if (!item || typeof item !== 'object') continue;

        for (const field of ['employee', 'founder', 'member', 'director']) {
          const persons = [].concat(item[field] || []);
          if (!persons.length) continue;

          // Try to find the most senior title first
          for (const tp of seniorTitles) {
            const found = persons.find(p => p && String(p.jobTitle || '').toLowerCase().includes(tp));
            if (found && found.name && c4_isValidName(String(found.name))) {
              return { name: String(found.name).trim(), designation: found.jobTitle || tp };
            }
          }

          // Fall back to first person with a valid name
          for (const person of persons) {
            const name = String(person?.name || '').trim();
            if (name && c4_isValidName(name)) {
              return { name, designation: person.jobTitle || '' };
            }
          }
        }
      }
    } catch(e) {}
  }
  return null;
}


// ============================================================
// SECTION 6 — HTML DIRECTOR PARSER
// Strips tags to plain text, then searches for title+name pairs.
// Tofler/MCA use ALL CAPS for names; general pages use Title Case.
// Priority: Managing Director > Chairman > Founder > CEO > Proprietor > Director
// ============================================================

function c4_parseDirectorFromHtml(html) {
  // Try structured data first — most reliable
  const ldResult = c4_parseFromJsonLd(html);
  if (ldResult) return ldResult;

  // Strip scripts, styles, and HTML tags to get readable text
  const text = html
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&amp;/g, '&').replace(/&nbsp;/g, ' ').replace(/&#\d+;/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

  const titlePairs = [
    { label: "Managing Director", re: /managing\s+director/i },
    { label: "MD",                re: /\bmd\b/i              },
    { label: "Chairman",          re: /chairman/i            },
    { label: "Founder",           re: /founder/i             },
    { label: "Promoter",          re: /promoter/i            },
    { label: "CEO",               re: /\bceo\b/i             },
    { label: "Proprietor",        re: /proprietor/i          },
    { label: "Director",          re: /director/i            },
  ];

  for (const { label, re } of titlePairs) {
    const idx = text.search(re);
    if (idx === -1) continue;

    // 120-char window either side of the title keyword
    const window = text.substring(Math.max(0, idx - 120), Math.min(text.length, idx + 120));

    // Pattern A: ALL CAPS name — Tofler/MCA format (e.g. "RAJESH KUMAR SHARMA")
    const allCapsMatch = window.match(/\b([A-Z][A-Z]+(?:\s[A-Z][A-Z]+){1,3})\b/);
    if (allCapsMatch) {
      const name = allCapsMatch[1].trim();
      if (c4_isValidName(name)) return { name: c4_toTitleCase(name), designation: label };
    }

    // Pattern B: Title Case name — general web pages
    const titleCaseMatch = window.match(/\b([A-Z][a-z]{1,}(?:\s[A-Z][a-z]{1,}){1,3})\b/);
    if (titleCaseMatch) {
      const name = titleCaseMatch[1].trim();
      if (c4_isValidName(name)) return { name, designation: label };
    }
  }

  return null;
}


// ============================================================
// SECTION 7 — NAME HELPERS
// ============================================================

function c4_isValidName(name) {
  if (!name || name.length < 5 || name.length > 50) return false;

  const upper = name.toUpperCase().trim();
  const stopWords = [
    'INDIA', 'LIMITED', 'PRIVATE', 'COMPANY', 'CORPORATION', 'DIRECTOR',
    'MANAGING', 'SHAREHOLDER', 'PROMOTER', 'CHAIRMAN', 'FOUNDER', 'PROPRIETOR',
    'OFFICER', 'EXECUTIVE', 'PARTNER', 'TRUSTEE', 'MEMBER', 'SECRETARY',
    'AUTHORIZED', 'REGISTERED', 'CORPORATE', 'BUSINESS', 'SERVICES',
    'INDUSTRIES', 'ENTERPRISE', 'TRADING', 'EXPORTS', 'IMPORTS', 'SOLUTIONS',
    // Zauba/MCA field labels that pattern-match as names
    'IDENTIFICATION', 'NUMBER', 'DATE', 'APPOINTMENT', 'DESIGNATION',
  ];

  for (const s of stopWords) {
    if (upper === s || upper.startsWith(s + ' ') || upper.endsWith(' ' + s)) return false;
  }

  // Require at least 2 words, each 2+ characters
  const words = upper.trim().split(/\s+/);
  return words.length >= 2 && words.every(w => w.length >= 2);
}

function c4_toTitleCase(allCapsName) {
  return allCapsName
    .toLowerCase()
    .replace(/\b([a-z])/g, c => c.toUpperCase());
}


// ============================================================
// SECTION 8 — SNIPPET-BASED NAME EXTRACTOR
// Runs before page scraping as a fast/free first attempt.
// Handles both Title Case (LinkedIn) and ALL CAPS (Tofler/MCA).
// ============================================================

function c4_extractNameFromSnippets(snippets, company) {
  const companyFirstWord = company.toLowerCase().split(" ")[0];

  function tryName(raw) {
    if (!raw) return null;
    raw = raw.trim();
    // Cross-line captures are never valid names
    if (raw.includes('\n') || raw.includes('\r')) return null;
    // First char must be strictly A-Z — the 'i' flag makes [A-Z] match lowercase too,
    // so this guard is the only thing that stops "page SNIPPET" from being accepted
    const code = raw.charCodeAt(0);
    if (code < 65 || code > 90) return null;
    const name = (raw === raw.toUpperCase() && raw.includes(' ')) ? c4_toTitleCase(raw) : raw;
    if (name.length > 3 && !name.toLowerCase().includes(companyFirstWord) && c4_isValidName(name)) {
      return name;
    }
    return null;
  }

  // Pattern 1 — title before name: "MD: Rajesh Kumar" / "Director - RAJESH KUMAR"
  const p1 = /(?:managing director|md|founder|promoter|chairman|ceo|proprietor|partner|director)\s*[:\-·|]\s*([A-Z][a-z]+(?:\s[A-Z][a-z]+){1,3})/gi;
  // Pattern 2 — name before title with -, ·, ,, | separators (LinkedIn: "Sanjeev Fogla - Managing Director")
  const p2 = /([A-Z][a-z]+(?:\s[A-Z][a-z]+){1,3})\s*[-,·|@]\s*(?:managing director|md|founder|promoter|chairman|ceo|proprietor|director)/gi;
  // Pattern 3 — ALL CAPS name before title (MCA/Tofler format)
  const p3 = /([A-Z]{2,}(?:\s[A-Z]{2,}){1,3})\s*[-·|,]\s*(?:MANAGING DIRECTOR|MD|FOUNDER|PROMOTER|CHAIRMAN|CEO|PROPRIETOR|DIRECTOR)/g;
  // Pattern 4 — ALL CAPS name after title
  const p4 = /(?:managing director|md|founder|promoter|chairman|ceo|proprietor|director)\s*[:\-·|\s]\s*([A-Z]{2,}(?:\s[A-Z]{2,}){1,3})/gi;
  // Pattern 5 — "Name is the Proprietor/Founder/MD of..." (FAQ / IndiaMART format)
  const p5 = /([A-Z][a-z]+(?:\s[A-Z][a-z]+){1,3})\s+is\s+the\s+(?:proprietor|founder|md|managing director|ceo|chairman)/gi;
  // Pattern 6 — Tofler director page URL slug: tofler.in/first-last-name/director
  const p6 = /tofler\.in\/([a-z]+(?:-[a-z]+){1,4})\/director/gi;

  for (const pattern of [p1, p2, p3, p4, p5]) {
    pattern.lastIndex = 0;
    const match = pattern.exec(snippets);
    if (!match) continue;
    const result = tryName(match[1] || match[2] || "");
    if (result) return result;
  }

  // Tofler URL slug — convert "pratik-patel" → "Pratik Patel"
  p6.lastIndex = 0;
  const urlMatch = p6.exec(snippets);
  if (urlMatch) {
    const fromSlug = urlMatch[1]
      .split('-')
      .map(w => w.charAt(0).toUpperCase() + w.slice(1))
      .join(' ');
    const result = tryName(fromSlug);
    if (result) return result;
  }

  // Zauba director page title: "TITLE: PRATYUSH CHOUDHARY | ZaubaCorp"
  // Name and designation are on separate lines, so cross-line patterns can't catch this.
  // Read the name directly from the structured title format instead.
  const zaubaTitle = /TITLE:\s+([A-Z]{2,}(?:\s[A-Z]{2,}){1,3})\s*\|\s*ZaubaCorp/g;
  zaubaTitle.lastIndex = 0;
  const ztMatch = zaubaTitle.exec(snippets);
  if (ztMatch) {
    const result = tryName(c4_toTitleCase(ztMatch[1]));
    if (result) return result;
  }

  return "Unknown";
}


// ============================================================
// SECTION 9 — BACKGROUND SEARCH
// ============================================================

function c4_searchPersonBackground(personName, companyName) {
  const cached = getCachedSearch(companyName, "C4_BG");
  if (cached) return cached;

  if (CircuitBreaker.isHalted('SERPER')) {
    Logger.log('c4_searchPersonBackground: SERPER circuit open — skipping ' + companyName);
    return "";
  }

  const query = CONFIG.QUERIES.C4_BACKGROUND
    .replace(/\{person\}/g,  personName)
    .replace(/\{company\}/g, companyName);

  const options = {
    method:  "post",
    headers: { "X-API-KEY": CONFIG.KEYS.SERPER, "Content-Type": "application/json" },
    payload: JSON.stringify({ q: query, num: 6 }),
    muteHttpExceptions: true,
  };

  try {
    const response   = UrlFetchApp.fetch("https://google.serper.dev/search", options);
    if (response.getResponseCode() !== 200) {
      CircuitBreaker.recordFailure('SERPER');
      rateLimitBackoff('SERPER');
      rateLimit('SERPER');
      return "";
    }
    const data       = JSON.parse(response.getContentText());
    const numResults = (data.organic || []).length;
    const snippets   = buildSnippetText(data);
    TokenLog.appendSerper(CURRENT_RUN_ID, companyName, 'C4_BG', numResults);
    CircuitBreaker.recordSuccess('SERPER');
    rateLimitSuccess('SERPER');
    saveToCache(companyName, "C4_BG", query, snippets);
    rateLimit('SERPER');
    return snippets;
  } catch(e) {
    Logger.log(`c4_searchPersonBackground ERROR: ${e.message}`);
    CircuitBreaker.recordFailure('SERPER');
    rateLimitBackoff('SERPER');
    rateLimit('SERPER');
    return "";
  }
}


// ============================================================
// SECTION 10 — DETERMINISTIC FALLBACK, BACKGROUND BUILDER, CONFIDENCE
// ============================================================

function c4_deterministicFallback(company, dmName, strongHit, moderateHit, manualReview) {
  if (strongHit) return {
    c4: 20, c4DmName: dmName,
    c4Background: `Deterministic override: "${strongHit}" found in snippets`,
    c4Confidence: "Medium", manualReview,
  };
  if (moderateHit) return {
    c4: 10, c4DmName: dmName,
    c4Background: `Deterministic override: "${moderateHit}" found in snippets`,
    c4Confidence: "Low", manualReview,
  };
  return {
    c4: 0, c4DmName: dmName,
    c4Background: "Gemini depth call failed — manual review needed",
    c4Confidence: "Low", manualReview,
  };
}

function buildC4Background(parsed, finalDepth, strongHit, moderateHit) {
  const parts = [finalDepth];
  const bg    = String(parsed.bg || "").trim();

  if (bg && bg.toLowerCase() !== "unknown") parts.push(bg.substring(0, 80));
  if (strongHit)        parts.push(`keyword: "${strongHit}"`);
  else if (moderateHit) parts.push(`keyword: "${moderateHit}"`);

  const reason = String(parsed.x || "").trim();
  if (reason) parts.push(reason.substring(0, 60));

  return parts.join(" | ").substring(0, 200);
}

function getC4Confidence(depth, parsed, strongHit) {
  if (depth === "Strong" && strongHit) return "High";
  if (depth === "Strong")              return "Medium";
  if (depth === "Moderate")            return "Medium";
  return "Low";
}


// ============================================================
// SECTION 11 — TEST: gate-by-gate name extraction
// Run standalone to diagnose which gate is hitting/missing.
// ============================================================

function testC4NameExtraction() {
  Logger.log("=== testC4NameExtraction START ===");

  const ss    = SpreadsheetApp.getActiveSpreadsheet();
  const sheet = ss.getSheetByName(SHEETS.STAGE1);
  if (!sheet) { Logger.log("STAGE1 sheet not found"); return; }

  const data = sheet.getRange(2, 1, sheet.getLastRow() - 1, 11).getValues();
  const companies = data
    .filter(row => String(row[9]).trim() === "PASS")
    .slice(0, 10)
    .map(row => ({ company: String(row[0]).trim() }));

  if (!companies.length) { Logger.log("No PASS companies found"); return; }

  const summary = { resolved: 0, failed: 0, bySource: {} };

  companies.forEach((companyObj, i) => {
    const company = companyObj.company;
    Logger.log(`\n--- [${i+1}/${companies.length}] ${company} ---`);

    const buf = [];

    // ── Gate 1: Tofler ──────────────────────────────────────
    Logger.log(`Gate1: Tofler`);
    const toflerSnippets = callSerper(company, "C4_TOFLER");
    if (toflerSnippets && toflerSnippets.length > 30) {
      buf.push(toflerSnippets);
      const fromSnippet = c4_extractNameFromSnippets(toflerSnippets, company);
      if (fromSnippet !== "Unknown") {
        Logger.log(`Gate1 DONE (snippet): "${fromSnippet}"`);
        summary.resolved++;
        summary.bySource["tofler_snippet"] = (summary.bySource["tofler_snippet"] || 0) + 1;
        return;
      }
      const toflerUrl = c4_extractUrl(toflerSnippets, "tofler.in");
      if (toflerUrl) {
        Logger.log(`Gate1: scraping ${toflerUrl}`);
        const scraped = c4_scrapePage(toflerUrl);
        if (scraped) {
          Logger.log(`Gate1 DONE (scrape): "${scraped.name}" | "${scraped.designation}"`);
          summary.resolved++;
          summary.bySource["tofler_scrape"] = (summary.bySource["tofler_scrape"] || 0) + 1;
          return;
        }
        Logger.log(`Gate1: scrape returned nothing`);
      } else {
        Logger.log(`Gate1: no Tofler URL in snippets`);
        Logger.log(`Gate1 snippet preview:\n${toflerSnippets.substring(0, 400)}`);
      }
    } else {
      Logger.log(`Gate1: no results`);
    }

    // ── Gate 2: Zauba ───────────────────────────────────────
    Logger.log(`Gate2: Zauba`);
    const zaubaSnippets = callSerper(company, "C4_ZAUBA");
    if (zaubaSnippets && zaubaSnippets.length > 30) {
      buf.push(zaubaSnippets);
      const fromSnippet = c4_extractNameFromSnippets(zaubaSnippets, company);
      if (fromSnippet !== "Unknown") {
        Logger.log(`Gate2 DONE (snippet): "${fromSnippet}"`);
        summary.resolved++;
        summary.bySource["zauba_snippet"] = (summary.bySource["zauba_snippet"] || 0) + 1;
        return;
      }
      const zaubaUrl = c4_extractUrl(zaubaSnippets, "zaubacorp.com");
      if (zaubaUrl) {
        Logger.log(`Gate2: scraping ${zaubaUrl}`);
        const scraped = c4_scrapePage(zaubaUrl);
        if (scraped) {
          Logger.log(`Gate2 DONE (scrape): "${scraped.name}" | "${scraped.designation}"`);
          summary.resolved++;
          summary.bySource["zauba_scrape"] = (summary.bySource["zauba_scrape"] || 0) + 1;
          return;
        }
        Logger.log(`Gate2: scrape returned nothing (likely paywall)`);
      } else {
        Logger.log(`Gate2: no Zauba URL in snippets`);
        Logger.log(`Gate2 snippet preview:\n${zaubaSnippets.substring(0, 400)}`);
      }
    } else {
      Logger.log(`Gate2: no results`);
    }

    // ── Gate 3: General snippets → regex → Gemini ───────────
    Logger.log(`Gate3: general query`);
    const generalSnippets = callSerper(company, "C4_GENERAL");
    if (generalSnippets && generalSnippets.length > 30) buf.push(generalSnippets);

    const allSnippets = buf.join("\n\n---\n\n");
    if (allSnippets.length < 50) {
      Logger.log(`Gate3: no snippets from any gate → FAIL no_snippets`);
      summary.failed++;
      summary.bySource["FAIL:no_snippets"] = (summary.bySource["FAIL:no_snippets"] || 0) + 1;
    } else {
      // Try regex first — free, no token cost
      const fromSnippet = c4_extractNameFromSnippets(allSnippets, company);
      if (fromSnippet !== "Unknown") {
        Logger.log(`Gate3 DONE (snippet regex): "${fromSnippet}"`);
        summary.resolved++;
        summary.bySource["general_snippet"] = (summary.bySource["general_snippet"] || 0) + 1;
      } else {
        // Gemini fallback — only if regex found nothing
        Logger.log(`Gate3: regex found nothing — calling Gemini`);
        Logger.log(`Gate3 snippet preview:\n${allSnippets.substring(0, 400)}`);
        const namePrompt = buildPrompt("C4_NAME", company, allSnippets);
        const nameRaw    = callGeminiWithRetry(namePrompt, { company, stage: 'c4-name' });
        if (!nameRaw) {
          Logger.log(`Gate3: Gemini null`);
          summary.failed++;
          summary.bySource["FAIL:gemini_null"] = (summary.bySource["FAIL:gemini_null"] || 0) + 1;
        } else {
          const nameParsed = parseGeminiJSON(nameRaw);
          const dmName     = nameParsed ? String(nameParsed.name || "Unknown").trim() : "Unknown";
          if (!dmName || dmName === "Unknown" || dmName.toLowerCase() === "null") {
            Logger.log(`Gate3: Gemini returned Unknown`);
            summary.failed++;
            summary.bySource["FAIL:gemini_unknown"] = (summary.bySource["FAIL:gemini_unknown"] || 0) + 1;
          } else {
            Logger.log(`Gate3 DONE (Gemini): "${dmName}"`);
            summary.resolved++;
            summary.bySource["gemini"] = (summary.bySource["gemini"] || 0) + 1;
          }
        }
      }
    }
  });

  // End summary
  Logger.log(`\n=== SUMMARY ===`);
  Logger.log(`Resolved: ${summary.resolved}/${companies.length}`);
  Logger.log(`Failed:   ${summary.failed}/${companies.length}`);
  Logger.log(`Breakdown:`);
  Object.entries(summary.bySource).forEach(([k, v]) => Logger.log(`  ${k}: ${v}`));
  Logger.log("=== testC4NameExtraction COMPLETE ===");
}


// ===== FILE: c5.js =====
// ============================================================
// c5.gs — C5 Growing Sector Scoring
// Zero API calls. Zero AI. Pure deterministic logic.
// Reads Stage 1 cached snippets → keyword match → score.
// Depends on: config.gs, sheetManager.gs
// ============================================================

// ============================================================
// SECTION 1 — MASTER FUNCTION
// Call this from main.gs for each company that passes Stage 1.
// Returns a scores object — never throws.
// ============================================================

function runC5(companyObj, snippets) {
  const company = companyObj.company;
  Logger.log(`\nC5: starting for "${company}"`);

  const stage1 = getStage1Status(company);
  if (stage1 && String(stage1.manufacturerFlag).trim().toUpperCase() === 'NO') {
    Logger.log(`C5: "${company}" — Manufacturer_Flag=NO, capping at default score`);
    const r = buildC5Result(CONFIG.C5.DEFAULT, 'Non-manufacturer confirmed in Stage 1 — C5 capped');
    EventLog.warn(CURRENT_RUN_ID, company, companyObj.website || '', 'sc-c5', 'OK',
      'C5: ' + r.c5 + '/20 — capped (non-manufacturer flag set in Stage 1)');
    return r;
  }

  if (!snippets || snippets.trim().length < 50) {
    Logger.log(`C5: no snippets provided for "${company}" — scoring as Other`);
    const r = buildC5Result(CONFIG.C5.DEFAULT, "No cached evidence — Stage 1 may not have run");
    EventLog.warn(CURRENT_RUN_ID, company, companyObj.website || '', 'sc-c5', 'OK',
      'C5: ' + r.c5 + '/20 — no cached snippets, defaulted to Other');
    return r;
  }

  const snippetsLower = snippets.toLowerCase();

  // --------------------------------------------------------
  // Step 3: Walk sector list in order (most specific first).
  // First match wins — order in CONFIG.C5.SECTOR_KEYWORDS
  // is intentional and must not be changed casually.
  //
  // Why order matters:
  //   "electronic chemicals" must come before "specialty chemicals"
  //   because semiconductor etching chemicals ARE specialty chemicals
  //   but we want the more specific (higher value) classification.
  //
  //   "pharma intermediates" must come before "commodity/basic"
  //   because bulk drugs could match both — pharma is correct.
  //
  //   "CRO/service" comes last among the named sectors because
  //   a CDMO might also mention APIs — we want to catch the
  //   manufacturing angle first if present.
  // --------------------------------------------------------
  for (const sector of CONFIG.C5.SECTOR_KEYWORDS) {
    const matchedKeyword = sector.keywords.find(kw =>
      snippetsLower.includes(kw.toLowerCase())
    );

    if (matchedKeyword) {
      Logger.log(`C5: "${company}" → sector="${sector.sector}", keyword="${matchedKeyword}", score=${sector.score}`);
      const r = buildC5Result(sector, matchedKeyword);
      EventLog.info(CURRENT_RUN_ID, company, companyObj.website || '', 'sc-c5', 'OK',
        'C5: ' + r.c5 + '/20 — sector: ' + sector.sector + ' (keyword: "' + matchedKeyword + '")');
      return r;
    }
  }

  // --------------------------------------------------------
  // Step 4: No sector matched — return default "Other"
  // --------------------------------------------------------
  Logger.log(`C5: "${company}" → no sector match, scoring as Other`);
  const r = buildC5Result(CONFIG.C5.DEFAULT, "No sector keywords matched");
  EventLog.info(CURRENT_RUN_ID, company, companyObj.website || '', 'sc-c5', 'OK',
    'C5: ' + r.c5 + '/20 — no sector match, defaulted to Other');
  return r;
}

// ============================================================
// SECTION 2 — RESULT BUILDER
// Builds the standardised scores object that main.gs expects.
// ============================================================

function buildC5Result(sectorConfig, matchedKeyword) {
  // Compose a clear, human-readable reason string.
  // Format: "<sector> — matched: '<keyword>' — <tailwind reason>"
  // The matched keyword makes it auditable — you can see exactly
  // why a company was placed in a sector.
  const reason = matchedKeyword && matchedKeyword !== "No cached evidence — Stage 1 may not have run"
    ? `${sectorConfig.sector} — matched: "${matchedKeyword}" — ${sectorConfig.reason}`
    : `${sectorConfig.sector} — ${sectorConfig.reason}`;

  return {
    c5:       sectorConfig.score,
    c5Sector: sectorConfig.sector,
    c5Reason: reason.substring(0, 250),
  };
}

// ============================================================
// SECTION 3 — TEST FUNCTION
// Tests four companies covering different sector paths:
//   Avra Synthesis       → Pharma intermediates (APIs)
//   Divi's Laboratories  → Pharma intermediates (APIs)
//   SRF Limited          → Specialty/Polymer (fluorochemicals)
//   A CRO company        → CRO/service (low score)
//
// Run "testC5" from dropdown. No API calls — instant.
// ============================================================

function testC5() {
  Logger.log("=== testC5() start ===\n");

  // --------------------------------------------------------
  // Test cases — snippets passed directly, no cache needed.
  //   Divi's      → Pharma intermediates → 20
  //   SRF         → Polymer additives    → 16
  //   Syngene     → CRO/service          →  2
  //   Avra        → No sector match      →  5
  // --------------------------------------------------------
  const testCases = [
    {
      company:  "Avra Synthesis",
      website:  "avrasynthesis.com",
      source:   "Test",
      snippets: "Avra Synthesis is a Hyderabad-based manufacturer supplying custom molecules, laboratory reagents and compound libraries to research institutions.",
      expect:   "Other — score 8",
    },
    {
      company:  "Divi's Laboratories",
      website:  "divislabs.com",
      source:   "Test",
      snippets: "Divi's Laboratories is a leading manufacturer of active pharmaceutical ingredients (API) and intermediates. bulk drugs pharma intermediates exported to regulated markets.",
      expect:   "Pharma intermediates — score 20",
    },
    {
      company:  "SRF Limited",
      website:  "srf.com",
      source:   "Test",
      snippets: "SRF Limited manufactures polymer additives, resins, rubber compounds and performance chemicals for automotive and industrial applications.",
      expect:   "Polymer additives — score 16",
    },
    {
      company:  "Syngene International",
      website:  "syngeneintl.com",
      source:   "Test",
      snippets: "Syngene International is a contract research organization (CRO) and CDMO providing integrated drug discovery and development services. testing services for pharma clients.",
      expect:   "CRO/service — score 2",
    },
  ];

  let passed = 0;
  let failed = 0;

  testCases.forEach(({ company, website, source, snippets, expect }) => {
    Logger.log(`--- Testing: ${company} ---`);
    Logger.log(`Expected: ${expect}`);

    const result = runC5({ company, website, source }, snippets);

    Logger.log(`Score:    ${result.c5}`);
    Logger.log(`Sector:   ${result.c5Sector}`);
    Logger.log(`Reason:   ${result.c5Reason}`);
    Logger.log(`C5 contributes ${result.c5}/20 toward final score`);

    // Simple pass/fail check against expected score
    const expectedScore = parseInt(expect.match(/score (\d+)/)?.[1]);
    if (!isNaN(expectedScore)) {
      if (result.c5 === expectedScore) {
        Logger.log(`✓ PASS`);
        passed++;
      } else {
        Logger.log(`✗ FAIL — expected score ${expectedScore}, got ${result.c5}`);
        failed++;
      }
    }

    Logger.log("");
  });

  // --------------------------------------------------------
  // Summary
  // --------------------------------------------------------
  Logger.log(`--- Results: ${passed} passed, ${failed} failed ---\n`);

  // --------------------------------------------------------
  // Keyword audit — prints every sector and its keywords
  // in priority order. Run this after editing
  // CONFIG.C5.SECTOR_KEYWORDS to verify no misplacements.
  // --------------------------------------------------------
  Logger.log("--- Sector keyword map (in match priority order) ---");
  CONFIG.C5.SECTOR_KEYWORDS.forEach((sector, idx) => {
    Logger.log(`${idx + 1}. ${sector.sector} (${sector.score}pts)`);
    Logger.log(`   Keywords: ${sector.keywords.join(", ")}`);
    Logger.log(`   Tailwind: ${sector.reason}`);
  });
  Logger.log(`DEFAULT: ${CONFIG.C5.DEFAULT.sector} (${CONFIG.C5.DEFAULT.score}pts)`);

  Logger.log("\n=== testC5() complete ===");
}

// ===== FILE: c6.js =====
// ============================================================
// c6.gs — C6 Growth Signals Scoring
// Zero AI. Fully deterministic signal detection.
// Makes one Serper call (or reads cache) per company.
// Depends on: config.gs, ai.gs, sheetManager.gs
// ============================================================

// ============================================================
// SECTION 1 — MASTER FUNCTION
// Call this from main.gs for each company that passes Stage 1.
// Returns a scores object — never throws.
// ============================================================

function runC6(companyObj) {
  if (!companyObj || !companyObj.company) {
    Logger.log("C6 ERROR: runC6() called with no companyObj.");
    return { c6: 0, c6Signals: "Invalid call", c6Confidence: "Low" };
  }

  const company = companyObj.company;
  Logger.log(`\nC6: starting for "${company}"`);

  // ── Step 1: Get C6-specific snippets ─────────────────────
  const snippets = callSerper(company, "C6");

  // ── Step 2: Also pull from Stage 1 cache as fallback ─────
  // STAGE1_MFG was cached in pipeline.js under the CLEANED name —
  // must clean it here too or this lookup always misses.
  const cachedMfg = getCachedSearch(cleanCompanyName(company), "STAGE1_MFG") || "";
  const cachedC3  = getCachedSearch(company, "C3")         || "";

  const combinedEvidence = [
    snippets     || "",
    cachedMfg,
    cachedC3,
  ].join("\n").trim();

  if (combinedEvidence.length < 50) {
    Logger.log(`C6: no evidence at all for "${company}" — scoring 0`);
    EventLog.warn(CURRENT_RUN_ID, company, companyObj.website || '', 'sc-c6', 'OK',
      'C6: 0/20 — no search evidence found');
    return { c6: 0, c6Signals: "No search evidence found", c6Confidence: "Low" };
  }

  // ── Step 3: Deterministic pass (fast, no API cost) ───────
  const { firedSignals, totalStrength } = detectC6Signals(combinedEvidence);

  // If deterministic already found 2+ signals, trust it — skip Gemini
  if (totalStrength >= 2) {
    const c6Score      = getC6Score(totalStrength);
    const c6Confidence = getC6Confidence(totalStrength);
    const c6Signals    = buildC6SignalString(firedSignals);
    Logger.log(`C6: "${company}" → deterministic strong (${totalStrength}) → score=${c6Score}`);
    EventLog.info(CURRENT_RUN_ID, company, companyObj.website || '', 'sc-c6', 'OK',
      'C6: ' + c6Score + '/20 — ' + totalStrength + ' signals (deterministic): ' + c6Signals);
    return { c6: c6Score, c6Signals, c6Confidence };
  }

  // ── Step 4: Gemini pass for ambiguous cases ───────────────
  // Deterministic found 0 or 1 signals — Gemini reads more carefully
  Logger.log(`C6: "${company}" → deterministic weak (${totalStrength}), calling Gemini`);

  const evidenceTrimmed = combinedEvidence.substring(0, 2000);
  const prompt = PROMPTS.C6.replace("{evidence}", evidenceTrimmed);
  const raw    = callGeminiWithRetry(prompt, { company, stage: 'c6' });

  if (!raw) {
    Logger.log(`C6: Gemini null for "${company}" — using deterministic result`);
    const c6Score      = getC6Score(totalStrength);
    const c6Confidence = getC6Confidence(totalStrength);
    const c6Signals    = buildC6SignalString(firedSignals) || "No signals detected";
    EventLog.warn(CURRENT_RUN_ID, company, companyObj.website || '', 'sc-c6', 'OK',
      'C6: ' + c6Score + '/20 — Gemini null, used deterministic fallback: ' + c6Signals);
    return { c6: c6Score, c6Signals, c6Confidence };
  }

  const parsed = parseGeminiJSON(raw);

  if (!parsed) {
    Logger.log(`C6: Gemini parse failed for "${company}" — using deterministic result`);
    const c6Score      = getC6Score(totalStrength);
    const c6Confidence = getC6Confidence(totalStrength);
    const c6Signals    = buildC6SignalString(firedSignals) || "No signals detected";
    return { c6: c6Score, c6Signals, c6Confidence };
  }

  // ── Step 5: Merge Gemini result with deterministic ────────
  // Count how many of the 5 boolean flags Gemini set to true
  const geminiSignals = [];
  if (parsed.hiring)        geminiSignals.push("Hiring");
  if (parsed.facility)      geminiSignals.push("Facility_Expansion");
  if (parsed.certifications) geminiSignals.push("Certifications");
  if (parsed.active)        geminiSignals.push("Active_News");
  if (parsed.exports)       geminiSignals.push("Export_Growth");

  // Merge: take the union of deterministic and Gemini signals
  const deterministicNames = firedSignals.map(s => s.signal);
  const allSignalNames     = [...new Set([...deterministicNames, ...geminiSignals])];
  const mergedStrength     = allSignalNames.length;

  const c6Score      = getC6Score(mergedStrength);
  const c6Confidence = getC6Confidence(mergedStrength);
  const reasonNote   = String(parsed.x || "").trim();

  // Build signal string: deterministic signals keep their keyword, Gemini-only ones labelled
  const deterministicStr = buildC6SignalString(firedSignals);
  const geminiOnly       = geminiSignals.filter(s => !deterministicNames.includes(s));
  const geminiStr        = geminiOnly.map(s => `${s} (Gemini)`).join(", ");
  const c6Signals        = [deterministicStr, geminiStr].filter(Boolean).join(", ")
                           || "No signals detected";

  Logger.log(`C6: "${company}" → merged strength=${mergedStrength}, score=${c6Score}`);
  Logger.log(`C6: deterministic=${deterministicNames.join(",") || "none"} | gemini=${geminiOnly.join(",") || "none"}`);
  if (reasonNote) Logger.log(`C6: Gemini note: ${reasonNote}`);
  EventLog.info(CURRENT_RUN_ID, company, companyObj.website || '', 'sc-c6', 'OK',
    'C6: ' + c6Score + '/20 — ' + mergedStrength + ' signals (merged): ' + c6Signals);

  return { c6: c6Score, c6Signals, c6Confidence };
}

// ============================================================
// SECTION 2 — SIGNAL DETECTOR
// Loops every signal in CONFIG.C6.SIGNALS.
// For each signal, checks if ANY of its keywords appear
// in the snippets. One signal = one point of strength,
// regardless of how many keywords matched within it.
// Returns firedSignals array and totalStrength count.
// ============================================================

function detectC6Signals(snippets) {
  const snippetsLower = snippets.toLowerCase();
  const firedSignals  = [];
  let totalStrength   = 0;

  for (const [signalName, signalConfig] of Object.entries(CONFIG.C6.SIGNALS)) {
    const matchedKeyword = signalConfig.keywords.find(kw =>
      snippetsLower.includes(kw.toLowerCase())
    );

    if (matchedKeyword) {
      firedSignals.push({
        signal:  signalName,
        keyword: matchedKeyword,
        weight:  signalConfig.weight,
      });
      totalStrength += signalConfig.weight;
      Logger.log(`C6: signal "${signalName}" fired — keyword: "${matchedKeyword}"`);
    } else {
      Logger.log(`C6: signal "${signalName}" — no match`);
    }
  }

  return { firedSignals, totalStrength };
}

// ============================================================
// SECTION 3 — SIGNAL STRING BUILDER
// Builds readable evidence for SCORES sheet.
// Format: "Hiring (hiring), Certifications (usfda), Export_Growth (exports)"
// The matched keyword in brackets makes it auditable.
// ============================================================

function buildC6SignalString(firedSignals) {
  if (!firedSignals || firedSignals.length === 0) return "No signals detected";
  return firedSignals
    .map(s => `${s.signal} (${s.keyword})`)
    .join(", ");
}

// ============================================================
// SECTION 4 — CONFIDENCE LEVEL
// getC6Confidence() lives in config.gs alongside getC6Score().
// ============================================================

// ============================================================
// SECTION 5 — TEST FUNCTION
// Tests three companies covering all score bands:
//   Divi's Laboratories  → expect 20 (major exporter, certs, hiring)
//   Avra Synthesis       → expect 10 (some signals, smaller presence)
//   Dummy dormant co     → expect  0 (seeded with flat snippets)
//
// Prints full signal audit per company — which keywords
// fired and which didn't — so you can verify detection logic.
// ============================================================

function testC6() {
  Logger.log("=== testC6() start ===\n");

  // --------------------------------------------------------
  // Seed cache for companies that haven't run Stage 1.
  // Divi's and Avra may already have C6 cache from prior
  // runs — the seed is skipped if cache exists.
  // --------------------------------------------------------
  const testSnippets = [
    {
      company:   "Divi's Laboratories",
      queryType: "C6",
      query:     "test",
      snippets:  [
        "Divi's Laboratories announces expansion of its Unit II manufacturing facility",
        "with a new greenfield plant approved for API production at Vizag.",
        "The company is actively hiring chemical engineers and production staff for 2024.",
        "Divi's holds USFDA and EU-GMP approved facilities for regulated market exports.",
        "Revenue growth driven by strong export demand from USA, Europe and Japan.",
        "Latest press release 2025: Divi's wins new long-term supply contracts.",
      ].join(" "),
    },
    {
      company:   "Avra Synthesis",
      queryType: "C6",
      query:     "test",
      snippets:  "Avra Synthesis offers catalogue compounds for research use. ISO certified laboratory. Contact our Hyderabad office for bulk orders.",
    },
    {
      company:   "Dormant Chemicals Ltd",
      queryType: "C6",
      query:     "test",
      snippets:  [
        "Dormant Chemicals Ltd manufactures basic industrial chemicals.",
        "Contact us at our Hyderabad office for bulk orders.",
        "We supply sodium sulphate and calcium carbonate to local industries.",
      ].join(" "),
    },
  ];

  testSnippets.forEach(({ company, queryType, query, snippets }) => {
    const existing = getCachedSearch(company, queryType);
    if (!existing) {
      saveToCache(company, queryType, query, snippets);
      Logger.log(`Seeded cache: ${company} | ${queryType}`);
    } else {
      Logger.log(`Cache already exists, skipping seed: ${company} | ${queryType}`);
    }
  });

  Logger.log("");

  // --------------------------------------------------------
  // Test cases — one per score band
  // --------------------------------------------------------
  const testCases = [
    {
      company:       "Divi's Laboratories",
      website:       "divislabs.com",
      source:        "Test",
      expect:        20,
      expectReason:  "5 signals: Hiring, Expansion, Certifications, Active_News, Export_Growth",
    },
    {
    company:      "Avra Synthesis",
    website:      "avrasynthesis.com",
    source:       "Test",
    expect:       10,
    expectReason: "1 signal only: Certifications (iso certified)",
    },
    {
      company:       "Dormant Chemicals Ltd",
      website:       "dormantchem.com",
      source:        "Test",
      expect:        0,
      expectReason:  "No growth signals — basic local supplier, no hiring/expansion/certs/news",
    },
  ];

  let passed = 0;
  let failed = 0;

  testCases.forEach(({ company, website, source, expect, expectReason }) => {
    Logger.log(`--- Testing: ${company} ---`);
    Logger.log(`Expected score: ${expect} — ${expectReason}`);

    const result = runC6({ company, website, source });

    Logger.log(`Score:      ${result.c6}`);
    Logger.log(`Signals:    ${result.c6Signals}`);
    Logger.log(`Confidence: ${result.c6Confidence}`);
    Logger.log(`C6 contributes ${result.c6}/20 toward final score`);

    if (result.c6 === expect) {
      Logger.log(`✓ PASS`);
      passed++;
    } else {
      Logger.log(`✗ FAIL — expected ${expect}, got ${result.c6}`);
      failed++;
    }

    Logger.log("");
  });

  // --------------------------------------------------------
  // Summary
  // --------------------------------------------------------
  Logger.log(`--- Results: ${passed} passed, ${failed} failed ---\n`);

  // --------------------------------------------------------
  // Signal keyword audit — prints every signal and its
  // keywords. Run after editing CONFIG.C6.SIGNALS to verify.
  // --------------------------------------------------------
  Logger.log("--- C6 signal map ---");
  for (const [signalName, signalConfig] of Object.entries(CONFIG.C6.SIGNALS)) {
    Logger.log(`${signalName} (weight: ${signalConfig.weight})`);
    Logger.log(`   Keywords: ${signalConfig.keywords.join(", ")}`);
  }

  Logger.log("\n--- Score thresholds ---");
  CONFIG.C6.SCORE_MAP.forEach(entry => {
    Logger.log(`  Strength ≥ ${entry.minStrength} → ${entry.score}pts`);
  });

  Logger.log("\n=== testC6() complete ===");
}

// ===== FILE: config.js =====
// ============================================================
// config.gs — Central Configuration for ICP Pipeline
// ============================================================

const CONFIG = {
  // ----------------------------------------------------------
  // API KEYS
  // ----------------------------------------------------------
  KEYS: {
    get SERPER() {
      return PropertiesService
        .getScriptProperties()
        .getProperty('SERPER_API_KEY');
    },

    get GEMINI() {
      return PropertiesService
        .getScriptProperties()
        .getProperty('GEMINI_API_KEY');
    }
  },

  // ----------------------------------------------------------
  // GEMINI CONFIG
  // ----------------------------------------------------------
  GEMINI: {

    MODEL: "gemini-2.5-flash",
    ENDPOINT: "https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent",

    //MODEL: "gemini-2.0-flash",
    //ENDPOINT: "https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent",

    MAX_TOKENS: 2048,

    TEMPERATURE: 0,
  },



  // ----------------------------------------------------------
  // GEMINI BATCH CONFIG
  // ----------------------------------------------------------
  BATCH_API: {

    ENABLED: true,

    MAX_BATCH_SIZE: 20,

    POLL_INTERVAL_MS: 10000,

    MAX_WAIT_MS: 300000,
  },



  // ----------------------------------------------------------
  // PIPELINE CONTROLS
  // ----------------------------------------------------------
  PIPELINE: {

    // ONLY these pass Stage-1
    STAGE1_PASS_BANDS: [
      "50-500Cr"
    ],
  },



  // ----------------------------------------------------------
  // BATCH & RATE LIMITING
  // ----------------------------------------------------------
  BATCH: {

    SIZE: 5,

    SERPER_SLEEP: 1200,

    GEMINI_SLEEP: 8000, // prev 3000

    RETRY_SLEEPS: [10000, 20000, 30000],  // CHANGED: was [10000, 15000, 30000] — longer backoff on 503s
    
    MAX_RETRIES: 3,
  },



  // ----------------------------------------------------------
  // STAGE 1 FILTERS
  // ----------------------------------------------------------
  STAGE1: {

    // --------------------------------------------------------
    // MANUFACTURER SIGNALS
    // --------------------------------------------------------
    MANUFACTURING: [

      "manufacturing",
      "manufacturer",
      "plant",
      "factory",
      "production facility",
      "production unit",
      "gmp facility",
      "processing unit",
      "fabrication",
      "we manufacture",
      "our plant",
      "our facility",
      "r&d facility",
      "manufacturing unit",
      "production capacity",
      "formulation plant",
      "gmp certified",
      "industrial estate",
      "pilot plant",
      "reactor capacity",
      "synthesis facility",
      "bulk manufacturing",
      "api manufacturing",
      "speciality chemicals manufacturing",
      "fermentation facility",
      "clean room",
      "assembly line",
      "manufacturing campus",
    ],


    // --------------------------------------------------------
    // TRADER SIGNALS
    // --------------------------------------------------------
    TRADER: [

      "trading company",
      "trader",
      "distributor",
      "wholesaler",
      "stockist",
      "importer",
      "we trade",
      "wholesale dealer",
      "reseller",
      "merchant exporter",
      "sourcing company",
    ],


    // --------------------------------------------------------
    // CRO / SERVICE SIGNALS
    // --------------------------------------------------------
    CRO: [

      " cro ",
      "contract research organization",
      "cro company",
      "cro services",
      "clinical research organization",
      "contract research and development services",
      "drug discovery services",
      "analytical testing services",
      "bioanalytical services",
      "clinical trial services",
      "research services only",
      "testing laboratory",
      "analytical laboratory",
      "contract testing",
      "testing services",
    ],


    // --------------------------------------------------------
    // PE / ACQUIRED SIGNALS
    // --------------------------------------------------------
    PE_ACQUIRED: [

      "acquired by",
      "acquisition by",
      "stake acquired",
      "majority stake",
      "private equity",
      "pe-backed",
      "portfolio company",
      "taken over by",

      "kkr",
      "blackstone",
      "advent international",
      "chryscapital",
      "carlyle",
      "warburg pincus",
      "general atlantic",
      "tpg capital",
      "bain capital",
      "kedaara",
      "multiples pe",
      "true north",
    ],


    // --------------------------------------------------------
    // DIRECT REVENUE EXTRACTION
    // --------------------------------------------------------
    REVENUE: {

      REGEX:
        /(?:revenue|turnover|sales)[^\d]{0,30}(?:rs\.?|₹|inr)?\s*([\d,]+(?:\.\d+)?)\s*(?:cr|crore|crs)/i,

      MIN_CR: 50,

      MAX_CR: 500,
    },
  },



  // ----------------------------------------------------------
  // REVENUE CONFIG
  // ----------------------------------------------------------
  REVENUE: {

    // --------------------------------------------------------
    // REVENUE BANDS
    // --------------------------------------------------------
    BANDS: {

      VERY_SMALL: "<50Cr",

      MID: "50-500Cr",

      LARGE: "500-1500Cr",

      VERY_LARGE: ">1500Cr",

      UNKNOWN: "Unknown",
    },


    // --------------------------------------------------------
    // CONFIDENCE LEVELS
    // --------------------------------------------------------
    CONFIDENCE: {

      HIGH: "High",

      MEDIUM: "Medium",

      LOW: "Low",
    },


    // --------------------------------------------------------
    // REVENUE SIGNAL KEYWORDS
    // --------------------------------------------------------
    SIGNAL_KEYWORDS: [

      "employees",
      "exports",
      "manufacturing facility",
      "production capacity",
      "global markets",
      "subsidiaries",
      "hiring",
      "expansion",
      "new plant",
      "certifications",
      "usfda",
      "eu-gmp",
      "dsir",
      "international presence",
      "export revenue",
      "gmp",
      "manufacturing unit",
      "production unit",
      "factory",
      "clean room",
      "reactor capacity",
      "global customers",
    ],
  },



  // ----------------------------------------------------------
  // SERPER QUERY TEMPLATES
  // ----------------------------------------------------------
  QUERIES: {

    STAGE1_MFG:
      '"{company}" manufacturer plant factory production facility',

    STAGE1_BIZ:
      '"{company}" acquired PE investment private equity',

    REVENUE_DIRECT:
      '"{company}" (site:tofler.in OR site:zaubacorp.com OR site:screener.in OR site:moneycontrol.com OR site:tracxn.com) ("revenue" OR "turnover" OR "operating revenue") ("2024" OR "2025" OR "FY24" OR "FY25")',

    REVENUE_SIGNALS:
      '"{company}" ("annual revenue" OR "turnover" OR "crore" OR "employees" OR "workforce" OR "manufacturing plant" OR "production capacity" OR "export" OR "founded") -site:justdial.com -site:indiamart.com -site:tradeindia.com -site:facebook.com -site:instagram.com -site:sulekha.com -site:exportersindia.com',

    // CHANGED: was too narrow — demanded patents+DSIR+USFDA+WHO-GMP+EU-GMP all at once
    C3: '"{company}" manufacturer India R&D innovation product proprietary',

    // C4 name resolution — three targeted gates, tried in order
    C4_TOFLER:  '"{company}" (director OR "managing director" OR founder OR promoter) site:tofler.in',
    C4_ZAUBA:   '"{company}" (director OR "managing director" OR founder OR promoter) site:zaubacorp.com',
    C4_GENERAL: '"{company}" ("managing director" OR "proprietor" OR "founder") India',

    C4_BACKGROUND: '"{person}" "{company}" education qualification engineer scientist PhD doctorate IIT IISc IISER NIT BITS ISRO DRDO patent publication',

    C6: '"{company}" India 2024 2025',
  },



  // ----------------------------------------------------------
  // C3 CONFIG
  // ----------------------------------------------------------
  C3: {

    SIGNAL_WEIGHTS: {

      "Patents": 2,

      "DSIR": 2,

      "Regulatory_Approvals": 2,

      "Proprietary_Products": 1,

      "Pioneer_Claims": 1,

      "Custom_Synthesis": 1,

      "Commodity_Chemicals": -2,
    },

    SCORE_MAP: [
      { minWeight: 4, score: 25 },

      { minWeight: 1, score: 12 },

      { minWeight: 0.5, score: 6 },

      { minWeight: 0, score: 0 },
    ],

    COMMODITY_FLOOR: -0.5,

    CONFIDENCE_MAP: [

      { minWeight: 4, level: "High" },

      { minWeight: 1, level: "Medium" },

      { minWeight: 0, level: "Low" },
    ],
  },



  // ----------------------------------------------------------
  // C4 CONFIG
  // ----------------------------------------------------------
  C4: {

    STRONG_SIGNALS: [

      "iit",
      "iim",
      "iiser",
      "iisc",
      "nit",
      "bits pilani",
      "phd",
      "ph.d",
      "doctorate",
      "ex-isro",
      "ex-drdo",
      "isro",
      "drdo",
      "chief scientist",
      "lead scientist",
      "principal scientist",
      "research fellow",
      "published",
      "patent holder",
    ],

    MODERATE_SIGNALS: [

      "engineer",
      "engineering",
      "b.tech",
      "b.e.",
      "m.tech",
      "m.sc",
      "technical background",
      "technical founder",
      "r&d head",
    ],

    SCORE_MAP: {

      "Strong": 20,

      "Moderate": 10,

      "None": 0,
    },
  },



  // ----------------------------------------------------------
  // C5 — GROWING SECTOR
  // ----------------------------------------------------------
  C5: {
  SECTOR_KEYWORDS: [
    // ---- HIGH TAILWIND (score 20) ----
    {
      sector: "Pharma & API",
      score: 20,
      keywords: ["api", "active pharmaceutical ingredient", "pharmaceutical intermediates",
        "bulk drugs", "pharma intermediates", "drug intermediates", "formulation",
        "nutraceutical", "generic drugs"],
      reason: "API localisation, regulated market exports.",
    },
    {
      sector: "Specialty biotech",
      score: 20,
      keywords: ["recombinant protein", "biologics", "fermentation", "enzyme",
        "probiotic", "biosimilar", "cell culture", "microbial", "biotech manufacturing"],
      reason: "High-growth specialty biotech.",
    },
    {
      sector: "Electronic & semiconductor chemicals",
      score: 20,
      keywords: ["electronic chemicals", "semiconductor", "display chemicals",
        "pcb chemicals", "etching", "photoresist"],
      reason: "Semiconductor manufacturing expansion and China+1 tailwinds.",
    },
    {
      sector: "Specialty chemicals",
      score: 20,
      keywords: ["specialty chemicals", "speciality chemicals", "fine chemicals",
        "organometallic", "niche intermediates", "advanced intermediates"],
      reason: "Export-oriented specialty manufacturing.",
    },
    {
      sector: "Defence & aerospace components",
      score: 20,
      keywords: ["defence", "defense", "aerospace", "drdo", "isro", "missile",
        "avionics", "military", "armament"],
      reason: "Strong government capex and Make-in-India push.",
    },
    {
      sector: "Medical devices & equipment",
      score: 20,
      keywords: ["medical device", "surgical", "implant", "diagnostic equipment",
        "medical equipment", "hospital equipment", "icu equipment", "ventilator"],
      reason: "High-growth domestic demand + export potential.",
    },

    // ---- STRONG TAILWIND (score 18) ----
    {
      sector: "Agrochemical intermediates",
      score: 18,
      keywords: ["agrochemical", "agrochem", "crop protection", "pesticide",
        "herbicide", "fungicide", "insecticide"],
      reason: "Agrochemical export growth.",
    },
    {
      sector: "Auto & EV components",
      score: 18,
      keywords: ["auto component", "automotive component", "ev component",
        "electric vehicle", "battery pack", "drivetrain", "chassis", "powertrain",
        "tier 1 supplier", "tier-1"],
      reason: "EV transition + auto PLI scheme.",
    },
    {
      sector: "Precision engineering & machined parts",
      score: 18,
      keywords: ["precision machined", "precision engineering", "cnc machining",
        "forging", "casting", "stamping", "sheet metal", "machined components",
        "turned parts", "tooling", "ball bearing", "roller bearing"],
      reason: "Export demand + import substitution.",
    },
    {
      sector: "Electronics & PCB manufacturing",
      score: 18,
      keywords: ["pcb", "printed circuit board", "electronics manufacturing",
      "electronic manufacturing services", "smt", "surface mount technology","electronics assembly"],
      reason: "PLI for electronics + China+1.",
    },

    // ---- MODERATE TAILWIND (score 16) ----
    {
      sector: "Dyes & colorants",
      score: 16,
      keywords: ["dyestuff", "dye manufacturer", "colorant", "reactive dye",
        "disperse dye", "acid dye", "pigment manufacturer", "colour intermediate"],
      reason: "China+1 tailwind in dyes/colorants; India gaining export share.",
    },
    {
      sector: "Electrical equipment & cables",
      score: 16,
      keywords: ["electric motor", "transformer", "switchgear", "cable manufacturer",
        "wire manufacturer", "electrical equipment", "winding wire", "conductor manufacturer"],
      reason: "Capex cycle + power infra + EV charging buildout.",
    },
    {
      sector: "Polymer & rubber products",
      score: 16,
      keywords: ["resin", "polymer", "rubber", "gasket", "polymer additives",
        "performance chemicals", "compounding", "masterbatch", "pvc pipes",
        "pipe fittings", "plastic extrusion", "blow moulding", "rotomoulding"],
      reason: "Industrial materials demand.",
    },
    {
      sector: "Technical textiles & performance fabrics",
      score: 16,
      keywords: ["technical textile", "performance fabric", "nonwoven",
        "geotextile", "protective textile", "industrial fabric", "filtration fabric"],
      reason: "Technical textiles PLI and global shift from commodity to functional.",
    },
    {
      sector: "Packaging — specialty & flexible",
      score: 16,
      keywords: ["flexible packaging", "specialty packaging", "multilayer",
        "barrier film", "laminates", "aseptic packaging", "blister packaging",
        "woven sacks", "fibc", "bulk bags", "raffia"],
      reason: "FMCG and pharma packaging growth.",
    },
    {
      sector: "Industrial equipment & machinery",
      score: 16,
      keywords: ["industrial equipment", "industrial machinery", "process equipment",
        "heat exchanger", "pressure vessel", "reactor", "separator", "pump manufacturer",
        "valve manufacturer", "compressor"],
      reason: "Capex cycle and infrastructure push.",
    },
    {
      sector: "Food processing & ingredients",
      score: 16,
      keywords: ["food processing", "food ingredients", "food additives",
        "spice extract", "oleoresin", "natural extract", "flavour", "flavor",
        "food grade"],
      reason: "Processed food exports and value-added food manufacturing.",
    },
    {
      sector: "Water treatment chemicals",
      score: 15,
      keywords: ["water treatment", "effluent treatment", "water purification chemicals"],
      reason: "Sustainability and industrial water demand.",
    },

    // ---- LOWER-MODERATE TAILWIND (score 14) ----
    {
      sector: "Paint & coatings",
      score: 14,
      keywords: ["paint", "coating", "coatings", "varnish", "lacquer",
        "primer", "alkyd", "epoxy coating", "decorative paint",
        "industrial coating", "protective coating", "paint manufacturer"],
      reason: "Growing domestic construction + infrastructure market.",
    },

    // ---- STANDARD (score 12) ----
    // NOTE: "Steel & metal fabrication" is checked before "Textile — commodity"
    // because the textile sector's "fabric" keyword is a substring of
    // "fabrication" — without this order, "steel fabrication" would
    // wrongly match Textile via "fabric" before reaching Steel.
    {
      sector: "Steel & metal fabrication",
      score: 12,
      keywords: ["steel fabrication", "metal fabrication", "structural steel",
        "stainless steel", "aluminium extrusion", "copper product", "brass"],
      reason: "Steady demand but low differentiation.",
    },
    {
      sector: "Textile — commodity",
      score: 12,
      keywords: ["spinning", "weaving", "yarn", "fabric", "dyeing", "textile mill",
        "garment", "apparel", "hosiery"],
      reason: "Large sector but highly competitive, low margins.",
    },
    {
      sector: "Construction materials",
      score: 12,
      keywords: ["cement", "tiles", "ceramic", "sanitary ware", "roofing",
        "construction chemical", "building material", "glass"],
      reason: "Infrastructure boom but commoditised.",
    },
    {
      sector: "Tools, hardware & misc engineering goods",
      score: 12,
      keywords: ["hand tools", "cutting tools", "tools manufacturer", "bicycle",
        "bicycle parts", "cycle components", "hardware manufacturer",
        "marine equipment", "shipbuilding", "marine components"],
      reason: "Stable export demand, lower differentiation.",
    },
    {
      sector: "Paper & packaging — commodity",
      score: 12,
      keywords: ["paper mill", "kraft paper", "corrugated box", "carton",
        "paperboard"],
      reason: "Stable but commodity pricing.",
    },

    // ---- LOW TAILWIND (score 8) ----
    {
      sector: "Commodity / basic chemicals",
      score: 8,
      keywords: ["commodity chemicals", "basic chemicals", "bulk chemicals",
        "inorganic chemicals", "sodium sulphate", "calcium carbonate"],
      reason: "Lower differentiation.",
    },
    {
      sector: "Plastic — commodity moulding",
      score: 8,
      keywords: ["injection moulding", "plastic moulding", "plastic containers",
        "hdpe", "ldpe", "pp granules", "pet bottles"],
      reason: "Commodity, price-driven.",
    },

    // ---- VERY LOW (score 2) ----
    {
      sector: "CRO / CDMO / service",
      score: 2,
      keywords: ["cro", "cdmo", "contract research organization",
        "clinical research organization", "drug discovery services",
        "analytical testing services"],
      reason: "Service-oriented business.",
    },
  ],

  DEFAULT: {
    sector: "Other manufacturing",
    score: 8,
    reason: "Manufacturer confirmed but sector not specifically identified.",
  },
},


  // ----------------------------------------------------------
  // C6 — GROWTH SIGNALS
  // ----------------------------------------------------------
  C6: {

    SIGNALS: {

      Hiring: {
        weight: 1,
        keywords: [
          "careers",
          "job openings",
          "recruitment",
          "hiring",
          "join our team",
          "vacancies",
          "we are hiring"
        ],
      },

      Facility_Expansion: {
        weight: 1,
        keywords: [
          "new plant",
          "expansion",
          "capacity increase",
          "scale-up",
          "greenfield",
          "brownfield",
          "new facility",
          "upgraded facility",
          "new unit"
        ],
      },

      Certifications: {
        weight: 1,
        keywords: [
          "who-gmp",
          "usfda",
          "eu-gmp",
          "iso certified",
          "dsir",
          "halal",
          "kosher",
          "reach certified",
          "gmp certified",
          "approved facility"
        ],
      },

      Active_News: {
        weight: 1,
        keywords: [
          "2024",
          "2025",
          "press release",
          "latest news",
          "recent",
          "announcement",
          "blog"
        ],
      },

      Export_Growth: {
        weight: 1,
        keywords: [
          "exports",
          "export destinations",
          "global markets",
          "international customers",
          "usa",
          "europe",
          "japan",
          "revenue growth",
          "export revenue"
        ],
      },
    },

    SCORE_MAP: [
      { minStrength: 2, score: 20 },
      { minStrength: 1, score: 10 },
      { minStrength: 0, score: 0 },
    ],

    CONFIDENCE_MAP: [
      { minStrength: 3, level: "High" },
      { minStrength: 1, level: "Medium" },
      { minStrength: 0, level: "Low" },
    ],
  },



  // ----------------------------------------------------------
  // FINAL SCORE WEIGHTS
  // ----------------------------------------------------------
  WEIGHTS: {

    C1: 10,

    C2: 5,

    C3: 25,

    C4: 20,

    C5: 20,

    C6: 20,
  },



  // ----------------------------------------------------------
  // BAND CLASSIFICATION
  // ----------------------------------------------------------
  BANDS: [

    {
      min: 80,
      max: 100,
      band: "A",
      label: "Strong Federer"
    },

    {
      min: 60,
      max: 79,
      band: "B",
      label: "Probable Federer"
    },

    {
      min: 40,
      max: 59,
      band: "C",
      label: "Borderline"
    },

    {
      min: 0,
      max: 39,
      band: "D",
      label: "Not ICP"
    },
  ],

  SHORTLIST_MIN_BAND: "B",

  SHORTLIST_TARGET: 25,

  // ----------------------------------------------------------
  // TOKEN LOG
  // ----------------------------------------------------------
  TOKEN_LOG: {
    SHEET_NAME: 'TOKEN_LOG',
  },

  // ----------------------------------------------------------
  // GEMINI COST RATES
  // USD per million tokens — update when Google changes pricing.
  // INR conversion uses INR_PER_USD below.
  // ----------------------------------------------------------
  COST_RATES: {
    'gemini-2.5-flash': {
      inputPerMillion:    0.075,
      outputPerMillion:   0.30,
      thinkingPerMillion: 3.50,
    },
    'gemini-2.0-flash': {
      inputPerMillion:    0.075,
      outputPerMillion:   0.30,
      thinkingPerMillion: 0.0,
    },
    serper: {
      perCall: 0.001, // USD per search — update if on a different Serper plan
    },
  },

  INR_PER_USD: 84,

  // ----------------------------------------------------------
  // CIRCUIT BREAKER
  // ----------------------------------------------------------
  CIRCUIT_BREAKER: {
    GEMINI_THRESHOLD: 12,
    SERPER_THRESHOLD: 8,
    COOLDOWN_MINUTES: 15,
  },

  // ----------------------------------------------------------
  // ADAPTIVE RATE LIMITING
  // Floors/ceilings for per-run adaptive sleep values.
  // BACKOFF_FACTOR multiplies sleep on 429/503.
  // DECAY_FACTOR multiplies sleep on success (gradual speedup).
  // ----------------------------------------------------------
  ADAPTIVE_RATE: {
    GEMINI_MIN_SLEEP:  4000,   // fastest allowed — ~15 RPM
    GEMINI_MAX_SLEEP:  30000,  // slowest allowed — after heavy rate limiting
    SERPER_MIN_SLEEP:  800,
    SERPER_MAX_SLEEP:  10000,
    BACKOFF_FACTOR:    1.5,    // 1 backoff: 8000 → 12000ms
    DECAY_FACTOR:      0.95,   // ~14 successes to go from 8000ms → 4000ms floor
  },

  // ----------------------------------------------------------
  // PIPELINE SUMMARY
  // ----------------------------------------------------------
  PIPELINE_SUMMARY: {
    SHEET_NAME:     'PIPELINE_SUMMARY',
    S1_INTERVAL:    25,   // rebuild after every N companies in Stage 1 loop
    SCORE_INTERVAL: 10,   // rebuild after every N companies in scoring loop
  },
};


// ============================================================
// HELPERS
// ============================================================

function buildQuery(template, companyName) {

  return template.replace(
    /\{company\}/g,
    companyName
  );
}



function getC3Score(totalWeight) {

  for (const entry of CONFIG.C3.SCORE_MAP) {

    if (totalWeight >= entry.minWeight) {
      return entry.score;
    }
  }

  return 0;
}



function getBand(finalScore) {

  for (const entry of CONFIG.BANDS) {

    if (
      finalScore >= entry.min &&
      finalScore <= entry.max
    ) {

      return {
        band: entry.band,
        label: entry.label,
      };
    }
  }

  return {
    band: "D",
    label: "Not ICP",
  };
}

function getC6Score(totalStrength) {
  for (const entry of CONFIG.C6.SCORE_MAP) {
    if (totalStrength >= entry.minStrength) return entry.score;
  }
  return 0;
}

function getC6Confidence(totalStrength) {
  for (const entry of CONFIG.C6.CONFIDENCE_MAP) {
    if (totalStrength >= entry.minStrength) return entry.level;
  }
  return "Low";
}



// ===== FILE: dsirMatcher.js =====
// ============================================================
// dsirMatcher.gs
// Cross-references any shortlist sheet against the DSIR R&D
// 2025 directory and writes results to a DSIR_MATCHES tab.
// ============================================================

const DSIR_SHEET_ID = "1hGbS1Rjynz6VZ5CNzjrWUXZmAm9Dvee-Vias4GlQZ4o";
const DSIR_TAB_NAME = "Companies";

// ── Column indices in any shortlist sheet (0-based) ─────────
const SL_COMPANY = 1;   // "Company Name"
const SL_WEBSITE = 2;   // "Website"
const SL_SCORE   = 15;  // "Final_Score"
const SL_BAND    = 16;  // "Band"

// ── Column indices in DSIR sheet (0-based) ──────────────────
const DSIR_RECOG = 1;   // "Recognition Number"
const DSIR_NAME  = 2;   // "Company Name"
const DSIR_STATE = 3;   // "State"
const DSIR_VALID = 4;   // "Valid Upto"


// ============================================================
// NORMALISE — strips legal suffixes + punctuation for matching
// ============================================================
function _normDSIR_(name) {
  return String(name)
    .toLowerCase()
    .replace(/[.\-,&()']/g, ' ')
    .replace(/\b(pvt|private|ltd|limited|co|corp|corporation|india|industries|inc|llp|the)\b/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}


// ============================================================
// SHARED CORE — called by both public functions
// ============================================================
function _runDsirMatch_(sourceSheetName, outputTabName) {
  const ss           = SpreadsheetApp.getActiveSpreadsheet();
  const sourceSheet  = ss.getSheetByName(sourceSheetName);

  if (!sourceSheet || sourceSheet.getLastRow() < 2) {
    SpreadsheetApp.getUi().alert(`"${sourceSheetName}" sheet is empty or missing.`);
    return;
  }

  // ── 1. Build DSIR lookup map ─────────────────────────────
  Logger.log(`[_runDsirMatch_] Opening DSIR sheet for "${sourceSheetName}"...`);
  const dsirSS    = SpreadsheetApp.openById(DSIR_SHEET_ID);
  const dsirSheet = dsirSS.getSheetByName(DSIR_TAB_NAME);
  if (!dsirSheet) throw new Error("DSIR 'Companies' tab not found.");

  const dsirData = dsirSheet
    .getRange(2, 1, dsirSheet.getLastRow() - 1, 5)
    .getValues();

  const dsirMap = new Map();
  dsirData.forEach(row => {
    const rawName = String(row[DSIR_NAME] || "").trim();
    if (!rawName) return;
    const key = _normDSIR_(rawName);
    if (!dsirMap.has(key)) {
      dsirMap.set(key, {
        recognitionNo: String(row[DSIR_RECOG] || "").trim(),
        companyName:   rawName,
        state:         String(row[DSIR_STATE] || "").trim(),
        validUpto:     String(row[DSIR_VALID]  || "").trim(),
      });
    }
  });

  Logger.log(`[_runDsirMatch_] DSIR map: ${dsirMap.size} entries`);

  // ── 2. Load source shortlist ─────────────────────────────
  const numRows = sourceSheet.getLastRow() - 1;
  const numCols = sourceSheet.getLastColumn();
  const slData  = sourceSheet.getRange(2, 1, numRows, numCols).getValues();

  // ── 3. Match ─────────────────────────────────────────────
  const outputRows = [];

  slData.forEach(row => {
    const company = String(row[SL_COMPANY] || "").trim();
    if (!company) return;

    const website = String(row[SL_WEBSITE] || "").trim();
    const band    = String(row[SL_BAND]    || "").trim();
    const score   = row[SL_SCORE];

    const normCompany = _normDSIR_(company);

    let match     = dsirMap.get(normCompany) || null;
    let matchType = match ? "Exact" : "";

    if (!match) {
      for (const [key, val] of dsirMap) {
        if (key.startsWith(normCompany) || normCompany.startsWith(key)) {
          match     = val;
          matchType = "Partial";
          break;
        }
      }
    }

    outputRows.push([
      company,
      website,
      band,
      score,
      match ? "YES" : "NO",
      match ? match.recognitionNo : "",
      match ? match.companyName   : "",
      match ? match.state         : "",
      match ? match.validUpto     : "",
      matchType,
    ]);
  });

  // ── 4. Write output tab ───────────────────────────────────
  let outSheet = ss.getSheetByName(outputTabName);
  if (outSheet) {
    outSheet.clearContents();
    outSheet.clearFormats();
  } else {
    outSheet = ss.insertSheet(outputTabName);
  }

  const headers = [
    "Company Name", "Website", "Band", "Final Score",
    "In DSIR?", "Recognition Number", "DSIR Company Name",
    "State", "Valid Upto", "Match Type",
  ];

  outSheet.getRange(1, 1, 1, headers.length).setValues([headers]);
  if (outputRows.length > 0) {
    outSheet.getRange(2, 1, outputRows.length, headers.length).setValues(outputRows);
  }

  // ── 5. Format ─────────────────────────────────────────────
  outSheet.getRange(1, 1, 1, headers.length).setFontWeight("bold");
  outSheet.setFrozenRows(1);

  for (let i = 0; i < outputRows.length; i++) {
    const color = outputRows[i][4] === "YES" ? "#d9ead3" : "#fce5cd";
    outSheet.getRange(i + 2, 1, 1, headers.length).setBackground(color);
  }

  SpreadsheetApp.flush();

  const matched = outputRows.filter(r => r[4] === "YES").length;
  const msg = `Done — ${matched} of ${outputRows.length} companies from "${sourceSheetName}" found in DSIR.`;
  Logger.log(`[_runDsirMatch_] ${msg}`);
  SpreadsheetApp.getActive().toast(msg, "DSIR Match Complete", 8);
}


// ============================================================
// PUBLIC ENTRY POINTS
// ============================================================
function matchShortlistToDSIR() {
  _runDsirMatch_(SHEETS.SHORTLIST, "DSIR_MATCHES");
}

function match540ShortlistToDSIR() {
  _runDsirMatch_("540_SHORTLIST", "DSIR_MATCHES_540");
}


// ===== FILE: main.js =====
// ============================================================
// main.gs
// ICP PIPELINE ORCHESTRATOR
// Flow: runInitialPipeline → runFinalScoringPipeline
// ============================================================

// ============================================================
// SECTION 1 — GLOBALS
// ============================================================
var START_TIME        = null;
var CURRENT_RUN_ID    = null;
var PENDING_QUEUE_KEY = 'PENDING_QUEUE';

function makeRunId_(prefix) {
  return prefix + '-' + Utilities.formatDate(new Date(), Session.getScriptTimeZone(), 'MMdd-HHmm');
}

// Persist pending company names to PropertiesService after every push.
// Snippets are not stored — they are retrieved from SEARCH_CACHE on reload.
function savePendingQueue_(pending) {
  try {
    PropertiesService.getScriptProperties().setProperty(
      PENDING_QUEUE_KEY,
      JSON.stringify(pending.map(p => ({
        company: p.company,
        website: (p.companyObj && p.companyObj.website) || '',
        source:  (p.companyObj && p.companyObj.source)  || '',
      })))
    );
  } catch (e) {
    Logger.log('[savePendingQueue ERROR] ' + e.message);
  }
}

// Clear the persisted queue after every successful flush.
function clearPendingQueue_() {
  try {
    PropertiesService.getScriptProperties().deleteProperty(PENDING_QUEUE_KEY);
  } catch (e) {}
}

// ============================================================
// SECTION 2 — TIME LIMIT GUARD
// ============================================================
function isNearTimeLimit() {
  if (!START_TIME) return false;
  return (new Date() - START_TIME) / 1000 > 300;
}

// ============================================================
// SECTION 3 — CLEAN COMPANY NAME
// ============================================================
function cleanCompanyName(rawName) {
  try {
    if (!rawName) return "";
    let cleaned = String(rawName);
    cleaned = cleaned.split(",")[0];
    cleaned = cleaned.replace(/\(.*?\)/g, "");
    cleaned = cleaned.replace(/formerly.*/gi, "");
    cleaned = cleaned.replace(/plot no.*$/gi, "");
    cleaned = cleaned.replace(/unit:.*$/gi, "");
    cleaned = cleaned.split("/")[0];
    cleaned = cleaned.split("&")[0];
    cleaned = cleaned.replace(/\s+/g, " ");
    return cleaned.trim();
  } catch (err) {
    Logger.log(`[cleanCompanyName ERROR] ${err.message}`);
    return String(rawName || "").trim();
  }
}

// ============================================================
// SECTION 4 — STAGE 1 GATES
// Moved to pipeline.js:
//   runManufacturingGate()   Gate 2
//   runAcquiredGate()        Gate 3
//   runPostRevenueGates()    Gate 2+3 combined (shared by direct + Gemini paths)
//   runCompany()             Full Gate 1→2→3 per-company flow
// ============================================================

// ============================================================
// SECTION 5 — PROCESS ONE COMPANY
// ============================================================
function processCompanyStage1(companyObj) {
  try {
    const result = runCompany(companyObj);
    writeStage1Result(companyObj, result);
    Logger.log(`[Stage1 ${result.status}] ${companyObj.company}`);
    if (result.status !== 'PENDING_REVENUE') {
      const level = result.status === 'PASS' ? 'info' : 'warn';
      EventLog[level](CURRENT_RUN_ID, companyObj.company, companyObj.website || '', 's1-done',
        result.status,
        result.status === 'PASS'
          ? 'Stage 1 PASS — revenue: ' + (result.revenueBand && result.revenueBand.band || '')
          : 'Stage 1 ' + result.status + (result.failReason ? ' — ' + result.failReason : '')
      );
    }
    return {
      success:      true,
      company:      companyObj.company,
      stage1Status: result.status,
    };
  } catch (err) {
    Logger.log(`[processCompanyStage1 ERROR] ${companyObj.company} | ${err.message}`);
    EventLog.error(CURRENT_RUN_ID, companyObj.company, companyObj.website || '', 's1-done', 'ERROR',
      'Unhandled exception: ' + err.message);
    flagForReview(companyObj, err.message);
    return {
      success:      false,
      company:      companyObj.company,
      stage1Status: "ERROR",
    };
  }
}

// ============================================================
// SECTION 5B — DRAIN LEFTOVER PENDING REVENUE
// Scans STAGE1 for any PENDING_REVENUE rows left by a previous
// crashed run (crash before flush) and resolves them via Gemini.
// Called at the top of runInitialPipeline before the main loop.
// ============================================================
function drainPendingRevenue() {
  try {
    const ss    = SpreadsheetApp.getActiveSpreadsheet();
    const sheet = ss.getSheetByName(SHEETS.STAGE1);
    if (!sheet || sheet.getLastRow() < 2) return [];

    const data     = sheet.getRange(2, 1, sheet.getLastRow() - 1, 11).getValues();
    const leftover = [];

    data.forEach((row, idx) => {
      const company = String(row[0] || '').trim();
      const status  = String(row[9] || '').trim();
      if (!company || status !== 'PENDING_REVENUE') return;

      const cleanName = cleanCompanyName(company);
      leftover.push({
        companyObj:     { company, website: String(row[1] || ''), source: String(row[2] || '') },
        company:        cleanName,
        directSnippet:  getCachedSearch(cleanName, 'REVENUE_DIRECT')  || '',
        signalsSnippet: getCachedSearch(cleanName, 'REVENUE_SIGNALS') || '',
        rowNum:         idx + 2, // direct index avoids cleaned-name lookup mismatch
      });
    });

    return leftover;
  } catch (err) {
    Logger.log(`[drainPendingRevenue ERROR] ${err.message}`);
    return [];
  }
}

// ============================================================
// SECTION 6 — INITIAL PIPELINE
// Runs Stage 1 for all companies
// Gemini batch resolution happens inline — no separate step needed
// Run this first. Then run runFinalScoringPipeline.
// ============================================================
function runInitialPipeline() {
  START_TIME     = new Date();
  CURRENT_RUN_ID = makeRunId_('S1');
  batchFailuresInit_(CURRENT_RUN_ID);
  Logger.log(`=== runInitialPipeline START ===`);

  if (CircuitBreaker.isHalted('GEMINI') || CircuitBreaker.isHalted('SERPER')) {
    Logger.log('[runInitialPipeline] Circuit breaker still halted — aborting. Auto-resume is scheduled.');
    return;
  }

  let pending = []; // declared outside try so catch can flush it on fatal error

  try {
    const companies = getCompanies();
    if (!companies.length) {
      Logger.log(`[runInitialPipeline] No companies found`);
      return;
    }

    EventLog.info(CURRENT_RUN_ID, '', '', 'sys-run-start', 'OK',
      'Stage 1 started — ' + companies.length + ' companies in queue');

    // ── Drain any PENDING_REVENUE left by a previous crash ───
    const leftover = drainPendingRevenue();
    if (leftover.length) {
      Logger.log(`[runInitialPipeline] Draining ${leftover.length} leftover PENDING_REVENUE companies`);
      EventLog.warn(CURRENT_RUN_ID, '', '', 'sys-drain', '-',
        'Found ' + leftover.length + ' PENDING_REVENUE rows from previous run — resolving now');
      resolveGeminiBatch(leftover);
    }

    const checkpoint = getCheckpoint();
    Logger.log(`[Checkpoint] Starting from index ${checkpoint} of ${companies.length} total`);
    EventLog.info(CURRENT_RUN_ID, '', '', 'sys-checkpoint', '-',
      'Resuming from index ' + checkpoint + ' of ' + companies.length);

    let processed = 0;
    let skipped   = 0;
    let failed    = 0;

    for (let i = checkpoint; i < companies.length; i++) {

      // ── Time limit: flush Gemini queue then pause ─────────
      if (isNearTimeLimit()) {
        if (pending.length) {
          Logger.log(`[Time limit] Flushing ${pending.length} pending before pause`);
          resolveGeminiBatch(pending);
          pending = [];
          clearPendingQueue_();
        }
        saveCheckpoint(i);
        Logger.log(`[runInitialPipeline PAUSED] Checkpoint saved at ${i} — re-run to continue`);
        EventLog.warn(CURRENT_RUN_ID, '', '', 'sys-checkpoint', '-',
          'Time limit hit — pausing at index ' + i + ' of ' + companies.length + ', checkpoint saved');
        buildPipelineSummary();
        return;
      }

      // ── Circuit breaker ───────────────────────────────────
      if (CircuitBreaker.isHalted('GEMINI') || CircuitBreaker.isHalted('SERPER')) {
        saveCheckpoint(i);
        Logger.log(`[runInitialPipeline HALTED] Circuit breaker tripped at index ${i}`);
        EventLog.warn(CURRENT_RUN_ID, '', '', 'sys-circuit-breaker', 'HALTED',
          'Circuit breaker halted pipeline at index ' + i +
          ' — auto-resume in ' + CONFIG.CIRCUIT_BREAKER.COOLDOWN_MINUTES + ' min');
        buildPipelineSummary();
        return;
      }

      const companyObj = companies[i];

      // ── Skip empty / header rows ──────────────────────────
      if (
        !companyObj.company ||
        companyObj.company.trim().toLowerCase() === "company_name"
      ) {
        saveCheckpoint(i + 1);
        Logger.log(`[${i + 1}/${companies.length}] SKIPPED — empty or header row`);
        continue;
      }

      // ── Skip already filtered ─────────────────────────────
      if (isAlreadyFiltered(companyObj.company)) {
        skipped++;
        saveCheckpoint(i + 1);
        Logger.log(`[${i + 1}/${companies.length}] SKIPPED — already filtered: ${companyObj.company}`);
        continue;
      }

      Logger.log(`\n[${i + 1}/${companies.length}] ${companyObj.company}`);

      try {
        const result = processCompanyStage1(companyObj);

        if (result.stage1Status === "PENDING_REVENUE") {
          // Queue for Gemini batch
          const company = cleanCompanyName(companyObj.company);
          pending.push({
            companyObj:     companyObj,
            company:        company,
            directSnippet:  getCachedSearch(company, "REVENUE_DIRECT")  || "",
            signalsSnippet: getCachedSearch(company, "REVENUE_SIGNALS") || "",
            rowNum:         null, // resolved inside resolveGeminiBatch
          });
          savePendingQueue_(pending);
          Logger.log(`[${i + 1}/${companies.length}] PENDING — queued for Gemini (queue size: ${pending.length})`);
        } else if (result.success) {
          processed++;
        } else {
          failed++;
        }

      } catch (err) {
        failed++;
        Logger.log(`[runInitialPipeline ERROR] ${companyObj.company} | ${err.message}`);
      }

      // ── Flush Gemini queue every 10 ───────────────────────
      if (pending.length >= 10) {
        Logger.log(`[Gemini Flush] Queue reached 10 — sending batch`);
        EventLog.info(CURRENT_RUN_ID, '', '', 'sys-gemini-flush', '-',
          'Gemini batch fired — 10 companies pending revenue resolution');
        resolveGeminiBatch(pending);
        processed += pending.length;
        pending = [];
        clearPendingQueue_();
      }

      saveCheckpoint(i + 1);
      if ((i - checkpoint + 1) % CONFIG.PIPELINE_SUMMARY.S1_INTERVAL === 0) buildPipelineSummary();
    }

    // ── Flush any remaining pending (less than 10) ────────
    if (pending.length) {
      Logger.log(`[Gemini Flush] Final batch of ${pending.length} companies`);
      EventLog.info(CURRENT_RUN_ID, '', '', 'sys-gemini-flush', '-',
        'Final Gemini batch — ' + pending.length + ' companies pending revenue resolution');
      resolveGeminiBatch(pending);
      processed += pending.length;
      clearPendingQueue_();
    }

    buildPipelineSummary();
    // If auto-run is active, chain to scoring instead of stopping
    if (PropertiesService.getScriptProperties().getProperty(AUTO_RUN_TRIGGER_KEY)) {
      PropertiesService.getScriptProperties().setProperty(PIPELINE_MODE_KEY, 'SCORING');
      Logger.log('[AutoRun] Stage 1 complete — switching to SCORING mode');
    }
    saveCheckpoint(0); // reset for next full run
    Logger.log(`=== runInitialPipeline COMPLETE ===`);
    Logger.log(`[Processed] ${processed}`);
    Logger.log(`[Skipped]   ${skipped}`);
    Logger.log(`[Failed]    ${failed}`);
    EventLog.info(CURRENT_RUN_ID, '', '', 'sys-run-complete', 'OK',
      'Stage 1 complete — processed ' + processed + ', skipped ' + skipped + ', failed ' + failed);

  } catch (err) {
    Logger.log(`[runInitialPipeline FATAL] ${err.message}`);
    EventLog.error(CURRENT_RUN_ID, '', '', 'sys-run-start', 'ERROR',
      'Fatal error: ' + err.message);
    if (pending.length) {
      Logger.log(`[runInitialPipeline FATAL] Flushing ${pending.length} pending before exit`);
      try {
        resolveGeminiBatch(pending);
        clearPendingQueue_();
      } catch (e) {
        Logger.log(`[runInitialPipeline FATAL] Flush failed — ${pending.length} companies remain as PENDING_REVENUE and will be drained on next run: ${e.message}`);
      }
    } else {
      clearPendingQueue_();
    }
  }
}

// ============================================================
// SECTION 6B — RESOLVE GEMINI BATCH
// Called inline from runInitialPipeline
// Takes pending queue, calls Gemini, updates STAGE1 in place
// ============================================================
function resolveGeminiBatch(pendingQueue) {
  if (!pendingQueue || !pendingQueue.length) return;

  Logger.log(`[resolveGeminiBatch] ${pendingQueue.length} companies`);

  const ss    = SpreadsheetApp.getActiveSpreadsheet();
  const sheet = ss.getSheetByName(SHEETS.STAGE1);
  if (!sheet) {
    Logger.log(`[resolveGeminiBatch ERROR] STAGE1 sheet not found`);
    return;
  }

  // Find row numbers for each pending company in STAGE1 sheet
  const lastRow = sheet.getLastRow();
  if (lastRow < 2) return;

  const nameCol = sheet.getRange(2, 1, lastRow - 1, 1).getValues();
  const nameToRow = {};
  nameCol.forEach((row, idx) => {
    const name = String(row[0] || "").trim().toLowerCase();
    if (name) nameToRow[name] = idx + 2;
  });

  // Attach row numbers — skip if already set (e.g. drain path sets rowNum directly)
  pendingQueue.forEach(item => {
    if (!item.rowNum) {
      item.rowNum = nameToRow[item.company.trim().toLowerCase()] || null;
    }
  });

  // Call Gemini batch
  const geminiResults = inferRevenueBatchGemini(pendingQueue);

  // Apply results back to STAGE1 sheet
  geminiResults.forEach((result, idx) => {
    const item = pendingQueue[idx];
    if (!item || !item.rowNum) {
      Logger.log(`[resolveGeminiBatch WARN] No row found for: ${item?.company}`);
      return;
    }

    const band    = result.band || CONFIG.REVENUE.BANDS.UNKNOWN;
    const website = (item.companyObj && item.companyObj.website) || '';

    let finalStatus      = "FAIL";
    let finalReason      = `Revenue band rejected: ${band}`;
    let manufacturerFlag = "NO";
    let acquiredFlag     = "NO";

    if (band === CONFIG.REVENUE.BANDS.UNKNOWN) {
      const evidenceCheck = (
        (item.directSnippet  || "") + " " +
        (item.signalsSnippet || "")
      ).toLowerCase();

      const tinyCompany =
        evidenceCheck.match(/\b([1-9]|10)\s*\+?\s*employees/i)  ||
        evidenceCheck.match(/company size[:\s]+1\s*[-–]\s*10/i) ||
        evidenceCheck.match(/has\s+[1-9]\s*[-–]\s*10\s*employees/i) ||
        evidenceCheck.match(/employs\s+[1-9]\s*employees/i);

      if (tinyCompany) {
        finalStatus = "FAIL";
        finalReason = "Unknown revenue + under 10 employees — auto fail";
      } else {
        finalStatus = "MANUAL_REVIEW";
        finalReason = "Unknown revenue — insufficient evidence";
      }

    } else if (CONFIG.PIPELINE.STAGE1_PASS_BANDS.includes(band)) {
      const gateResult = runPostRevenueGates(item.company, website);
      finalStatus      = gateResult.status;
      finalReason      = gateResult.failReason;
      manufacturerFlag = gateResult.manufacturer ? "YES" : "NO";
      acquiredFlag     = gateResult.acquired     ? "YES" : "NO";
    }

    Logger.log(`[resolveGeminiBatch] ${item.company} → ${band} → ${finalStatus}`);
    EventLog.info(CURRENT_RUN_ID, item.company, website, 's1-revenue-gemini',
      band === CONFIG.REVENUE.BANDS.UNKNOWN ? 'PENDING' : 'OK',
      'Gemini resolved revenue: ' + band + ' (' + (result.confidence || 'Low') + ')');

    const doneLevel = finalStatus === 'PASS' ? 'info' : 'warn';
    EventLog[doneLevel](CURRENT_RUN_ID, item.company, website, 's1-done', finalStatus,
      finalStatus === 'PASS'
        ? 'Stage 1 PASS — revenue: ' + band
        : 'Stage 1 ' + finalStatus + (finalReason ? ' — ' + finalReason : ''));

    updateStage1Revenue(sheet, item.rowNum, {
      band:       band,
      confidence: result.confidence || CONFIG.REVENUE.CONFIDENCE.LOW,
      evidence:   result.signal     || result.evidence || "Gemini batch",
    }, finalStatus, finalReason, manufacturerFlag, acquiredFlag);
  });

  SpreadsheetApp.flush();
}

// ============================================================
// SECTION 6C — INITIAL PIPELINE TEST (first 20 only)
// ============================================================
function runInitialPipelineTest() {
  START_TIME = new Date();
  Logger.log(`=== runInitialPipelineTest START ===`);

  try {
    const companies     = getCompanies();
    const testCompanies = companies.slice(0, 20);
    let processed       = 0;
    const pending       = [];

    for (const companyObj of testCompanies) {
      if (
        !companyObj.company ||
        companyObj.company.trim().toLowerCase() === "company_name"
      ) continue;

      Logger.log(`\n[TEST] ${companyObj.company}`);

      try {
        const result = processCompanyStage1(companyObj);
        Logger.log(`[TEST RESULT] ${companyObj.company} → ${result.stage1Status}`);

        if (result.stage1Status === "PENDING_REVENUE") {
          const company = cleanCompanyName(companyObj.company);
          pending.push({
            companyObj,
            company,
            directSnippet:  getCachedSearch(company, "REVENUE_DIRECT")  || "",
            signalsSnippet: getCachedSearch(company, "REVENUE_SIGNALS") || "",
            rowNum: null,
          });
        }

        processed++;
      } catch (err) {
        Logger.log(`[runInitialPipelineTest ERROR] ${companyObj.company} | ${err.message}`);
      }
    }

    // Resolve any pending via Gemini
    if (pending.length) {
      Logger.log(`[TEST] Resolving ${pending.length} pending via Gemini`);
      resolveGeminiBatch(pending);
    }

    Logger.log(`=== runInitialPipelineTest COMPLETE | ${processed} tested ===`);

  } catch (err) {
    Logger.log(`[runInitialPipelineTest FATAL] ${err.message}`);
  }
}

// ============================================================
// SECTION 8 — FINAL SCORING PIPELINE
// Run AFTER resolvePendingRevenue completes
// Only scores companies with Stage1 status = PASS
// ============================================================
function runFinalScoringPipeline() {
  START_TIME     = new Date();
  CURRENT_RUN_ID = makeRunId_('SC');
  batchFailuresInit_(CURRENT_RUN_ID);
  Logger.log(`=== runFinalScoringPipeline START ===`);

  if (CircuitBreaker.isHalted('GEMINI') || CircuitBreaker.isHalted('SERPER')) {
    Logger.log('[runFinalScoringPipeline] Circuit breaker still halted — aborting. Auto-resume is scheduled.');
    return;
  }

  try {
    const companies  = getPassedCompanies();
    const checkpoint = getCheckpoint();
    Logger.log(`[Scoring Checkpoint] Resuming from index ${checkpoint}`);
    EventLog.info(CURRENT_RUN_ID, '', '', 'sys-run-start', 'OK',
      'Scoring pipeline started — ' + companies.length + ' passed companies');
    EventLog.info(CURRENT_RUN_ID, '', '', 'sys-checkpoint', '-',
      'Resuming from index ' + checkpoint + ' of ' + companies.length);

    let processed = 0;
    let skipped   = 0;

    for (let i = checkpoint; i < companies.length; i++) {

      if (isNearTimeLimit()) {
        saveCheckpoint(i);
        Logger.log(`[runFinalScoringPipeline PAUSED] Checkpoint saved at ${i}`);
        EventLog.warn(CURRENT_RUN_ID, '', '', 'sys-checkpoint', '-',
          'Time limit hit — pausing scoring at index ' + i + ', checkpoint saved');
        buildPipelineSummary();
        return;
      }

      // ── Circuit breaker ───────────────────────────────────
      if (CircuitBreaker.isHalted('GEMINI') || CircuitBreaker.isHalted('SERPER')) {
        saveCheckpoint(i);
        Logger.log(`[runFinalScoringPipeline HALTED] Circuit breaker tripped at index ${i}`);
        EventLog.warn(CURRENT_RUN_ID, '', '', 'sys-circuit-breaker', 'HALTED',
          'Circuit breaker halted scoring at index ' + i +
          ' — auto-resume in ' + CONFIG.CIRCUIT_BREAKER.COOLDOWN_MINUTES + ' min');
        buildPipelineSummary();
        return;
      }

      const companyObj = companies[i];
      if (!companyObj.company) { saveCheckpoint(i + 1); continue; }

      if (isAlreadyScored(companyObj.company)) {
        skipped++;
        saveCheckpoint(i + 1);
        Logger.log(`[${i + 1}/${companies.length}] SKIPPED — already scored: ${companyObj.company}`);
        continue;
      }

      const stage1 = getStage1Status(companyObj.company);
      if (!stage1 || stage1.status !== "PASS") {
        Logger.log(`[${i + 1}/${companies.length}] SKIPPED — stage1 not PASS: ${companyObj.company} (${stage1?.status || "not found"})`);
        continue;
      }

      Logger.log(`[Scoring ${i + 1}/${companies.length}] ${companyObj.company}`);
      EventLog.info(CURRENT_RUN_ID, companyObj.company, companyObj.website || '', 'sc-start', '-',
        'Entering scoring pipeline (' + (i + 1) + '/' + companies.length + ')');

      try {
        const c3 = runC3(companyObj);
        const c4 = runC4(companyObj);

        // STAGE1_MFG/STAGE1_BIZ were cached in pipeline.js under the
        // CLEANED name (cleanCompanyName runs before those Serper calls),
        // while companyObj.company here is the raw MASTER-sheet name —
        // must clean it too or these two lookups always miss.
        const cleanedForCache = cleanCompanyName(companyObj.company);
        const c5QueryPriority = ["STAGE1_MFG", "C3", "STAGE1_BIZ"];
        let c5Snippets = null;
        for (const qt of c5QueryPriority) {
          const lookupName = (qt === "C3") ? companyObj.company : cleanedForCache;
          c5Snippets = getCachedSearch(lookupName, qt);
          if (c5Snippets && c5Snippets.trim().length >= 50) break;
        }
        const c5 = runC5(companyObj, c5Snippets);

        const c6 = runC6(companyObj);

        const finalScore =
          CONFIG.WEIGHTS.C1 +
          CONFIG.WEIGHTS.C2 +
          (c3.c3 || 0) +
          (c4.c4 || 0) +
          (c5.c5 || 0) +
          (c6.c6 || 0);

        const bandResult = getBand(finalScore);

        writeScores(companyObj, {
          c1:           CONFIG.WEIGHTS.C1,
          c2:           CONFIG.WEIGHTS.C2,
          c3:           c3.c3           || 0,
          c3Evidence:   c3.c3Evidence   || "",
          c3Confidence: c3.c3Confidence || "Low",
          c4:           c4.c4           || 0,
          c4DmName:     c4.c4DmName     || "Unknown",
          c4Background: c4.c4Background || "",
          c4Confidence: c4.c4Confidence || "Low",
          c5:           c5.c5           || 0,
          c5Sector:     c5.c5Sector     || "Other",
          c5Reason:     c5.c5Reason     || "",
          c6:           c6.c6           || 0,
          c6Signals:    c6.c6Signals    || "",
          c6Confidence: c6.c6Confidence || "Low",
          finalScore:   finalScore,
          band:         bandResult.band,
          bandLabel:    bandResult.label,
        });

        EventLog.info(CURRENT_RUN_ID, companyObj.company, companyObj.website || '', 'sc-done',
          'Band_' + bandResult.band,
          'Final score ' + finalScore + '/100 — Band ' + bandResult.band + ': ' + bandResult.label +
          ' | C3=' + (c3.c3||0) + ' C4=' + (c4.c4||0) + ' C5=' + (c5.c5||0) + ' C6=' + (c6.c6||0));

        processed++;
      } catch (err) {
        Logger.log(`[runFinalScoringPipeline ERROR] ${companyObj.company} | ${err.message}`);
        EventLog.error(CURRENT_RUN_ID, companyObj.company, companyObj.website || '', 'sc-done', 'ERROR',
          'Unhandled scoring exception: ' + err.message);
      }

      saveCheckpoint(i + 1);
      if ((i - checkpoint + 1) % CONFIG.PIPELINE_SUMMARY.SCORE_INTERVAL === 0) buildPipelineSummary();
    }

    Logger.log(`=== runFinalScoringPipeline COMPLETE | processed: ${processed}, skipped: ${skipped} ===`);
    EventLog.info(CURRENT_RUN_ID, '', '', 'sys-run-complete', 'OK',
      'Scoring complete — processed ' + processed + ', skipped ' + skipped);
    buildPipelineSummary();
    deleteAutoRunTrigger_(); // no-op if auto-run was not active
    // Auto-build shortlist after scoring completes
    Logger.log(`[runFinalScoringPipeline] Building shortlist...`);
    buildShortlist();
    EventLog.info(CURRENT_RUN_ID, '', '', 'sys-shortlist', 'OK', 'Shortlist built');

  } catch (err) {
    Logger.log(`[runFinalScoringPipeline FATAL] ${err.message}`);
    EventLog.error(CURRENT_RUN_ID, '', '', 'sys-run-start', 'ERROR',
      'Scoring pipeline fatal error: ' + err.message);
  }
}

// ============================================================
// SECTION 9 — FINAL SCORING TEST (first 20 PASSed companies)
// ============================================================
function runFinalScoringPipelineTest() {
  START_TIME = new Date();
  Logger.log(`=== runFinalScoringPipelineTest START ===`);

  try {
    const companies = getPassedCompanies();
    let tested      = 0;

    for (const companyObj of companies) {
      if (tested >= 20) break;

      const stage1 = getStage1Status(companyObj.company);
      if (!stage1 || stage1.status !== "PASS") continue;

      Logger.log(`[TEST SCORING] ${companyObj.company}`);

      try {
        const c3 = runC3(companyObj);
        const c4 = runC4(companyObj);

        // See note in runFinalScoringPipeline — STAGE1_MFG/STAGE1_BIZ
        // were cached under the cleaned name, not the raw sheet name.
        const cleanedForCache = cleanCompanyName(companyObj.company);
        const c5QueryPriority = ["STAGE1_MFG", "C3", "STAGE1_BIZ"];
        let c5Snippets = null;
        for (const qt of c5QueryPriority) {
          const lookupName = (qt === "C3") ? companyObj.company : cleanedForCache;
          c5Snippets = getCachedSearch(lookupName, qt);
          if (c5Snippets && c5Snippets.trim().length >= 50) break;
        }
        const c5 = runC5(companyObj, c5Snippets);

        const c6 = runC6(companyObj);

        Logger.log(`[TEST SUCCESS] ${companyObj.company}`);
        Logger.log(JSON.stringify({ c3: c3.c3, c4: c4.c4, c5: c5.c5, c6: c6.c6 }));

        const finalScore =
          CONFIG.WEIGHTS.C1 +
          CONFIG.WEIGHTS.C2 +
          (c3.c3 || 0) +
          (c4.c4 || 0) +
          (c5.c5 || 0) +
          (c6.c6 || 0);

        const bandResult = getBand(finalScore);
        Logger.log(`[TEST BAND] ${companyObj.company} → ${finalScore} → Band ${bandResult.band}`);

        writeScores(companyObj, {
          c1:           CONFIG.WEIGHTS.C1,
          c2:           CONFIG.WEIGHTS.C2,
          c3:           c3.c3           || 0,
          c3Evidence:   c3.c3Evidence   || "",
          c3Confidence: c3.c3Confidence || "Low",
          c4:           c4.c4           || 0,
          c4DmName:     c4.c4DmName     || "Unknown",
          c4Background: c4.c4Background || "",
          c4Confidence: c4.c4Confidence || "Low",
          c5:           c5.c5           || 0,
          c5Sector:     c5.c5Sector     || "Other",
          c5Reason:     c5.c5Reason     || "",
          c6:           c6.c6           || 0,
          c6Signals:    c6.c6Signals    || "",
          c6Confidence: c6.c6Confidence || "Low",
          finalScore:   finalScore,
          band:         bandResult.band,
          bandLabel:    bandResult.label,
        });

        tested++;

              
      } catch (err) {
          Logger.log(`[runFinalScoringPipelineTest ERROR] ${companyObj.company} | ${err.message}`);
        }
      }

    Logger.log(`=== runFinalScoringPipelineTest COMPLETE | ${tested} tested ===`);

  } catch (err) {
    Logger.log(`[runFinalScoringPipelineTest FATAL] ${err.message}`);
  }
}

// ============================================================
// SECTION 10 — RESET HELPERS
// ============================================================
function resetAndRunFresh() {
  resetCheckpoint();
  clearPendingQueue_();
  PropertiesService.getScriptProperties().deleteProperty("PENDING_REVENUE_CHECKPOINT");
  Logger.log(`[resetAndRunFresh] All checkpoints cleared`);
}


function updateStage1Revenue(sheet, rowNum, revenueBand, status, failReason, manufacturerFlag, acquiredFlag) {
  try {
    if (manufacturerFlag !== undefined) sheet.getRange(rowNum, 4).setValue(manufacturerFlag);
    if (acquiredFlag     !== undefined) sheet.getRange(rowNum, 5).setValue(acquiredFlag);
    sheet.getRange(rowNum, 6).setValue(revenueBand.band       || "Unknown");
    sheet.getRange(rowNum, 7).setValue(revenueBand.confidence || "Low");
    sheet.getRange(rowNum, 8).setValue(revenueBand.evidence   || "");
    sheet.getRange(rowNum, 9).setValue("Gemini");
    sheet.getRange(rowNum, 10).setValue(status                || "FAIL");
    sheet.getRange(rowNum, 11).setValue(failReason            || "");
  } catch (err) {
    Logger.log(`[updateStage1Revenue ERROR] row ${rowNum} | ${err.message}`);
  }
}


function checkState() {
  Logger.log(`Checkpoint: ${getCheckpoint()}`);
  Logger.log(`Companies: ${getCompanies().length}`);
}

// ============================================================
// testCheckpointing — verifies all 6 checkpoint requirements.
// No API calls. Safe to run anytime.
// ============================================================
function testCheckpointing() {
  Logger.log('=== testCheckpointing START ===\n');
  let passed = 0;
  let failed = 0;

  function assert(label, condition) {
    if (condition) {
      Logger.log('PASS — ' + label);
      passed++;
    } else {
      Logger.log('FAIL — ' + label);
      failed++;
    }
  }

  // ── Test 1: saveCheckpoint / getCheckpoint round-trip ─────
  saveCheckpoint(42);
  assert('saveCheckpoint/getCheckpoint round-trip', getCheckpoint() === 42);

  // ── Test 2: pending queue written to PropertiesService ────
  const fakePending = [
    { company: 'Acme Corp', companyObj: { company: 'Acme Corp', website: 'acme.com', source: 'Test' }, directSnippet: '', signalsSnippet: '', rowNum: null },
    { company: 'Beta Ltd',  companyObj: { company: 'Beta Ltd',  website: 'beta.com', source: 'Test' }, directSnippet: '', signalsSnippet: '', rowNum: null },
  ];
  savePendingQueue_(fakePending);
  const stored = PropertiesService.getScriptProperties().getProperty(PENDING_QUEUE_KEY);
  const parsed = stored ? JSON.parse(stored) : [];
  assert('savePendingQueue_ writes 2 entries', parsed.length === 2);
  assert('savePendingQueue_ preserves company names',
    parsed[0].company === 'Acme Corp' && parsed[1].company === 'Beta Ltd');

  // ── Test 3: clearPendingQueue_ removes the key ────────────
  clearPendingQueue_();
  const afterClear = PropertiesService.getScriptProperties().getProperty(PENDING_QUEUE_KEY);
  assert('clearPendingQueue_ removes key', afterClear === null);

  // ── Test 4: drainPendingRevenue finds PENDING_REVENUE rows ─
  const ss     = SpreadsheetApp.getActiveSpreadsheet();
  const stage1 = ss.getSheetByName(SHEETS.STAGE1);
  if (stage1) {
    stage1.appendRow([
      'TEST_DRAIN_COMPANY', 'testdrain.com', 'Test',
      'NO', 'NO', 'PENDING_REVENUE', 'Low', 'Awaiting Gemini batch', 'Gemini',
      'PENDING_REVENUE', '',
    ]);
    const leftover = drainPendingRevenue();
    const found = leftover.some(p =>
      p.companyObj.company === 'TEST_DRAIN_COMPANY'
    );
    assert('drainPendingRevenue finds injected PENDING_REVENUE row', found);
    stage1.deleteRow(stage1.getLastRow()); // clean up test row
    Logger.log('      (test row removed from STAGE1)');
  } else {
    Logger.log('SKIP — Test 4 (STAGE1 sheet missing — run setupSheets first)');
  }

  // ── Test 5: drainPendingRevenue ignores PASS / FAIL rows ──
  if (stage1) {
    stage1.appendRow([
      'TEST_PASS_COMPANY', 'testpass.com', 'Test',
      'YES', 'NO', '50-500Cr', 'High', 'Revenue found', 'Direct',
      'PASS', '',
    ]);
    const leftover2 = drainPendingRevenue();
    const foundPass = leftover2.some(p =>
      p.companyObj.company === 'TEST_PASS_COMPANY'
    );
    assert('drainPendingRevenue ignores PASS rows', !foundPass);
    stage1.deleteRow(stage1.getLastRow());
    Logger.log('      (test row removed from STAGE1)');
  }

  // ── Test 6: resetAndRunFresh clears both index and queue ──
  saveCheckpoint(99);
  savePendingQueue_(fakePending);
  resetAndRunFresh();
  assert('resetAndRunFresh resets checkpoint to 0', getCheckpoint() === 0);
  assert('resetAndRunFresh clears pending queue',
    PropertiesService.getScriptProperties().getProperty(PENDING_QUEUE_KEY) === null);

  Logger.log('\n=== RESULT: ' + passed + ' passed, ' + failed + ' failed ===');
}


// change if necessary
function setCheckpointTo500() {
  saveCheckpoint(500);
  Logger.log(`Checkpoint set to 500`);
}

function getPassedCompanies() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const sheet = ss.getSheetByName(SHEETS.STAGE1);
  if (!sheet || sheet.getLastRow() < 2) return [];

  const data = sheet.getRange(2, 1, sheet.getLastRow() - 1, 11).getValues();

  return data
    .filter(row => String(row[9]).trim() === 'PASS')
    .map(row => ({
      company: row[0],
      website: row[1],
      source:  row[2],
    }));
}

// ===== FILE: pipeline.js =====
// ============================================================
// pipeline.js
// Per-company Stage 1 orchestrator — no sheet writes, no batch
// management, no time checks. Only gate logic and sequencing.
//
// Public surface:
//   runCompany(companyObj)            → full Gate 1→2→3 flow
//   runPostRevenueGates(company, web) → Gate 2+3 only (shared
//                                       by direct and Gemini paths)
// ============================================================

// ============================================================
// GATE 2 — Manufacturer check
// ============================================================
function runManufacturingGate(company) {
  const mfgSnippets = callSerper(company, "STAGE1_MFG");
  const mfgText = String(mfgSnippets || "").toLowerCase();

  const manufacturerHit = CONFIG.STAGE1.MANUFACTURING.find(kw =>
    mfgText.includes(kw.toLowerCase())
  );
  const traderHit = CONFIG.STAGE1.TRADER.find(kw =>
    mfgText.includes(kw.toLowerCase())
  );
  const croHit = CONFIG.STAGE1.CRO.find(kw =>
    mfgText.includes(kw.toLowerCase())
  );

  if (!manufacturerHit || croHit) {
    let failReason = "No manufacturing signal found";
    if (croHit)         failReason = `CRO/service detected: ${croHit}`;
    else if (traderHit) failReason = `Trader/distributor only — no manufacturing signal: ${traderHit}`;
    return { pass: false, failReason, keyword: null };
  }
  return { pass: true, failReason: "", keyword: manufacturerHit };
}

// ============================================================
// GATE 3 — PE/Acquired check
// ============================================================
function runAcquiredGate(company) {
  const bizSnippets = callSerper(company, "STAGE1_BIZ");
  const bizText = String(bizSnippets || "").toLowerCase();

  const peHit = CONFIG.STAGE1.PE_ACQUIRED.find(kw =>
    bizText.includes(kw.toLowerCase())
  );
  return { acquired: !!peHit, peHit: peHit || null };
}

// ============================================================
// GATES 2+3 IN SEQUENCE
// Single place for post-revenue gate logic. Called from:
//   runCompany()        — when revenue resolved via direct/signals/heuristic
//   resolveGeminiBatch() — when revenue resolved via Gemini
//
// Returns { status, manufacturer, acquired, failReason }
// ============================================================
function runPostRevenueGates(company, website) {
  // Gate 2: Manufacturer
  const mfgResult = runManufacturingGate(company);
  if (!mfgResult.pass) {
    Logger.log(`[Gate2 FAIL] ${company} — ${mfgResult.failReason}`);
    EventLog.warn(CURRENT_RUN_ID, company, website, 's1-gate2', 'FAIL', mfgResult.failReason);
    return {
      status:       "FAIL",
      manufacturer: false,
      acquired:     false,
      failReason:   mfgResult.failReason,
    };
  }
  Logger.log(`[Gate2 PASS] ${company}`);
  EventLog.info(CURRENT_RUN_ID, company, website, 's1-gate2', 'PASS',
    'Manufacturer signal confirmed' + (mfgResult.keyword ? ': "' + mfgResult.keyword + '"' : ''));

  // Gate 3: PE/Acquired
  const acqResult = runAcquiredGate(company);
  if (acqResult.acquired) {
    Logger.log(`[Gate3 FAIL] ${company} — PE/acquired: ${acqResult.peHit}`);
    EventLog.warn(CURRENT_RUN_ID, company, website, 's1-gate3', 'FAIL',
      'PE/acquisition detected: "' + acqResult.peHit + '"');
    return {
      status:       "FAIL",
      manufacturer: true,
      acquired:     true,
      failReason:   `PE/acquired detected: ${acqResult.peHit}`,
    };
  }
  Logger.log(`[Gate3 PASS] ${company}`);
  EventLog.info(CURRENT_RUN_ID, company, website, 's1-gate3', 'PASS',
    'No acquisition signal found');

  return {
    status:       "PASS",
    manufacturer: true,
    acquired:     false,
    failReason:   "",
  };
}

// ============================================================
// FULL PER-COMPANY STAGE 1 FLOW
// Gate 1 (revenue) → runPostRevenueGates (Gate 2+3)
// Returns a result object. No sheet writes. No queue management.
// ============================================================
function runCompany(companyObj) {
  const company = cleanCompanyName(companyObj.company);
  const website = companyObj.website || '';
  Logger.log(`[Stage1 START] ${company}`);
  EventLog.info(CURRENT_RUN_ID, company, website, 's1-start', '-', 'Entering Stage 1');

  // ── Gate 1: Revenue ───────────────────────────────────────
  // Step 1a — dedicated Tofler/Zauba/Screener search
  const directSnippets = callSerper(company, "REVENUE_DIRECT");
  const directText = String(directSnippets || "");

  let revenueBand   = extractDirectRevenue(directText);
  let revenueSource = revenueBand ? "Direct" : null;

  if (!revenueBand) {
    // Step 1b — signals search
    const signalSnippets   = callSerper(company, "REVENUE_SIGNALS");
    const signalText       = String(signalSnippets || "").trim();
    const combinedEvidence = (directText + " " + signalText).trim();

    if (signalText.length > 50) {
      const sigResult = extractDirectRevenue(signalText);
      // Only use signals to fast-reject VERY_SMALL; anything else goes to Gemini
      // (~39% false positive rate on MID+ from general web snippets)
      if (sigResult && sigResult.band === CONFIG.REVENUE.BANDS.VERY_SMALL) {
        revenueBand   = sigResult;
        revenueSource = "Signals";
        EventLog.info(CURRENT_RUN_ID, company, website, 's1-revenue-l1', 'OK',
          'Revenue via signals search: ' + revenueBand.band + ' (' + revenueBand.confidence + ')');
      }
    }

    if (!revenueBand && combinedEvidence.length > 50) {
      const heuristic = employeeHeuristic(combinedEvidence);
      if (heuristic) {
        revenueBand   = heuristic;
        revenueSource = "Heuristic";
        EventLog.info(CURRENT_RUN_ID, company, website, 's1-revenue-l2', 'OK',
          'Revenue via employee heuristic: ' + revenueBand.band + ' (' + revenueBand.confidence + ')');
      }
    }

    if (!revenueBand && combinedEvidence.length > 50) {
      Logger.log(`[Gate1 PENDING GEMINI] ${company}`);
      EventLog.info(CURRENT_RUN_ID, company, website, 's1-revenue-l3', 'PENDING',
        'No direct or heuristic revenue signal — queued for Gemini batch');
      return {
        manufacturer:  false,
        acquired:      false,
        revenueBand:   { band: "PENDING_REVENUE", confidence: "Low", evidence: "Awaiting Gemini batch" },
        revenueSource: "Gemini",
        status:        "PENDING_REVENUE",
        failReason:    "",
      };
    }

    if (!revenueBand) {
      Logger.log(`[Gate1 No evidence] ${company}`);
      EventLog.warn(CURRENT_RUN_ID, company, website, 's1-gate1', 'FAIL',
        'No revenue evidence found — insufficient search results');
      return {
        manufacturer:  false,
        acquired:      false,
        revenueBand:   { band: "Unknown", confidence: "Low", evidence: "No revenue evidence found" },
        revenueSource: "-",
        status:        "FAIL",
        failReason:    "No revenue evidence found",
      };
    }
  } else {
    EventLog.info(CURRENT_RUN_ID, company, website, 's1-revenue-l1', 'OK',
      'Revenue via direct search: ' + revenueBand.band + ' (' + revenueBand.confidence + ')');
  }

  if (!CONFIG.PIPELINE.STAGE1_PASS_BANDS.includes(revenueBand.band)) {
    Logger.log(`[Gate1 FAIL] ${company} → ${revenueBand.band}`);
    EventLog.warn(CURRENT_RUN_ID, company, website, 's1-gate1', 'FAIL',
      'Revenue band out of range: ' + revenueBand.band);
    return {
      manufacturer:  false,
      acquired:      false,
      revenueBand:   revenueBand,
      revenueSource: revenueSource,
      status:        "FAIL",
      failReason:    `Revenue band rejected: ${revenueBand.band}`,
    };
  }
  Logger.log(`[Gate1 PASS] ${company} → ${revenueBand.band}`);
  EventLog.info(CURRENT_RUN_ID, company, website, 's1-gate1', 'PASS',
    'Revenue band accepted: ' + revenueBand.band + ' | Evidence: ' + (revenueBand.evidence || '').slice(0, 120));

  // ── Gates 2+3 ─────────────────────────────────────────────
  const gateResult = runPostRevenueGates(company, website);
  return {
    manufacturer:  gateResult.manufacturer,
    acquired:      gateResult.acquired,
    revenueBand:   revenueBand,
    revenueSource: revenueSource,
    status:        gateResult.status,
    failReason:    gateResult.failReason,
  };
}

// ============================================================
// testPipeline
// Runs runCompany() on the first 3 companies in the master sheet.
// Logs the full result — NO sheet writes, no side effects.
// Use this to verify pipeline.js is wired correctly after deploy.
// ============================================================
function testPipeline() {
  Logger.log('=== testPipeline START ===');
  CURRENT_RUN_ID = 'test-pipeline';

  try {
    const companies = getCompanies().slice(0, 3);
    if (!companies.length) {
      Logger.log('[testPipeline] No companies found in master sheet');
      return;
    }

    let passed = 0, failed = 0, pending = 0;

    for (const companyObj of companies) {
      if (!companyObj.company ||
          companyObj.company.trim().toLowerCase() === 'company_name') continue;

      Logger.log(`\n--- ${companyObj.company} ---`);
      const result = runCompany(companyObj);

      Logger.log(`  status:        ${result.status}`);
      Logger.log(`  revenueSource: ${result.revenueSource}`);
      Logger.log(`  revenueBand:   ${result.revenueBand?.band}`);
      Logger.log(`  manufacturer:  ${result.manufacturer}`);
      Logger.log(`  acquired:      ${result.acquired}`);
      if (result.failReason) Logger.log(`  failReason:    ${result.failReason}`);

      if (result.status === 'PASS')            passed++;
      else if (result.status === 'PENDING_REVENUE') pending++;
      else                                     failed++;
    }

    Logger.log(`\n=== testPipeline COMPLETE — PASS:${passed} FAIL:${failed} PENDING:${pending} ===`);

  } catch (err) {
    Logger.log(`[testPipeline ERROR] ${err.message}`);
  }
}

// ============================================================
// testPostRevenueGates
// Runs Gate 2+3 in isolation on the first 3 companies.
// Useful when debugging a specific company that passed revenue
// but failed manufacturing or acquired checks.
// NO sheet writes.
// ============================================================
function testPostRevenueGates() {
  Logger.log('=== testPostRevenueGates START ===');
  CURRENT_RUN_ID = 'test-post-rev';

  try {
    const companies = getCompanies().slice(0, 3);
    if (!companies.length) {
      Logger.log('[testPostRevenueGates] No companies found');
      return;
    }

    for (const companyObj of companies) {
      if (!companyObj.company ||
          companyObj.company.trim().toLowerCase() === 'company_name') continue;

      const company = cleanCompanyName(companyObj.company);
      Logger.log(`\n--- ${company} ---`);
      const result = runPostRevenueGates(company, companyObj.website || '');

      Logger.log(`  status:       ${result.status}`);
      Logger.log(`  manufacturer: ${result.manufacturer}`);
      Logger.log(`  acquired:     ${result.acquired}`);
      if (result.failReason) Logger.log(`  failReason:   ${result.failReason}`);
    }

    Logger.log('\n=== testPostRevenueGates COMPLETE ===');

  } catch (err) {
    Logger.log(`[testPostRevenueGates ERROR] ${err.message}`);
  }
}


// ===== FILE: prompts.js =====
// ============================================================
// prompts.gs — All Gemini prompt strings for the ICP pipeline
// Keep prompt text here only — no config, no logic.
// buildPrompt() lives here too since it exists solely to
// assemble these strings.
// ============================================================

const PROMPTS = {

  // ----------------------------------------------------------
  // REVENUE BATCH PROMPT
  // Used by inferRevenueBatchGemini() — up to 10 companies
  // per call. Placeholder: {companies_block}
  // ----------------------------------------------------------
  REVENUE_BATCH: `You are classifying Indian manufacturers by annual revenue band.
          You will receive up to 10 companies. For each, use ONLY the snippet evidence provided.

          Allowed bands: <50Cr | 50-500Cr | 500-1500Cr | >1500Cr | Unknown

          Classification rules in priority order:

          1. Direct INR figure in crores → use it directly, confidence High
            Example: "turnover Rs. 150 crore" → 50-500Cr High

          2. USD/EUR revenue figure → convert at 83 INR per USD, 90 INR per EUR
            Example: "$15.7 M revenue" → 15.7 × 83 = ~130 Cr → 50-500Cr Medium
            Example: "$2 M revenue" → ~17 Cr → <50Cr Medium

          3. ICRA or CRISIL rating with facility size → infer from facility
            Example: "bank limits 8 crore" → <50Cr High
            Example: "rated for 200 crore facilities" → 50-500Cr High

          4. Employee count as revenue proxy for Indian manufacturers:
            - Under 25 employees → <50Cr Low
            - 25-50 employees → <50Cr Low
            - 51-200 employees with manufacturing/export/production signals → 50-500Cr Medium
            - 51-200 employees with no other signal → Unknown Low
            - 201-500 employees → 50-500Cr Medium
            - 500+ employees → 50-500Cr or above Medium
          5. Production capacity signals:
            - Under 500 MT/year → likely <50Cr
            - 500-5000 MT/year → likely 50-500Cr
            - Above 5000 MT/year → likely 50-500Cr or above

          6. If evidence only shows "Revenue. Not Available" or "GET PRO" paywalled data → Unknown Low

          7. If Zauba/Tofler page found but revenue hidden behind paywall → Unknown Low

          8. If no financial signal at all → Unknown Low

          Return ONLY a valid JSON array. No markdown. No explanation. Start with [ end with ].

          [
            {
              "company": "exact company name as given",
              "band": "<50Cr | 50-500Cr | 500-1500Cr | >1500Cr | Unknown",
              "confidence": "High | Medium | Low",
              "signal": "exact phrase or calculation that determined the band, max 25 words",
              "source": "Tofler | Zauba | ICRA | CRISIL | MoneyControl | Tracxn | Employee-count | Capacity | USD-converted | Directory | None"
            }
          ]

          Companies:
          {companies_block}`,


  // ----------------------------------------------------------
  // REVENUE SINGLE PROMPT
  // Used by inferRevenueWithGemini() and
  // inferRevenueWithGeminiHelper() — single company path.
  // Placeholders: {company}, {evidence}
  // ----------------------------------------------------------
  REVENUE_SINGLE: `You are classifying an Indian manufacturer by annual revenue band.
          Use ONLY the snippet evidence provided.

          Company: {company}
          Evidence: {evidence}

          Allowed bands: <50Cr | 50-500Cr | 500-1500Cr | >1500Cr | Unknown

          Classification rules in priority order:

          1. Direct INR figure in crores → use it directly, confidence High
            Example: "turnover Rs. 150 crore" → 50-500Cr High

          2. USD/EUR revenue figure → convert at 83 INR per USD, 90 INR per EUR
            Example: "$15.7 M revenue" → 15.7 × 83 = ~130 Cr → 50-500Cr Medium

          3. ICRA or CRISIL rating with facility size → infer from facility
            Example: "bank limits 8 crore" → <50Cr High

          4. Employee count as revenue proxy for Indian manufacturers:
            - Under 25 employees → <50Cr Low
            - 25-50 employees → <50Cr Low
            - 51-200 employees with manufacturing/export/production signals → 50-500Cr Medium
            - 51-200 employees with no other signal → Unknown Low
            - 201-500 employees → 50-500Cr Medium
            - 500+ employees → 50-500Cr or above Medium

          5. Production capacity signals:
            - Under 500 MT/year → likely <50Cr
            - 500-5000 MT/year → likely 50-500Cr
            - Above 5000 MT/year → likely 50-500Cr or above

          6. If evidence only shows "Revenue. Not Available" or "GET PRO" paywalled data → Unknown Low

          7. If Zauba/Tofler page found but revenue hidden behind paywall → Unknown Low

          8. If no financial signal at all → Unknown Low

          Return ONLY a valid JSON object. No markdown. No explanation.
          {"band":"<50Cr|50-500Cr|500-1500Cr|>1500Cr|Unknown","confidence":"High|Medium|Low","signal":"max 25 words","source":"Tofler|Zauba|ICRA|CRISIL|MoneyControl|Tracxn|Employee-count|Capacity|USD-converted|Directory|None"}`,


  // ----------------------------------------------------------
  // C3 PROMPT
  // Used by runC3() — technical differentiation signals.
  // Placeholders: {company}, {evidence}
  // ----------------------------------------------------------
  C3: `You are a strict manufacturing research analyst. Evaluate technical differentiation signals.
          Company: {company}
          Evidence: {evidence}

          Return ONLY this exact JSON with no other text:
          {"P":"S/W/A","D":"S/W/A","R":"S/W/A","PR":"S/W/A","PC":"S/W/A","CS":"S/W/A","CC":"S/W/A","x":"max 20 words reason"}

          Field meanings:
          P = Patents filed or granted
          D = DSIR recognition
          R = Regulatory approvals (USFDA, WHO-GMP, EU-GMP)
          PR = Proprietary or branded products
          PC = Pioneer or first-mover claims
          CS = Custom synthesis capability
          CC = Commodity chemicals (penalty signal)

          Values: S=Strong evidence, W=Weak/indirect evidence, A=Absent`,


  // ----------------------------------------------------------
  // C4 NAME PROMPT
  // Gemini call 1 — name extraction only, lightweight.
  // Placeholders: {company}, {evidence}
  // ----------------------------------------------------------
  C4_NAME: `Extract the decision-maker's name from these search results about an Indian company.

      Company: {company}

      Evidence:
      {evidence}

      Identify the most senior person:
      - Prefer: Founder, MD, Managing Director, Chairman, Promoter, CEO, Proprietor
      - If multiple directors listed, pick the most senior title
      - Names may appear as "Name - Title", "Title: Name", "Directors are Name1, Name2", or "Name is the founder"
      - If no person found, use "Unknown"


      Priority order: Founder > MD > Managing Director > Chairman > Promoter > CEO > Proprietor > Director

      If multiple people found, pick the most senior title.
      If only a LinkedIn URL is available with no title context, extract the name from the URL slug.

      Return ONLY:
      {"name":"Full Name or Unknown"}`,


  // ----------------------------------------------------------
  // C4 DEPTH PROMPT
  // Gemini call 2 — depth classification only, no name needed.
  // Placeholders: {company}, {evidence}
  // ----------------------------------------------------------
  C4_DEPTH: `You are classifying the technical depth of a decision-maker at an Indian manufacturing company.

      Company: {company}

      Evidence:
      {evidence}

      Strong:
      - PhD, IIT, IISc, IISER, NIT, BITS
      - ex-ISRO, ex-DRDO, scientist, patent holder, published researcher

      Moderate:
      - B.Tech, BE, M.Tech, MSc
      - engineering background, technical founder, R&D leadership

      None:
      - MBA only, finance background, sales background, no evidence found

      Return ONLY:
      {"depth":"Strong/Moderate/None","bg":"max 15 words","x":"max 15 words"}`,


  // ----------------------------------------------------------
  // C6 PROMPT
  // Used by runC6() — growth signal detection for ambiguous
  // cases where deterministic found fewer than 2 signals.
  // Placeholder: {evidence}
  // ----------------------------------------------------------
  C6: `You are evaluating growth signals for an Indian manufacturer.
        Evidence: {evidence}

        Return ONLY this exact JSON with no other text:
        {"hiring":false,"facility":false,"certifications":false,"active":false,"exports":false,"x":"max 15 words on strongest signal"}

        hiring = true if job postings, recruitment, team expansion, or headcount growth mentioned
        facility = true if new plant, capacity increase, greenfield, brownfield, expansion, new unit mentioned
        certifications = true if USFDA, WHO-GMP, EU-GMP, DSIR, ISO, HALAL, REACH, or approval mentioned
        active = true if any news, press release, announcement, blog, or event from 2024 or 2025
        exports = true if export destinations, global customers, USA, Europe, Japan, or revenue growth mentioned`,

};


// ============================================================
// buildPrompt — assembles a prompt string for a single company.
// Replaces {company} and {evidence} placeholders.
// For REVENUE_BATCH use PROMPTS.REVENUE_BATCH.replace() directly
// since its placeholder is {companies_block} (multi-company).
// ============================================================

function buildPrompt(promptKey, companyName, evidenceText) {
  return PROMPTS[promptKey]
    .replace(/\{company\}/g, companyName)
    .replace(/\{evidence\}/g, evidenceText);
}


// ===== FILE: revenue.js =====
// ============================================================
// revenue.gs
// Revenue Logic ONLY
// Flow:
// 1. Direct Revenue Extraction (regex + heuristic)
// 2. Gemini Batch Inference (for ambiguous cases)
// ============================================================

// ============================================================
// PRIVATE HELPER — revenue band only, not ICP scoring band
// Never call getBand() from config.gs inside this file
// ============================================================
function revBand(cr) {
  if      (cr < 50)                return CONFIG.REVENUE.BANDS.VERY_SMALL;
  else if (cr >= 50 && cr <= 500)  return CONFIG.REVENUE.BANDS.MID;
  else if (cr > 500 && cr <= 1500) return CONFIG.REVENUE.BANDS.LARGE;
  else                             return CONFIG.REVENUE.BANDS.VERY_LARGE;
}

// ============================================================
// SECTION 1 — GET REVENUE SIGNALS
// Two Serper calls: REVENUE_DIRECT + REVENUE_SIGNALS
// Results cached automatically by callSerper
// ============================================================
function getRevenueSignals(companyName) {
  try {
    Logger.log(`[Revenue Signals START] ${companyName}`);

    const directResults = callSerper(companyName, "REVENUE_DIRECT");
    Utilities.sleep(CONFIG.BATCH.SERPER_SLEEP);

    const signalResults = callSerper(companyName, "REVENUE_SIGNALS");
    Utilities.sleep(CONFIG.BATCH.SERPER_SLEEP);

    const combinedEvidence = [
      directResults || "",
      signalResults || ""
    ].join("\n").trim();

    Logger.log(`[Revenue Signals SUCCESS] ${companyName}`);
    return combinedEvidence;

  } catch (err) {
    Logger.log(`[getRevenueSignals ERROR] ${companyName} | ${err.message}`);
    return "";
  }
}

// ============================================================
// SECTION 2 — DIRECT REVENUE EXTRACTION
// Uses revBand() — never getBand() — to avoid ICP band confusion
// ============================================================
function extractDirectRevenue(evidenceText) {
  if (!evidenceText || evidenceText.trim().length < 10) return null;

  // ── Range patterns first — "50-100 crore" style ──────────
  const rangePatterns = [
    /(?:annual turnover|turnover)[:\s,]+(?:rs\.?|₹|inr)?\s*([\d.]+)\s*(?:cr|crore)\s*(?:to|-)\s*([\d.]+)\s*(?:cr|crore)/i,
    /rs\.?\s*([\d.]+)\s*(?:cr|crore)?\s*(?:to|-)\s*(?:rs\.?)?\s*([\d.]+)\s*(?:cr|crore)/i,
    /(?:annual turnover)[^\n]{0,10}(?:rs\.?|₹)?\s*([\d.]+)\s*(?:cr|crore)\s*(?:to|-)\s*([\d.]+)\s*(?:cr|crore)/i,
  ];

  for (const pattern of rangePatterns) {
    const match = evidenceText.match(pattern);
    if (!match) continue;
    const low  = parseFloat(match[1].replace(/,/g, ""));
    const high = parseFloat(match[2].replace(/,/g, ""));
    if (isNaN(low) || isNaN(high)) continue;
    const mid = (low + high) / 2;
    const straddlesBoundary = (low < 50 && high >= 50);
    return {
      band:       revBand(mid),
      confidence: straddlesBoundary
                    ? CONFIG.REVENUE.CONFIDENCE.MEDIUM
                    : CONFIG.REVENUE.CONFIDENCE.HIGH,
      evidence:   `Range: ${low}-${high} Cr, midpoint ${mid.toFixed(1)} Cr`,
    };
  }

  // ── MSME raw number — "Turnover: 11484850" ────────────────
  const msmeMatch = evidenceText.match(/turnover[:\s]+(\d{5,})\b(?!\s*(?:cr|crore|lakh|\.))/i);
  if (msmeMatch) {
    const raw = parseFloat(msmeMatch[1]);
    if (!isNaN(raw)) {
      const cr = raw > 10000 ? raw / 10000000 : raw;
      return {
        band:       revBand(cr),
        confidence: CONFIG.REVENUE.CONFIDENCE.MEDIUM,
        evidence:   `MSME figure: ${cr.toFixed(2)} Cr`,
      };
    }
  }

  // ── Single value patterns ─────────────────────────────────
  const singlePatterns = [
    /operating revenue[:\s]+(?:rs\.?|₹|inr)?\s*([\d,]+(?:\.\d+)?)\s*(?:cr|crore)/i,
    /(?:total revenue|net revenue|revenue from operations)[^\d]{0,20}([\d,]+(?:\.\d+)?)\s*(?:cr|crore)/i,
    /(?:revenue|turnover|sales)[^\d]{0,40}(?:rs\.?|₹|inr)?\s*([\d,]+(?:\.\d+)?)\s*(?:cr|crore|crs)/i,
    /(?:revenue|turnover)[^\d]{0,30}([\d,]+(?:\.\d+)?)\s*(?:lakh|lac)/i,
    /turnover[^\d]{0,20}(?:rs\.?|₹|inr)?\s*([\d,]+(?:\.\d+)?)\s*(?:cr|crore)/i,
    /turnover[.\s]+(?:rs\.?|₹)?\s*([\d,]+(?:\.\d+)?)\s*(?:cr|crore)/i,
  ];

  for (let p = 0; p < singlePatterns.length; p++) {
    const match = evidenceText.match(singlePatterns[p]);
    if (!match) continue;
    let val = parseFloat(match[1].replace(/,/g, ""));
    if (isNaN(val)) continue;
    if (p === 3) val = val / 100; // lakh to crore
    return {
      band:       revBand(val),
      confidence: CONFIG.REVENUE.CONFIDENCE.HIGH,
      evidence:   `Direct figure: ${val} Cr`,
    };
  }

  // ── USD conversion — excludes "<$5M" style ────────────────
  const usdMatch = evidenceText.match(/(?<!<)\$\s*([\d.]+)\s*([MB])\b/i);
  if (usdMatch) {
    let usdVal = parseFloat(usdMatch[1]);
    if (usdMatch[2].toUpperCase() === "B") usdVal *= 1000;
    // 1M USD = 9.5 Cr at 95 INR/USD
    const cr = usdVal * 9.5;
    if (!isNaN(cr)) {
      return {
        band:       revBand(cr),
        confidence: CONFIG.REVENUE.CONFIDENCE.MEDIUM,
        evidence:   `USD converted: $${usdMatch[1]}${usdMatch[2]} = ~${cr.toFixed(1)} Cr`,
      };
    }
  }

  return null;
}

// ============================================================
// SECTION 2B — EMPLOYEE HEURISTIC
// Catches companies with clear employee signals before Gemini
// ============================================================
function employeeHeuristic(evidenceText) {
  if (!evidenceText) return null;

  const patterns = [
    { regex: /\bemployees[\s.:,]+(\d+)\b/i,                        type: "count" },
    { regex: /has\s+(\d+)\s*[-–]\s*(\d+)\s*employees/i,           type: "range" },
    { regex: /\b(\d+)\s*[-–]\s*(\d+)\s*employees/i,               type: "range" },
    { regex: /company size[:\s]+(\d+)\s*[-–]\s*(\d+)/i,           type: "range" },
    { regex: /total employees\s*(\d+)\s*[-–]\s*(\d+)/i,           type: "range" },
    { regex: /total employees\s*(\d+)/i,                           type: "count" },
    { regex: /\b(\d[\d,]*)\s*\+?\s*employees/i,                    type: "count" },
    { regex: /(?:workforce|staff)[:\s]+(\d+)/i,                    type: "count" },
    { regex: /no\.?\s*of\s*employees\s*(?:below|under)\s*(\d+)/i, type: "below" },
    { regex: /number\s*of\s*employees[:\s]+(\d+)\s*(?:to|-)\s*(\d+)/i, type: "range" },
  ];

  let count = null;

  for (const { regex, type } of patterns) {
    const match = evidenceText.match(regex);
    if (!match) continue;
    if (type === "range") {
      const lo = parseInt(match[1]);
      const hi = parseInt(match[2]);
      if (!isNaN(lo) && !isNaN(hi)) { count = (lo + hi) / 2; break; }
    } else if (type === "below") {
      const val = parseInt(match[1]);
      if (!isNaN(val)) { count = val - 1; break; }
    } else {
      const val = parseInt(String(match[1]).replace(/,/g, ""));
      if (!isNaN(val)) { count = val; break; }
    }
  }

  if (count === null) return null;

  Logger.log(`[employeeHeuristic] count=${count}`);

  if (count < 50) {
    return {
      band:       CONFIG.REVENUE.BANDS.VERY_SMALL,
      confidence: CONFIG.REVENUE.CONFIDENCE.MEDIUM,
      evidence:   `Employee count ${Math.round(count)} — below threshold for 50Cr`,
    };
  }

  // count >= 50: send to Gemini — employee count alone is not reliable enough to auto-pass
  Logger.log(`[employeeHeuristic] count ${count} >= 50 — queuing for Gemini`);
  return null;
}

// ============================================================
// SECTION 3 — MAIN REVENUE FLOW
// L1: direct regex → L2: employee heuristic → L3: null for Gemini batch
// ============================================================
function inferRevenueBand(companyName, evidenceText) {
  try {
    Logger.log(`[Revenue Flow START] ${companyName}`);

    const direct = extractDirectRevenue(evidenceText);
    if (direct) {
      Logger.log(`[Revenue L1 Direct] ${companyName} → ${direct.band}`);
      return direct;
    }

    const heuristic = employeeHeuristic(evidenceText);
    if (heuristic) {
      Logger.log(`[Revenue L2 Heuristic] ${companyName} → ${heuristic.band}`);
      return heuristic;
    }

    Logger.log(`[Revenue L3 Gemini Queue] ${companyName}`);
    return null;

  } catch (err) {
    Logger.log(`[inferRevenueBand ERROR] ${companyName} | ${err.message}`);
    return {
      band:       CONFIG.REVENUE.BANDS.UNKNOWN,
      confidence: CONFIG.REVENUE.CONFIDENCE.LOW,
      evidence:   "Revenue pipeline failed",
    };
  }
}

// ============================================================
// SECTION 4 — GEMINI BATCH — entry point
// Splits into batches of 10, calls inferRevenueBatchGemini
// ============================================================
function inferRevenueBatch(companyObjects) {
  if (!companyObjects || !companyObjects.length) return [];

  Logger.log(`[inferRevenueBatch START] ${companyObjects.length} companies`);

  const results = [];

  for (let i = 0; i < companyObjects.length; i += 10) {
    const batch = companyObjects.slice(i, i + 10);
    Logger.log(`[inferRevenueBatch] Batch ${Math.floor(i / 10) + 1} — ${batch.length} companies`);

    const batchResults = inferRevenueBatchGemini(batch);
    batchResults.forEach(r => results.push(r));

    if (i + 10 < companyObjects.length) {
      Utilities.sleep(CONFIG.BATCH.GEMINI_SLEEP);
    }
  }

  Logger.log(`[inferRevenueBatch COMPLETE] ${results.length} results`);
  return results;
}

// ============================================================
// SECTION 5 — GEMINI BATCH — actual API call
// Sends up to 10 companies in one prompt, parses JSON array
// ============================================================
function inferRevenueBatchGemini(companyObjects) {
  if (!companyObjects || !companyObjects.length) return [];

  const companiesBlock = companyObjects.map((obj, idx) => {
    const evidence = (
      (obj.directSnippet || obj.evidence || "") + " " +
      (obj.signalsSnippet || "")
    ).substring(0, 600).trim();
    return `${idx + 1}. Company: ${obj.company}\nEvidence: ${evidence || "No evidence available"}`;
  }).join("\n\n");

  const prompt = PROMPTS.REVENUE_BATCH.replace("{companies_block}", companiesBlock);
  Logger.log(`[inferRevenueBatchGemini] Prompt length: ${prompt.length} chars`);

  let raw = null;
  try {
    raw = callGeminiWithRetry(prompt, { company: '[batch-' + companyObjects.length + ']', stage: 's1-revenue-batch' });
  } catch (err) {
    Logger.log(`[inferRevenueBatchGemini ERROR] callGeminiWithRetry threw: ${err.message}`);
  }

  if (!raw) {
    Logger.log(`[inferRevenueBatchGemini ERROR] Null response — returning Unknown for all`);
    return companyObjects.map(obj => ({
      company:    obj.company,
      band:       CONFIG.REVENUE.BANDS.UNKNOWN,
      confidence: CONFIG.REVENUE.CONFIDENCE.LOW,
      signal:     "Gemini returned null",
      source:     "None",
      method:     "gemini-failed"
    }));
  }

  Logger.log(`[inferRevenueBatchGemini] Raw preview: ${raw.substring(0, 300)}`);

  let parsed = null;
  try {
    parsed = parseGeminiJSON(raw);
  } catch (err) {
    Logger.log(`[inferRevenueBatchGemini ERROR] parseGeminiJSON threw: ${err.message}`);
  }

  if (!parsed) {
    Logger.log(`[inferRevenueBatchGemini ERROR] Parse null. Full raw: ${raw}`);
    return companyObjects.map(obj => ({
      company:    obj.company,
      band:       CONFIG.REVENUE.BANDS.UNKNOWN,
      confidence: CONFIG.REVENUE.CONFIDENCE.LOW,
      signal:     "JSON parse failed",
      source:     "None",
      method:     "gemini-parse-failed"
    }));
  }

  if (!Array.isArray(parsed)) {
    Logger.log(`[inferRevenueBatchGemini ERROR] Not array — type: ${typeof parsed}`);
    const recovered = parsed.results || parsed.companies || parsed.data || null;
    if (Array.isArray(recovered)) {
      Logger.log(`[inferRevenueBatchGemini] Recovered wrapped array`);
      parsed = recovered;
    } else {
      return companyObjects.map(obj => ({
        company:    obj.company,
        band:       CONFIG.REVENUE.BANDS.UNKNOWN,
        confidence: CONFIG.REVENUE.CONFIDENCE.LOW,
        signal:     "Response not array",
        source:     "None",
        method:     "gemini-format-error"
      }));
    }
  }

  const allowedBands = [
    CONFIG.REVENUE.BANDS.VERY_SMALL,
    CONFIG.REVENUE.BANDS.MID,
    CONFIG.REVENUE.BANDS.LARGE,
    CONFIG.REVENUE.BANDS.VERY_LARGE,
    CONFIG.REVENUE.BANDS.UNKNOWN,
  ];
  const allowedConf = ["High", "Medium", "Low"];

  return companyObjects.map((obj, idx) => {
    const result = parsed[idx];

    if (!result) {
      Logger.log(`[inferRevenueBatchGemini WARN] No result at index ${idx} for: ${obj.company}`);
      return {
        company:    obj.company,
        band:       CONFIG.REVENUE.BANDS.UNKNOWN,
        confidence: CONFIG.REVENUE.CONFIDENCE.LOW,
        signal:     `Missing at index ${idx}`,
        source:     "None",
        method:     "gemini-missing"
      };
    }

    const band       = allowedBands.includes(result.band)      ? result.band      : CONFIG.REVENUE.BANDS.UNKNOWN;
    const confidence = allowedConf.includes(result.confidence) ? result.confidence : CONFIG.REVENUE.CONFIDENCE.LOW;

    // Unknown → FAIL vs MANUAL_REVIEW based on employee count
    let method = "gemini";
    if (band === CONFIG.REVENUE.BANDS.UNKNOWN) {
      const evidenceCheck = (
        (obj.directSnippet || obj.evidence || "") + " " +
        (obj.signalsSnippet || "")
      ).toLowerCase();
      const tinyMatch =
        evidenceCheck.match(/\b([1-9]|10)\s*\+?\s*employees/i)  ||
        evidenceCheck.match(/company size[:\s]+1\s*[-–]\s*10/i) ||
        evidenceCheck.match(/has\s+[1-9]\s*[-–]\s*10\s*employees/i) ||
        evidenceCheck.match(/employs\s+[1-9]\s*employees/i);
      method = tinyMatch ? "gemini-unknown-fail" : "gemini-unknown-review";
    }

    if (!allowedBands.includes(result.band)) {
      Logger.log(`[inferRevenueBatchGemini WARN] Invalid band "${result.band}" for ${obj.company}`);
    }

    Logger.log(`[inferRevenueBatchGemini] ${obj.company} → ${band} (${confidence}) | ${result.signal || ""}`);

    return {
      company:    obj.company,
      band:       band,
      confidence: confidence,
      evidence:   String(result.signal || "").substring(0, 150),
      signal:     String(result.signal || "").substring(0, 150),
      source:     String(result.source || "Gemini"),
      method:     method
    };
  });
}

// ============================================================
// SECTION 6 — LEGACY SINGLE-COMPANY GEMINI
// Kept for backward compatibility — not called by main pipeline
// ============================================================
function inferRevenueWithGemini(companyName, evidenceText) {
  try {
    Logger.log(`[Gemini Revenue START] ${companyName}`);

    if (!evidenceText) {
      return {
        band:       CONFIG.REVENUE.BANDS.UNKNOWN,
        confidence: CONFIG.REVENUE.CONFIDENCE.LOW,
        evidence:   "No revenue evidence",
      };
    }

    const prompt   = buildPrompt("REVENUE_SINGLE", companyName, evidenceText);
    const response = callGeminiWithRetry(prompt, { company: companyName, stage: 's1-revenue' });
    Utilities.sleep(CONFIG.BATCH.GEMINI_SLEEP);

    if (!response) {
      return {
        band:       CONFIG.REVENUE.BANDS.UNKNOWN,
        confidence: CONFIG.REVENUE.CONFIDENCE.LOW,
        evidence:   "Gemini empty response",
      };
    }

    const parsed = parseGeminiJSON(response);
    if (!parsed) {
      return {
        band:       CONFIG.REVENUE.BANDS.UNKNOWN,
        confidence: CONFIG.REVENUE.CONFIDENCE.LOW,
        evidence:   "Invalid Gemini JSON",
      };
    }

    const allowedBands = [
      CONFIG.REVENUE.BANDS.VERY_SMALL,
      CONFIG.REVENUE.BANDS.MID,
      CONFIG.REVENUE.BANDS.LARGE,
      CONFIG.REVENUE.BANDS.VERY_LARGE,
      CONFIG.REVENUE.BANDS.UNKNOWN,
    ];

    if (!allowedBands.includes(parsed.band)) {
      parsed.band = CONFIG.REVENUE.BANDS.UNKNOWN;
    }

    Logger.log(`[Gemini Revenue SUCCESS] ${companyName} → ${parsed.band}`);

    return {
      band:       parsed.band       || CONFIG.REVENUE.BANDS.UNKNOWN,
      confidence: parsed.confidence || CONFIG.REVENUE.CONFIDENCE.LOW,
      evidence:   parsed.evidence   || "Gemini inferred revenue",
    };

  } catch (err) {
    Logger.log(`[inferRevenueWithGemini ERROR] ${companyName} | ${err.message}`);
    return {
      band:       CONFIG.REVENUE.BANDS.UNKNOWN,
      confidence: CONFIG.REVENUE.CONFIDENCE.LOW,
      evidence:   "Gemini inference failed",
    };
  }
}

// ============================================================
// SECTION 7 — HELPER
// ============================================================
function inferRevenueWithGeminiHelper(companyName, evidenceText) {
  try {
    Logger.log(`[inferRevenueWithGeminiHelper START] ${companyName}`);

    const prompt  = buildPrompt("REVENUE_SINGLE", companyName, evidenceText);
    const raw     = callGeminiWithRetry(prompt, { company: companyName, stage: 's1-revenue' });
    if (!raw) return null;

    const parsed = parseGeminiJSON(raw);
    if (!parsed) return null;

    Logger.log(`[inferRevenueWithGeminiHelper SUCCESS] ${companyName}`);
    return parsed;

  } catch (err) {
    Logger.log(`[inferRevenueWithGeminiHelper ERROR] ${companyName} | ${err.message}`);
    return null;
  }
}

// ============================================================
// SECTION 8 — TEST FUNCTION
// ============================================================
function testRevenue() {
  Logger.log(`=== testRevenue START ===`);

  try {
    const companies = getCompanies().slice(0, 4);

    for (const companyObj of companies) {
      const company = cleanCompanyName(companyObj.company);
      Logger.log(`\n[TEST] ${company}`);

      const evidence = getRevenueSignals(company);
      Logger.log(`[Evidence Length] ${evidence.length}`);

      const revenue = inferRevenueBand(company, evidence);
      Logger.log(JSON.stringify(revenue, null, 2));
    }

    Logger.log(`=== testRevenue COMPLETE ===`);

  } catch (err) {
    Logger.log(`[testRevenue ERROR] ${err.message}`);
  }
}

// ===== FILE: sheetManager.js =====
// ============================================================
// sheetManager.gs
// All Sheet Operations for ICP Pipeline
// CLEANED + OPTIMIZED VERSION
// ============================================================

// ── In-memory caches (loaded once per GAS execution) ────────
// GAS resets module-level vars at the start of each trigger
// fire, so these are always loaded fresh each run — safe.
var _cacheMap    = null;  // Map<"company|QUERYTYPE", snippetText>
var _filteredSet = null;  // Set<companyName.toLowerCase()>

function _loadCacheMap_() {
  _cacheMap = new Map();
  try {
    var ss    = SpreadsheetApp.getActiveSpreadsheet();
    var sheet = ss.getSheetByName(SHEETS.CACHE);
    if (!sheet || sheet.getLastRow() < 2) return;
    var data  = sheet.getRange(2, 1, sheet.getLastRow() - 1, 4).getValues();
    data.forEach(function(row) {
      var name     = String(row[0] || '').trim().toLowerCase();
      var qtype    = String(row[1] || '').trim().toUpperCase();
      var snippets = String(row[3] || '').trim();
      if (name && qtype && snippets) _cacheMap.set(name + '|' + qtype, snippets);
    });
    Logger.log('[Cache] Loaded ' + _cacheMap.size + ' entries into memory');
  } catch(e) {
    Logger.log('[_loadCacheMap_ ERROR] ' + e.message);
  }
}

function _loadFilteredSet_() {
  _filteredSet = new Set();
  try {
    var ss    = SpreadsheetApp.getActiveSpreadsheet();
    var sheet = ss.getSheetByName(SHEETS.STAGE1);
    if (!sheet || sheet.getLastRow() < 2) return;
    var data  = sheet.getRange(2, 1, sheet.getLastRow() - 1, 1).getValues();
    data.forEach(function(row) {
      var name = String(row[0] || '').trim().toLowerCase();
      if (name) _filteredSet.add(name);
    });
    Logger.log('[FilteredSet] Loaded ' + _filteredSet.size + ' entries into memory');
  } catch(e) {
    Logger.log('[_loadFilteredSet_ ERROR] ' + e.message);
  }
}

// ============================================================
// SECTION 1 — SETUP
// ============================================================

function setupSheets() {

  try {

    const ss =
      SpreadsheetApp.getActiveSpreadsheet();

    const sheetsToCreate = [

      // ------------------------------------------------------
      // STAGE 1 RESULTS
      // ------------------------------------------------------
      {
        name: SHEETS.STAGE1,

        headers: [

          "Company Name",
          "Website",
          "Source",

          "Manufacturer_Flag",
          "Acquired_Flag",

          "Revenue_Band",
          "Revenue_Confidence",
          "Revenue_Evidence",
          "Revenue_Source",

          "Stage1_Status",
          "Fail_Reason",
        ],
      },

      // ------------------------------------------------------
      // SEARCH CACHE
      // ------------------------------------------------------
      {
        name: SHEETS.CACHE,

        headers: [

          "Company Name",
          "Query_Type",
          "Query_String",
          "Snippets",
          "Timestamp",
        ],
      },

      // ------------------------------------------------------
      // SCORES
      // DO NOT CHANGE TODAY
      // ------------------------------------------------------
      {
        name: SHEETS.SCORES,

        headers: [

          "Company Name",
          "Website",
          "Source",

          "C1",
          "C2",

          "C3",
          "C3_Evidence",
          "C3_Confidence",

          "C4",
          "C4_DM_Name",
          "C4_Background",
          "C4_Confidence",

          "C5",
          "C5_Sector",
          "C5_Reason",

          "C6",
          "C6_Signals",
          "C6_Confidence",

          "Final_Score",
          "Band",
          "Band_Label",
        ],
      },

      // ------------------------------------------------------
      // SHORTLIST
      // DO NOT CHANGE TODAY
      // ------------------------------------------------------
      {
        name: SHEETS.SHORTLIST,

        headers: [

          "Rank",

          "Company Name",
          "Website",
          "Source",

          "C1_Score",
          "C2_Score",

          "C3_Score",
          "C3_Evidence",

          "C4_Score",
          "C4_DM_Name",
          "C4_Background",

          "C5_Score",
          "C5_Sector",

          "C6_Score",
          "C6_Signals",

          "Final_Score",

          "Band",
          "Band_Label",

          "Verdict",
          "Manual_Notes",
        ],
      },
    ];

    // --------------------------------------------------------
    // CREATE / VERIFY SHEETS
    // --------------------------------------------------------

    sheetsToCreate.forEach(({ name, headers }) => {

      let sheet =
        ss.getSheetByName(name);

      // ------------------------------------------------------
      // CREATE SHEET
      // ------------------------------------------------------

      if (!sheet) {

        sheet = ss.insertSheet(name);

        Logger.log(
          `[setupSheets] Created sheet: ${name}`
        );
      }

      // ------------------------------------------------------
      // WRITE HEADERS ONLY IF EMPTY
      // ------------------------------------------------------

      const firstCell =
        sheet.getRange(1, 1).getValue();

      if (!firstCell) {

        sheet
          .getRange(
            1,
            1,
            1,
            headers.length
          )
          .setValues([headers]);

        sheet
          .getRange(
            1,
            1,
            1,
            headers.length
          )
          .setFontWeight("bold");

        Logger.log(
          `[setupSheets] Headers added: ${name}`
        );
      }
    });

    Logger.log(
      `[setupSheets SUCCESS]`
    );

  } catch (err) {

    Logger.log(
      `[setupSheets ERROR] ${err.message}`
    );
  }
}



// ============================================================
// SECTION 2 — READ MASTER SHEET
// ============================================================

function getCompanies() {

  try {

    const ss =
      SpreadsheetApp.getActiveSpreadsheet();

    const sheet =
      ss.getSheetByName(
        SHEETS.MASTER
      );

    if (!sheet) {

      throw new Error(
        "MASTER sheet not found"
      );
    }

    const lastRow =
      sheet.getLastRow();

    if (lastRow < 2) {

      Logger.log(
        `[getCompanies] No company rows found`
      );

      return [];
    }

    const data =
      sheet
        .getRange(
          2,
          1,
          lastRow - 1,
          3
        )
        .getValues();

    const companies = [];

    data.forEach((row, index) => {

      const company = String(
        row[MASTER_COLS.COMPANY] || ""
      ).trim();

      if (!company) return;

      companies.push({

        company,

        website: String(
          row[MASTER_COLS.WEBSITE] || ""
        ).trim(),

        source: String(
          row[MASTER_COLS.SOURCE] || ""
        ).trim(),

        rowIndex: index + 2,
      });
    });

    Logger.log(
      `[getCompanies SUCCESS] ${companies.length} loaded`
    );

    return companies;

  } catch (err) {

    Logger.log(
      `[getCompanies ERROR] ${err.message}`
    );

    return [];
  }
}



// ============================================================
// SECTION 3 — CHECKPOINT MANAGEMENT
// ============================================================

function getCheckpoint() {

  try {

    const props =
      PropertiesService
        .getScriptProperties();

    const value =
      props.getProperty(
        "PIPELINE_CHECKPOINT"
      );

    return value
      ? parseInt(value, 10)
      : 0;

  } catch (err) {

    Logger.log(
      `[getCheckpoint ERROR] ${err.message}`
    );

    return 0;
  }
}


function saveCheckpoint(index) {

  try {

    PropertiesService
      .getScriptProperties()
      .setProperty(
        "PIPELINE_CHECKPOINT",
        String(index)
      );

    Logger.log(
      `[Checkpoint Saved] ${index}`
    );

  } catch (err) {

    Logger.log(
      `[saveCheckpoint ERROR] ${err.message}`
    );
  }
}


function resetCheckpoint() {

  try {

    PropertiesService
      .getScriptProperties()
      .deleteProperty(
        "PIPELINE_CHECKPOINT"
      );

    Logger.log(
      `[Checkpoint Reset]`
    );

  } catch (err) {

    Logger.log(
      `[resetCheckpoint ERROR] ${err.message}`
    );
  }
}



// ============================================================
// SECTION 4 — SEARCH CACHE
// ============================================================

function getCachedSearch(companyName, queryType) {
  try {
    if (_cacheMap === null) _loadCacheMap_();
    var key = companyName.trim().toLowerCase() + '|' + queryType.trim().toUpperCase();
    return _cacheMap.get(key) || null;
  } catch (err) {
    Logger.log('[getCachedSearch ERROR] ' + err.message);
    return null;
  }
}



function saveToCache(companyName, queryType, queryString, snippets) {
  try {
    const ss    = SpreadsheetApp.getActiveSpreadsheet();
    const sheet = ss.getSheetByName(SHEETS.CACHE);
    if (!sheet) throw new Error("SEARCH_CACHE sheet missing");

    sheet.appendRow([companyName, queryType.toUpperCase(), queryString, snippets, new Date().toISOString()]);

    // Keep in-memory map in sync so subsequent lookups this execution see the new entry
    if (_cacheMap !== null && snippets) {
      const key = companyName.trim().toLowerCase() + '|' + queryType.trim().toUpperCase();
      _cacheMap.set(key, snippets);
    }
  } catch (err) {
    Logger.log(`[saveToCache ERROR] ${err.message}`);
  }
}



// ============================================================
// SECTION 5 — WRITE STAGE 1 RESULTS
// ============================================================

function writeStage1Result(companyObj, result) {
  try {
    const ss = SpreadsheetApp.getActiveSpreadsheet();
    const sheet = ss.getSheetByName(SHEETS.STAGE1);

    if (!sheet) throw new Error("STAGE1_RESULTS sheet missing");

    // Determine band display value
    // "-"              → Gate 1 or Gate 2 failed, revenue never checked
    // "PENDING_REVENUE" → needs Gemini batch
    // "<50Cr" etc.     → direct regex found a number
    // "Unknown"        → Gate 3 reached but no evidence at all
    const band = result.revenueBand?.band ?? "-";
    const confidence = result.revenueBand?.confidence ?? "-";
    const evidence = result.revenueBand?.evidence ?? "-";

    sheet.appendRow([
      companyObj.company,
      companyObj.website,
      companyObj.source,
      result.manufacturer ? "YES" : "NO",
      result.acquired     ? "YES" : "NO",
      band,
      confidence,
      evidence,
      result.revenueSource || "-",
      result.status        || "FAIL",
      result.failReason    || "",
    ]);

    // Keep in-memory set in sync so isAlreadyFiltered() sees this company immediately
    if (_filteredSet !== null) {
      _filteredSet.add(companyObj.company.trim().toLowerCase());
    }

  } catch (err) {
    Logger.log(`[writeStage1Result ERROR] ${companyObj.company} | ${err.message}`);
  }
}



// ============================================================
// SECTION 6 — FLAG FOR REVIEW
// ============================================================

function flagForReview(
  companyObj,
  reason
) {

  try {

    writeStage1Result(companyObj, {

      manufacturer: false,

      acquired: false,

      revenueBand: {

        band:
          CONFIG.REVENUE.BANDS.UNKNOWN,

        confidence:
          CONFIG.REVENUE.CONFIDENCE.LOW,

        evidence:
          "Manual review required",
      },

      status: "MANUAL_REVIEW",

      failReason: reason,
    });

  } catch (err) {

    Logger.log(
      `[flagForReview ERROR] ${companyObj.company} | ${err.message}`
    );
  }
}



// ============================================================
// SECTION 7 — WRITE FINAL SCORES
// DO NOT CHANGE TODAY
// ============================================================

function writeScores(
  companyObj,
  scores
) {

  try {

    const ss =
      SpreadsheetApp.getActiveSpreadsheet();

    const sheet =
      ss.getSheetByName(
        SHEETS.SCORES
      );

    if (!sheet) {

      throw new Error(
        "SCORES sheet missing"
      );
    }

    sheet.appendRow([

      companyObj.company,
      companyObj.website,
      companyObj.source,

      scores.c1 || 0,
      scores.c2 || 5,

      scores.c3 || 0,
      scores.c3Evidence || "",
      scores.c3Confidence || "Low",

      scores.c4 || 0,
      scores.c4DmName || "Unknown",
      scores.c4Background || "",
      scores.c4Confidence || "Low",

      scores.c5 || 0,
      scores.c5Sector || "Other",
      scores.c5Reason || "",

      scores.c6 || 0,
      scores.c6Signals || "",
      scores.c6Confidence || "Low",

      scores.finalScore || 0,

      scores.band || "D",

      scores.bandLabel || "Not ICP",
    ]);

  } catch (err) {

    Logger.log(
      `[writeScores ERROR] ${companyObj.company} | ${err.message}`
    );
  }
}



// ============================================================
// SECTION 8 — BUILD SHORTLIST
// ============================================================
function buildShortlist() {
  try {
    Logger.log(`[buildShortlist START]`);

    const ss            = SpreadsheetApp.getActiveSpreadsheet();
    const scoresSheet   = ss.getSheetByName(SHEETS.SCORES);
    const stage1Sheet   = ss.getSheetByName(SHEETS.STAGE1);
    const shortlistSheet = ss.getSheetByName(SHEETS.SHORTLIST);

    if (!scoresSheet || !shortlistSheet || !stage1Sheet) {
      throw new Error("Required sheets missing — run setupSheets() first");
    }

    // Clear existing shortlist content but keep headers
    if (shortlistSheet.getLastRow() > 1) {
      shortlistSheet.getRange(
        2, 1,
        shortlistSheet.getLastRow() - 1,
        shortlistSheet.getLastColumn()
      ).clearContent();
    }

    // ── Section 1: Pull scored companies from SCORES ───────
    // Only bands at or above CONFIG.SHORTLIST_MIN_BAND make the
    // shortlist (CONFIG.BANDS is ordered best-to-worst: A,B,C,D).
    const bandOrder    = CONFIG.BANDS.map(b => b.band);
    const minBandIdx   = bandOrder.indexOf(CONFIG.SHORTLIST_MIN_BAND);
    const allowedBands = minBandIdx === -1 ? bandOrder : bandOrder.slice(0, minBandIdx + 1);

    const scoresData = scoresSheet.getLastRow() > 1
      ? scoresSheet.getRange(2, 1, scoresSheet.getLastRow() - 1, 21).getValues()
      : [];

    // Sort by final score descending
    scoresData.sort((a, b) => (b[18] || 0) - (a[18] || 0));

    let rank = 1;
    const rows = [];

    scoresData.forEach(row => {
      const company    = String(row[0]  || "").trim();
      const website    = String(row[1]  || "").trim();
      const source     = String(row[2]  || "").trim();
      const c1         = row[3]  || 0;
      const c2         = row[4]  || 0;
      const c3         = row[5]  || 0;
      const c3Evidence = row[6]  || "";
      const c4         = row[8]  || 0;
      const c4DmName   = row[9]  || "";
      const c4Bg       = row[10] || "";
      const c5         = row[12] || 0;
      const c5Sector   = row[13] || "";
      const c6         = row[15] || 0;
      const c6Signals  = row[16] || "";
      const finalScore = row[18] || 0;
      const band       = row[19] || "";
      const bandLabel  = row[20] || "";

      if (!company) return;
      if (!allowedBands.includes(band)) return;

      // Verdict based on band
      let verdict = "Not ICP";
      if (band === "A")      verdict = "Strong ICP — prioritise outreach";
      else if (band === "B") verdict = "Probable ICP — include in outreach";

      rows.push([
        rank++,
        company,
        website,
        source,
        c1,
        c2,
        c3,
        c3Evidence,
        c4,
        c4DmName,
        c4Bg,
        c5,
        c5Sector,
        c6,
        c6Signals,
        finalScore,
        band,
        bandLabel,
        verdict,
        "", // Manual_Notes — empty, for you to fill
      ]);
    });

    // ── Section 2: Pull MANUAL_REVIEW companies from STAGE1
    // These never reached scoring — need human decision
    const stage1Data = stage1Sheet.getLastRow() > 1
      ? stage1Sheet.getRange(2, 1, stage1Sheet.getLastRow() - 1, 11).getValues()
      : [];

    stage1Data.forEach(row => {
      const company    = String(row[0]  || "").trim();
      const website    = String(row[1]  || "").trim();
      const source     = String(row[2]  || "").trim();
      const status     = String(row[9]  || "").trim();
      const failReason = String(row[10] || "").trim();

      if (!company || status !== "MANUAL_REVIEW") return;

      rows.push([
        "", // no rank for manual review
        company,
        website,
        source,
        "", "", "", "", "", "", "",
        "", "", "", "",
        "", // no final score
        "MANUAL_REVIEW",
        "Needs human decision",
        `Manual review required: ${failReason}`,
        "", // Manual_Notes
      ]);
    });

    // Write all rows
    if (rows.length) {
      // Extend headers to include Manual_Notes column
      const headers = shortlistSheet.getRange(1, 1, 1, 20).getValues()[0];
      if (!headers[19]) {
        shortlistSheet.getRange(1, 20).setValue("Manual_Notes");
        shortlistSheet.getRange(1, 20).setFontWeight("bold");
      }

      shortlistSheet.getRange(2, 1, rows.length, 20).setValues(rows);
    }

    // ── Formatting ─────────────────────────────────────────
    // Color code by band
    if (rows.length) {
      rows.forEach((row, idx) => {
        const band      = String(row[16] || "");
        const rowNum    = idx + 2;
        const range     = shortlistSheet.getRange(rowNum, 1, 1, 20);

        if (band === "A") {
          range.setBackground("#d4edda"); // green
        } else if (band === "B") {
          range.setBackground("#cce5ff"); // blue
        } else if (band === "C") {
          range.setBackground("#fff3cd"); // yellow
        } else if (band === "MANUAL_REVIEW") {
          range.setBackground("#f8d7da"); // red/pink
        }
      });
    }

    // Auto-resize key columns
    shortlistSheet.autoResizeColumn(2);  // Company
    shortlistSheet.autoResizeColumn(8);  // C3 Evidence
    shortlistSheet.autoResizeColumn(19); // Verdict

    const scored       = rows.filter(r => r[16] !== "MANUAL_REVIEW").length;
    const manualReview = rows.filter(r => r[16] === "MANUAL_REVIEW").length;

    Logger.log(`[buildShortlist SUCCESS] ${scored} scored companies (Band ${allowedBands.join('/')} only) + ${manualReview} manual review`);
    Logger.log(`[buildShortlist] Band A: ${rows.filter(r => r[16] === "A").length}`);
    Logger.log(`[buildShortlist] Band B: ${rows.filter(r => r[16] === "B").length}`);
    Logger.log(`[buildShortlist] Manual Review: ${manualReview}`);

    // Re-apply EST_MISTAKE marks if that sheet exists
    if (ss.getSheetByName("EST_MISTAKE")) {
      markEstMistakeInShortlist();
    }

  } catch (err) {
    Logger.log(`[buildShortlist ERROR] ${err.message}`);
  }
}

// ============================================================
// SECTION 8B — MARK EST_MISTAKE COMPANIES IN SHORTLIST
// Reads "Company Name" + "Revenue_Source" from EST_MISTAKE,
// finds matching rows in SHORTLIST (col 2), highlights in
// orange, and writes a source-specific tag to Manual_Notes:
//   Revenue_Source = Signals   → "Signals Est Mistake"
//   Revenue_Source = Heuristic → "Estimation Mistake"
// Safe to re-run: clears previous marks before re-marking.
// ============================================================
function markEstMistakeInShortlist() {
  try {
    const ss             = SpreadsheetApp.getActiveSpreadsheet();
    const estSheet       = ss.getSheetByName("EST_MISTAKE");
    const shortlistSheet = ss.getSheetByName(SHEETS.SHORTLIST);

    if (!estSheet)       throw new Error("EST_MISTAKE sheet not found");
    if (!shortlistSheet || shortlistSheet.getLastRow() < 2) {
      Logger.log("[markEstMistakeInShortlist] SHORTLIST is empty or missing");
      return;
    }

    // ── Locate columns in EST_MISTAKE ─────────────────────
    const estHeaders = estSheet
      .getRange(1, 1, 1, estSheet.getLastColumn())
      .getValues()[0];
    const companyColIdx = estHeaders.findIndex(
      h => String(h).trim().toLowerCase() === "company name"
    );
    if (companyColIdx === -1)
      throw new Error('"Company Name" column not found in EST_MISTAKE');

    const sourceColIdx = estHeaders.findIndex(
      h => String(h).trim().toLowerCase() === "revenue_source"
    );

    // ── Build Map: company (lowercase) → tag ─────────────
    const TAG_SIGNALS   = "Signals Est Mistake";
    const TAG_HEURISTIC = "Estimation Mistake";
    // All tags ever written by this function — used for clean stale-mark removal
    const ALL_TAGS = [TAG_SIGNALS, TAG_HEURISTIC,
                      "EST_MISTAKE match",
                      "Revenue Estimation Mistake, Revenue out of Range"];

    const numEstRows = Math.max(estSheet.getLastRow() - 1, 1);
    const colsToRead = sourceColIdx === -1
      ? companyColIdx + 1
      : Math.max(companyColIdx, sourceColIdx) + 1;
    const estData = estSheet
      .getRange(2, 1, numEstRows, colsToRead)
      .getValues();

    const estMap = new Map();
    estData.forEach(row => {
      const name = String(row[companyColIdx] || "").trim().toLowerCase();
      if (!name) return;
      const src = sourceColIdx !== -1
        ? String(row[sourceColIdx] || "").trim().toLowerCase()
        : "";
      estMap.set(name, src === "signals" ? TAG_SIGNALS : TAG_HEURISTIC);
    });

    Logger.log(`[markEstMistakeInShortlist] ${estMap.size} companies loaded from EST_MISTAKE`);

    // ── Scan SHORTLIST and (re)apply marks ────────────────
    const numRows  = shortlistSheet.getLastRow() - 1;
    const numCols  = shortlistSheet.getLastColumn();
    const slData   = shortlistSheet
      .getRange(2, 1, numRows, numCols)
      .getValues();

    const MARK_COLOR  = "#ffe0b2"; // orange — distinct from band A/B/C colours
    const BAND_COLORS = { A: "#d4edda", B: "#cce5ff", C: "#fff3cd" };

    const escapeRegex = s => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const stripTags   = text =>
      ALL_TAGS.reduce(
        (t, tag) => t.replace(new RegExp(";?\\s*" + escapeRegex(tag), "g"), ""),
        text
      ).trim();

    let matched = 0;

    slData.forEach((row, idx) => {
      const company   = String(row[1] || "").trim().toLowerCase();
      const band      = String(row[16] || "").trim();
      const rowNum    = idx + 2;
      const range     = shortlistSheet.getRange(rowNum, 1, 1, numCols);
      const notesCell = shortlistSheet.getRange(rowNum, 20);

      if (estMap.has(company)) {
        const tag     = estMap.get(company);
        const cleaned = stripTags(String(notesCell.getValue() || ""));
        range.setBackground(MARK_COLOR);
        notesCell.setValue(cleaned ? cleaned + "; " + tag : tag);
        matched++;
      } else {
        // Clear any stale marks from a previous run
        const noteVal = String(notesCell.getValue() || "");
        if (ALL_TAGS.some(t => noteVal.includes(t))) {
          notesCell.setValue(stripTags(noteVal));
          range.setBackground(BAND_COLORS[band] || null);
        }
      }
    });

    SpreadsheetApp.flush();

    const msg = `${matched} of ${estMap.size} EST_MISTAKE companies found and highlighted in SHORTLIST`;
    Logger.log(`[markEstMistakeInShortlist] ${msg}`);
    SpreadsheetApp.getActive().toast(msg, "Done", 6);

  } catch (err) {
    Logger.log(`[markEstMistakeInShortlist ERROR] ${err.message}`);
    SpreadsheetApp.getActive().toast("Error: " + err.message, "markEstMistakeInShortlist", 8);
  }
}

// ============================================================
// SECTION 9 — STATUS HELPERS
// ============================================================

function isAlreadyScored(
  companyName
) {

  try {

    const ss =
      SpreadsheetApp.getActiveSpreadsheet();

    const sheet =
      ss.getSheetByName(
        SHEETS.SCORES
      );

    if (
      !sheet ||
      sheet.getLastRow() < 2
    ) {

      return false;
    }

    const data =
      sheet
        .getRange(
          2,
          1,
          sheet.getLastRow() - 1,
          1
        )
        .getValues();

    return data.some(
      row =>

        String(row[0])
          .trim()
          .toLowerCase()

        ===

        companyName
          .trim()
          .toLowerCase()
    );

  } catch (err) {

    Logger.log(
      `[isAlreadyScored ERROR] ${err.message}`
    );

    return false;
  }
}



function isAlreadyFiltered(companyName) {
  try {
    if (_filteredSet === null) _loadFilteredSet_();
    return _filteredSet.has(companyName.trim().toLowerCase());
  } catch (err) {
    Logger.log(`[isAlreadyFiltered ERROR] ${err.message}`);
    return false;
  }
}



// ============================================================
// SECTION 10 — GET STAGE1 STATUS
// ============================================================

function getStage1Status(
  companyName
) {

  try {

    const ss =
      SpreadsheetApp.getActiveSpreadsheet();

    const sheet =
      ss.getSheetByName(
        SHEETS.STAGE1
      );

    if (
      !sheet ||
      sheet.getLastRow() < 2
    ) {

      return null;
    }

    // NOW 11 COLUMNS (Revenue_Source added at col 9)
    const data =
      sheet
        .getRange(
          2,
          1,
          sheet.getLastRow() - 1,
          11
        )
        .getValues();

    for (const row of data) {

      if (

        String(row[0])
          .trim()
          .toLowerCase()

        ===

        companyName
          .trim()
          .toLowerCase()
      ) {

        return {

          revenueBand: {

            band: row[5],

            confidence: row[6],

            evidence: row[7],
          },
          manufacturerFlag: row[3],
          acquiredFlag: row[4],
          revenueSource: row[8],
          status: row[9],
          failReason: row[10],
        };
      }
    }

    return null;

  } catch (err) {

    Logger.log(
      `[getStage1Status ERROR] ${err.message}`
    );

    return null;
  }
}



// ============================================================
// SECTION 11 — TEST FUNCTION
// ============================================================

function testSheetManager() {

  Logger.log(
    `=== testSheetManager START ===`
  );

  try {

    setupSheets();

    const companies =
      getCompanies();

    Logger.log(
      `[Companies Loaded] ${companies.length}`
    );

    saveCheckpoint(0);

    Logger.log(
      `[Checkpoint Test] ${getCheckpoint()}`
    );

    Logger.log(
      `=== testSheetManager SUCCESS ===`
    );

  } catch (err) {

    Logger.log(
      `[testSheetManager ERROR] ${err.message}`
    );
  }
}

