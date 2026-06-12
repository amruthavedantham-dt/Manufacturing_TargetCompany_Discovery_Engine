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

    data.forEach(row => {
      const company = String(row[0] || '').trim();
      const status  = String(row[9] || '').trim();
      if (!company || status !== 'PENDING_REVENUE') return;

      const cleanName = cleanCompanyName(company);
      leftover.push({
        companyObj:     { company, website: String(row[1] || ''), source: String(row[2] || '') },
        company:        cleanName,
        directSnippet:  getCachedSearch(cleanName, 'REVENUE_DIRECT')  || '',
        signalsSnippet: getCachedSearch(cleanName, 'REVENUE_SIGNALS') || '',
        rowNum:         null,
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

  // Attach row numbers
  pendingQueue.forEach(item => {
    item.rowNum = nameToRow[item.company.trim().toLowerCase()] || null;
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

        const c5QueryPriority = ["STAGE1_MFG", "C3", "STAGE1_BIZ"];
        let c5Snippets = null;
        for (const qt of c5QueryPriority) {
          c5Snippets = getCachedSearch(companyObj.company, qt);
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

        const c5QueryPriority = ["STAGE1_MFG", "C3", "STAGE1_BIZ"];
        let c5Snippets = null;
        for (const qt of c5QueryPriority) {
          c5Snippets = getCachedSearch(companyObj.company, qt);
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
      'NO', 'NO', 'PENDING_REVENUE', 'Low', 'Awaiting Gemini batch',
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
      'YES', 'NO', '50-500Cr', 'High', 'Revenue found',
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