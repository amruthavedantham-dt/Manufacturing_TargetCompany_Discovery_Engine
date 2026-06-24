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
