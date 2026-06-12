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
