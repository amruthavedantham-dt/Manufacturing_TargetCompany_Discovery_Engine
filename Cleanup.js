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
