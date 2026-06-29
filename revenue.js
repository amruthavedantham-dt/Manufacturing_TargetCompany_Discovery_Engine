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