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
