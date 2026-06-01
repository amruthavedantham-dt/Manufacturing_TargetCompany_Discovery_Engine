// ============================================================
// main.gs
// ICP PIPELINE ORCHESTRATOR
// Flow: runInitialPipeline → resolvePendingRevenue → runFinalScoringPipeline
// ============================================================

// ============================================================
// SECTION 1 — GLOBALS
// ============================================================
var START_TIME = null;

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
// Gate 1: Manufacturer check
// Gate 2: PE/Acquired check
// Gate 3: Revenue — direct regex → heuristic → PENDING for Gemini
// ============================================================
function runStage1(companyObj) {
  const company = cleanCompanyName(companyObj.company);
  Logger.log(`[Stage1 START] ${company}`);

  // ── Gate 1: Manufacturer ──────────────────────────────────
  const mfgSnippets = callSerper(company, "STAGE1_MFG");
  Utilities.sleep(CONFIG.BATCH.SERPER_SLEEP);
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

  if (!manufacturerHit || (!manufacturerHit && traderHit) || croHit) {
    let failReason = "No manufacturing signal found";
    if (!manufacturerHit && traderHit) failReason = `Trader/distributor detected: ${traderHit}`;
    if (croHit)    failReason = `CRO/service detected: ${croHit}`;
    Logger.log(`[Gate1 FAIL] ${company} — ${failReason}`);
    return {
      manufacturer: false,
      acquired:     false,
      revenueBand:  { band: "-", confidence: "-", evidence: "-" },
      status:       "FAIL",
      failReason:   failReason,
    };
  }
  Logger.log(`[Gate1 PASS] ${company} — keyword: ${manufacturerHit}`);

  // ── Gate 2: PE / Acquired ─────────────────────────────────
  const bizSnippets = callSerper(company, "STAGE1_BIZ");
  Utilities.sleep(CONFIG.BATCH.SERPER_SLEEP);
  const bizText = String(bizSnippets || "").toLowerCase();

  const peHit = CONFIG.STAGE1.PE_ACQUIRED.find(kw =>
    bizText.includes(kw.toLowerCase())
  );

  if (peHit) {
    Logger.log(`[Gate2 FAIL] ${company} — PE/acquired: ${peHit}`);
    return {
      manufacturer: true,
      acquired:     true,
      revenueBand:  { band: "-", confidence: "-", evidence: "-" },
      status:       "FAIL",
      failReason:   `PE/acquired detected: ${peHit}`,
    };
  }
  Logger.log(`[Gate2 PASS] ${company}`);

  // ── Gate 3: Revenue ───────────────────────────────────────

  // Step 3a — try direct regex on MFG snippets (free, already fetched)
  let revenueBand = extractDirectRevenue(mfgText);
  if (revenueBand) {
    Logger.log(`[Gate3 3a MFG] ${company} → ${revenueBand.band}`);
    return rt_buildStage1Result(true, false, revenueBand, company);
  }

  // Step 3b — dedicated Tofler/Zauba/Screener search
  const directSnippets = callSerper(company, "REVENUE_DIRECT");
  Utilities.sleep(CONFIG.BATCH.SERPER_SLEEP);
  const directText = String(directSnippets || "");

  revenueBand = extractDirectRevenue(directText);
  if (revenueBand) {
    Logger.log(`[Gate3 3b REVENUE_DIRECT] ${company} → ${revenueBand.band}`);
    return rt_buildStage1Result(true, false, revenueBand, company);
  }

  // Step 3c — signals search
  const signalSnippets = callSerper(company, "REVENUE_SIGNALS");
  Utilities.sleep(CONFIG.BATCH.SERPER_SLEEP);
  const signalText = String(signalSnippets || "").trim();

  // Try direct regex on signals too
  if (signalText.length > 50) {
    revenueBand = extractDirectRevenue(signalText);
    if (revenueBand) {
      Logger.log(`[Gate3 3c REVENUE_SIGNALS direct] ${company} → ${revenueBand.band}`);
      return rt_buildStage1Result(true, false, revenueBand, company);
    }
  }

  // Try employee heuristic on combined evidence
  const combinedEvidence = (directText + " " + signalText).trim();
  if (combinedEvidence.length > 50) {
    const heuristic = employeeHeuristic(combinedEvidence);
    if (heuristic) {
      Logger.log(`[Gate3 3c Heuristic] ${company} → ${heuristic.band}`);
      return rt_buildStage1Result(true, false, heuristic, company);
    }
  }

  // Step 3d — evidence exists but needs Gemini — defer to batch
  if (combinedEvidence.length > 50) {
    Logger.log(`[Gate3 PENDING GEMINI] ${company}`);
    return {
      manufacturer: true,
      acquired:     false,
      revenueBand:  {
        band:       "PENDING_REVENUE",
        confidence: "Low",
        evidence:   "Awaiting Gemini batch"
      },
      status:     "PENDING_REVENUE",
      failReason: "",
    };
  }

  // Step 3e — no evidence at all → FAIL
  Logger.log(`[Gate3 3e No evidence] ${company}`);
  return {
    manufacturer: true,
    acquired:     false,
    revenueBand:  {
      band:       "Unknown",
      confidence: "Low",
      evidence:   "No revenue evidence found"
    },
    status:     "FAIL",
    failReason: "No revenue evidence found",
  };
}

// Helper — builds Stage1 result and applies pass/fail logic
function rt_buildStage1Result(manufacturer, acquired, revenueBand, company) {
  const allowedBands = CONFIG.PIPELINE.STAGE1_PASS_BANDS;
  const passed = allowedBands.includes(revenueBand.band);

  if (!passed) {
    Logger.log(`[Gate3 FAIL] ${company} → ${revenueBand.band}`);
  } else {
    Logger.log(`[Gate3 PASS] ${company} → ${revenueBand.band}`);
  }

  return {
    manufacturer: manufacturer,
    acquired:     acquired,
    revenueBand:  revenueBand,
    status:       passed ? "PASS" : "FAIL",
    failReason:   passed ? "" : `Revenue band rejected: ${revenueBand.band}`,
  };
}

// ============================================================
// SECTION 5 — PROCESS ONE COMPANY
// ============================================================
function processCompanyStage1(companyObj) {
  try {
    const result = runStage1(companyObj);
    writeStage1Result(companyObj, result);
    Logger.log(`[Stage1 ${result.status}] ${companyObj.company}`);
    return {
      success:      true,
      company:      companyObj.company,
      stage1Status: result.status,
    };
  } catch (err) {
    Logger.log(`[processCompanyStage1 ERROR] ${companyObj.company} | ${err.message}`);
    flagForReview(companyObj, err.message);
    return {
      success:      false,
      company:      companyObj.company,
      stage1Status: "ERROR",
    };
  }
}

// ============================================================
// SECTION 6 — INITIAL PIPELINE
// Runs Stage 1 gates for all companies
// Saves PENDING_REVENUE for Gemini batch in Section 7
// Run first. Then run resolvePendingRevenue().
// ============================================================
// ============================================================
// SECTION 6 — INITIAL PIPELINE
// Runs Stage 1 for all companies
// Gemini batch resolution happens inline — no separate step needed
// Run this first. Then run runFinalScoringPipeline.
// ============================================================
function runInitialPipeline() {
  START_TIME = new Date();
  Logger.log(`=== runInitialPipeline START ===`);

  try {
    const companies = getCompanies();
    if (!companies.length) {
      Logger.log(`[runInitialPipeline] No companies found`);
      return;
    }

    const checkpoint = getCheckpoint();
    Logger.log(`[Checkpoint] Starting from index ${checkpoint} of ${companies.length} total`);

    let processed = 0;
    let skipped   = 0;
    let failed    = 0;
    let pending   = []; // companies needing Gemini batch

    for (let i = checkpoint; i < companies.length; i++) {

      // ── Time limit: flush Gemini queue then pause ─────────
      if (isNearTimeLimit()) {
        if (pending.length) {
          Logger.log(`[Time limit] Flushing ${pending.length} pending before pause`);
          resolveGeminiBatch(pending);
          pending = [];
        }
        saveCheckpoint(i);
        Logger.log(`[runInitialPipeline PAUSED] Checkpoint saved at ${i} — re-run to continue`);
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
        resolveGeminiBatch(pending);
        processed += pending.length;
        pending = [];
      }

      saveCheckpoint(i + 1);
    }

    // ── Flush any remaining pending (less than 10) ────────
    if (pending.length) {
      Logger.log(`[Gemini Flush] Final batch of ${pending.length} companies`);
      resolveGeminiBatch(pending);
      processed += pending.length;
    }

    saveCheckpoint(0); // reset for next full run
    Logger.log(`=== runInitialPipeline COMPLETE ===`);
    Logger.log(`[Processed] ${processed}`);
    Logger.log(`[Skipped]   ${skipped}`);
    Logger.log(`[Failed]    ${failed}`);

  } catch (err) {
    Logger.log(`[runInitialPipeline FATAL] ${err.message}`);
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
  const sheet = ss.getSheetByName(CONFIG.SHEETS.STAGE1);
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

    const band = result.band || CONFIG.REVENUE.BANDS.UNKNOWN;

    let finalStatus = "FAIL";
    let finalReason = `Revenue band rejected: ${band}`;

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
      finalStatus = "PASS";
      finalReason = "";
    }

    Logger.log(`[resolveGeminiBatch] ${item.company} → ${band} → ${finalStatus}`);

    updateStage1Revenue(sheet, item.rowNum, {
      band:       band,
      confidence: result.confidence || CONFIG.REVENUE.CONFIDENCE.LOW,
      evidence:   result.signal     || result.evidence || "Gemini batch",
    }, finalStatus, finalReason);
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
  START_TIME = new Date();
  Logger.log(`=== runFinalScoringPipeline START ===`);

  try {
    const companies  = getCompanies();
    const checkpoint = getCheckpoint();
    Logger.log(`[Scoring Checkpoint] Resuming from index ${checkpoint}`);

    let processed = 0;
    let skipped   = 0;

    for (let i = checkpoint; i < companies.length; i++) {

      if (isNearTimeLimit()) {
        saveCheckpoint(i);
        Logger.log(`[runFinalScoringPipeline PAUSED] Checkpoint saved at ${i}`);
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
        saveCheckpoint(i + 1);
        Logger.log(`[${i + 1}/${companies.length}] SKIPPED — stage1 not PASS: ${companyObj.company} (${stage1?.status || "not found"})`);
        continue;
      }

      Logger.log(`[Scoring ${i + 1}/${companies.length}] ${companyObj.company}`);

      try {
        const c3 = runC3(companyObj);
        const c4 = runC4(companyObj);
        const c5 = runC5(companyObj);
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

        processed++;
      } catch (err) {
        Logger.log(`[runFinalScoringPipeline ERROR] ${companyObj.company} | ${err.message}`);
      }

      saveCheckpoint(i + 1);
    }

    Logger.log(`=== runFinalScoringPipeline COMPLETE | processed: ${processed}, skipped: ${skipped} ===`);
    // Auto-build shortlist after scoring completes
    Logger.log(`[runFinalScoringPipeline] Building shortlist...`);
    buildShortlist();

  } catch (err) {
    Logger.log(`[runFinalScoringPipeline FATAL] ${err.message}`);
  }
}

// ============================================================
// SECTION 9 — FINAL SCORING TEST (first 20 PASSed companies)
// ============================================================
function runFinalScoringPipelineTest() {
  START_TIME = new Date();
  Logger.log(`=== runFinalScoringPipelineTest START ===`);

  try {
    const companies = getCompanies();
    let tested      = 0;

    for (const companyObj of companies) {
      if (tested >= 20) break;

      const stage1 = getStage1Status(companyObj.company);
      if (!stage1 || stage1.status !== "PASS") continue;

      Logger.log(`[TEST SCORING] ${companyObj.company}`);

      try {
        const c3 = runC3(companyObj);
        const c4 = runC4(companyObj);
        const c5 = runC5(companyObj);
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
  PropertiesService.getScriptProperties().deleteProperty("PENDING_REVENUE_CHECKPOINT");
  Logger.log(`[resetAndRunFresh] All checkpoints cleared`);
}


function updateStage1Revenue(sheet, rowNum, revenueBand, status, failReason) {
  try {
    sheet.getRange(rowNum, 6).setValue(revenueBand.band       || "Unknown");
    sheet.getRange(rowNum, 7).setValue(revenueBand.confidence || "Low");
    sheet.getRange(rowNum, 8).setValue(revenueBand.evidence   || "");
    sheet.getRange(rowNum, 9).setValue(status                 || "FAIL");
    sheet.getRange(rowNum, 10).setValue(failReason            || "");
  } catch (err) {
    Logger.log(`[updateStage1Revenue ERROR] row ${rowNum} | ${err.message}`);
  }
}


function checkState() {
  Logger.log(`Checkpoint: ${getCheckpoint()}`);
  Logger.log(`Companies: ${getCompanies().length}`);
}


// change if necessary
function setCheckpointTo500() {
  saveCheckpoint(500);
  Logger.log(`Checkpoint set to 500`);
}