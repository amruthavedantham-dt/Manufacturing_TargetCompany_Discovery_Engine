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
