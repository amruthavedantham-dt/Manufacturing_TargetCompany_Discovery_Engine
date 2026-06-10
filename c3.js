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
  const raw    = callGeminiWithRetry(prompt);

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