// ============================================================
// test_revenue_v2.gs
// Isolated revenue classification tester
// MASTER_TEST: Company | Website | Source | Direct_Snippet | Signals_Snippet
// RT_V2_RESULTS: output sheet
// All extraction functions self-contained — does not touch revenue.gs
// ============================================================

const RT_MASTER     = "MASTER_TEST";
const RT_RESULTS    = "RT_V2_RESULTS";
const RT_CHECKPOINT = "RT_V2_CHECKPOINT";
const RT_BATCH_SIZE = 10;

// ============================================================
// FUNCTION 1 — createTestSheets
// ============================================================
function createTestSheets() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();

  let master = ss.getSheetByName(RT_MASTER);
  if (!master) {
    master = ss.insertSheet(RT_MASTER);
    Logger.log("[createTestSheets] MASTER_TEST created");
  }
  const masterHeaders = ["Company", "Website", "Source", "Direct_Snippet", "Signals_Snippet"];
  const firstCell = master.getRange(1, 1).getValue();
  if (!firstCell) {
    master.getRange(1, 1, 1, masterHeaders.length).setValues([masterHeaders]);
    master.getRange(1, 1, 1, masterHeaders.length).setFontWeight("bold");
    master.setColumnWidth(1, 220);
    master.setColumnWidth(2, 200);
    master.setColumnWidth(3, 120);
    master.setColumnWidth(4, 400);
    master.setColumnWidth(5, 400);
    Logger.log("[createTestSheets] MASTER_TEST headers added");
  } else {
    Logger.log("[createTestSheets] MASTER_TEST already exists — left untouched");
  }

  let results = ss.getSheetByName(RT_RESULTS);
  if (!results) {
    results = ss.insertSheet(RT_RESULTS);
    Logger.log("[createTestSheets] RT_V2_RESULTS created");
  }
  results.clearContents();
  const resultHeaders = ["Company", "Band", "Confidence", "Signal", "Source", "Method"];
  results.getRange(1, 1, 1, resultHeaders.length).setValues([resultHeaders]);
  results.getRange(1, 1, 1, resultHeaders.length).setFontWeight("bold");
  results.setColumnWidth(1, 220);
  results.setColumnWidth(2, 120);
  results.setColumnWidth(3, 100);
  results.setColumnWidth(4, 350);
  results.setColumnWidth(5, 150);
  results.setColumnWidth(6, 100);

  PropertiesService.getScriptProperties().deleteProperty(RT_CHECKPOINT);
  Logger.log("[createTestSheets] ✓ Done. Add companies to MASTER_TEST then run runRevenueTest()");
}

// ============================================================
// FUNCTION 2 — resetTestCheckpoint
// ============================================================
function resetTestCheckpoint() {
  PropertiesService.getScriptProperties().deleteProperty(RT_CHECKPOINT);
  Logger.log("[resetTestCheckpoint] Checkpoint cleared — next run starts from row 1");
}

// ============================================================
// FUNCTION 3 — runRevenueTest
// ============================================================
function runRevenueTest() {
  const START = new Date();
  Logger.log("=== runRevenueTest START ===");

  const ss      = SpreadsheetApp.getActiveSpreadsheet();
  const master  = ss.getSheetByName(RT_MASTER);
  const results = ss.getSheetByName(RT_RESULTS);

  if (!master || !results) {
    Logger.log("[ERROR] Sheets missing — run createTestSheets() first");
    return;
  }

  const companies = rt_loadCompanies(master);
  if (!companies.length) {
    Logger.log("[runRevenueTest] No companies in MASTER_TEST");
    return;
  }

  const props      = PropertiesService.getScriptProperties();
  const cpRaw      = props.getProperty(RT_CHECKPOINT);
  const startIndex = cpRaw ? parseInt(cpRaw) : 0;

  if (startIndex > 0) {
    Logger.log(`[Checkpoint] Resuming from index ${startIndex} — ${companies[startIndex]?.company || "end"}`);
  }

  const done = rt_getCompletedCompanies(results);
  Logger.log(`[Already done] ${done.size} companies already in results sheet`);

  let geminiQueue    = [];
  let directCount    = 0;
  let heuristicCount = 0;
  let queuedCount    = 0;
  let skippedCount   = 0;

  for (let i = startIndex; i < companies.length; i++) {

    if ((new Date() - START) / 1000 > 270) {
      if (geminiQueue.length) {
        rt_flushGeminiQueue(geminiQueue, results);
        queuedCount += geminiQueue.length;
        geminiQueue = [];
      }
      props.setProperty(RT_CHECKPOINT, String(i));
      Logger.log(`[Checkpoint SAVED] Stopped at index ${i} — re-run to continue`);
      return;
    }

    const obj     = companies[i];
    const company = obj.company;

    if (done.has(company.trim().toLowerCase())) {
      Logger.log(`[SKIP] Already done: ${company}`);
      skippedCount++;
      continue;
    }

    Logger.log(`\n[${i + 1}/${companies.length}] ${company}`);

    const evidence = rt_buildEvidence(obj);

    if (!evidence.trim()) {
      Logger.log(`[WARN] No evidence for: ${company} — writing Unknown`);
      rt_writeRow(results, {
        company,
        band:       "Unknown",
        confidence: "Low",
        signal:     "No snippets available",
        source:     "None",
        method:     "no-evidence"
      });
      props.setProperty(RT_CHECKPOINT, String(i + 1));
      continue;
    }

    if (!obj.directSnippet.trim() && obj.signalsSnippet.trim()) {
      Logger.log(`[INFO] Direct snippet empty for ${company} — using signals snippet only`);
    }

    // Layer 1: Direct regex
    const direct = rt_extractDirectRevenue(evidence);
    if (direct) {
      Logger.log(`[L1 Direct] ${company} → ${direct.band} | ${direct.evidence}`);
      rt_writeRow(results, {
        company,
        band:       direct.band,
        confidence: direct.confidence,
        signal:     direct.evidence,
        source:     "Direct-regex",
        method:     "direct"
      });
      directCount++;
      props.setProperty(RT_CHECKPOINT, String(i + 1));
      continue;
    }

    // Layer 2: Employee heuristic
    const heuristic = rt_employeeHeuristic(evidence);
    if (heuristic) {
      Logger.log(`[L2 Heuristic] ${company} → ${heuristic.band} | ${heuristic.evidence}`);
      rt_writeRow(results, {
        company,
        band:       heuristic.band,
        confidence: heuristic.confidence,
        signal:     heuristic.evidence,
        source:     "Employee-heuristic",
        method:     "heuristic"
      });
      heuristicCount++;
      props.setProperty(RT_CHECKPOINT, String(i + 1));
      continue;
    }

    // Layer 3: Queue for Gemini
    Logger.log(`[L3 Gemini Queue] ${company}`);
    geminiQueue.push({
      company,
      directSnippet:  obj.directSnippet  || "",
      signalsSnippet: obj.signalsSnippet || ""
    });

    if (geminiQueue.length >= RT_BATCH_SIZE) {
      const flushed = rt_flushGeminiQueue(geminiQueue, results);
      queuedCount += flushed;
      geminiQueue = [];
    }

    props.setProperty(RT_CHECKPOINT, String(i + 1));
  }

  if (geminiQueue.length) {
    const flushed = rt_flushGeminiQueue(geminiQueue, results);
    queuedCount += flushed;
  }

  props.deleteProperty(RT_CHECKPOINT);
  SpreadsheetApp.flush();

  Logger.log(`\n=== runRevenueTest COMPLETE ===`);
  Logger.log(`Direct regex  : ${directCount}`);
  Logger.log(`Heuristic     : ${heuristicCount}`);
  Logger.log(`Gemini batch  : ${queuedCount}`);
  Logger.log(`Skipped       : ${skippedCount}`);
  Logger.log(`Total         : ${directCount + heuristicCount + queuedCount}`);
}

// ============================================================
// LAYER 1 — rt_extractDirectRevenue
// Self-contained — does not call revenue.gs
// ============================================================
function rt_extractDirectRevenue(evidenceText) {
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
      band:       rt_getBand(mid),
      confidence: straddlesBoundary ? "Medium" : "High",
      evidence:   `Range: ${low}-${high} Cr, midpoint ${mid.toFixed(1)} Cr`,
    };
  }

  // ── Single value patterns ─────────────────────────────────
  const singlePatterns = [
    /operating revenue[:\s]+(?:rs\.?|₹|inr)?\s*([\d,]+(?:\.\d+)?)\s*(?:cr|crore)/i,
    /(?:total revenue|net revenue|revenue from operations)[^\d]{0,20}([\d,]+(?:\.\d+)?)\s*(?:cr|crore)/i,
    /(?:revenue|turnover|sales)[^\d]{0,40}(?:rs\.?|₹|inr)?\s*([\d,]+(?:\.\d+)?)\s*(?:cr|crore|crs)/i,
    /(?:revenue|turnover)[^\d]{0,30}([\d,]+(?:\.\d+)?)\s*(?:lakh|lac)/i,
    // "turnover of average Rs. 1000 Crores" style
    /turnover[^\d]{0,20}(?:rs\.?|₹|inr)?\s*([\d,]+(?:\.\d+)?)\s*(?:cr|crore)/i,
    // "Group Companies Turnover. Rs. 300 Crore"
    /turnover[.\s]+(?:rs\.?|₹)?\s*([\d,]+(?:\.\d+)?)\s*(?:cr|crore)/i,
  ];

  for (let p = 0; p < singlePatterns.length; p++) {
    const match = evidenceText.match(singlePatterns[p]);
    if (!match) continue;
    let val = parseFloat(match[1].replace(/,/g, ""));
    if (isNaN(val)) continue;
    // lakh pattern: convert to crore
    if (p === 3) val = val / 100;
    return {
      band:       rt_getBand(val),
      confidence: "High",
      evidence:   `Direct figure: ${val} Cr`,
    };
  }

  // ── MSME raw number — "Turnover: 11484850" ────────────────
  const msmeMatch = evidenceText.match(/turnover[:\s]+(\d{5,})\b(?!\s*(?:cr|crore|lakh|\.))/i);
  if (msmeMatch) {
    const raw = parseFloat(msmeMatch[1]);
    if (!isNaN(raw)) {
      const cr = raw > 10000 ? raw / 10000000 : raw;
      return {
        band:       rt_getBand(cr),
        confidence: "Medium",
        evidence:   `MSME figure: ${cr.toFixed(2)} Cr`,
      };
    }
  }

  // ── USD/EUR conversion ────────────────────────────────────
  const usdMatch = evidenceText.match(/(?<!<)\$\s*([\d.]+)\s*([MB])\b/i);
  if (usdMatch) {
    let usdVal = parseFloat(usdMatch[1]);
    if (usdMatch[2].toUpperCase() === "B") usdVal *= 1000;
    // 1M USD = 95,00,000 INR = 9.5 Cr
    const cr = usdVal * 9.5;
    if (!isNaN(cr)) {
      return {
        band:       rt_getBand(cr),
        confidence: "Medium",
        evidence:   `USD converted: $${usdMatch[1]}${usdMatch[2]} = ~${cr.toFixed(1)} Cr`,
      };
    }
  }

  return null;
}

// ============================================================
// LAYER 2 — rt_employeeHeuristic
// Self-contained — does not call revenue.gs
// ============================================================
function rt_employeeHeuristic(evidenceText) {
  if (!evidenceText) return null;

  const patterns = [
    // "Employees. 90." — website style
    { regex: /\bemployees[\s.:,]+(\d+)\b/i,                   type: "count" },
    // "has 11-50 employees"
    { regex: /has\s+(\d+)\s*[-–]\s*(\d+)\s*employees/i,      type: "range" },
    // "201-500 employees"
    { regex: /\b(\d+)\s*[-–]\s*(\d+)\s*employees/i,          type: "range" },
    // "company size: 51-200"
    { regex: /company size[:\s]+(\d+)\s*[-–]\s*(\d+)/i,      type: "range" },
    // "total employees 51-200"
    { regex: /total employees\s*(\d+)\s*[-–]\s*(\d+)/i,      type: "range" },
    // "total employees 200"
    { regex: /total employees\s*(\d+)/i,                      type: "count" },
    // "275 employees" or "275+ employees"
    { regex: /\b(\d[\d,]*)\s*\+?\s*employees/i,               type: "count" },
    // "workforce of 200" / "staff of 50"
    { regex: /(?:workforce|staff)[:\s]+(\d+)/i,               type: "count" },
    // "No. of Employees Below 100"
    { regex: /no\.?\s*of\s*employees\s*(?:below|under)\s*(\d+)/i, type: "below" },
    // "Number Of Employees: 26 to 50 People"
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

  Logger.log(`[rt_employeeHeuristic] count=${count}`);

  if (count < 50) {
    return {
      band:       "<50Cr",
      confidence: "Medium",
      evidence:   `Employee count ${Math.round(count)} — below threshold for 50Cr`,
    };
  }

  if (count >= 200) {
    return {
      band:       "50-500Cr",
      confidence: "Medium",
      evidence:   `Employee count ${Math.round(count)} — consistent with 50-500Cr`,
    };
  }

  // 50-199: genuinely ambiguous — send to Gemini
  Logger.log(`[rt_employeeHeuristic] count ${count} in ambiguous range 50-199 — queuing for Gemini`);
  return null;
}

// ============================================================
// HELPER — rt_getBand
// ============================================================
function rt_getBand(cr) {
  if      (cr < 50)              return "<50Cr";
  else if (cr >= 50 && cr <= 500) return "50-500Cr";
  else if (cr > 500 && cr <= 1500) return "500-1500Cr";
  else                            return ">1500Cr";
}

// ============================================================
// FUNCTION 4 — rt_flushGeminiQueue
// Sends one batch of up to 10 companies to Gemini
// ============================================================
function rt_flushGeminiQueue(queue, resultsSheet) {
  Logger.log(`\n[Gemini Batch START] ${queue.length} companies`);

  const companiesBlock = queue.map((obj, idx) => {
    const evidence = ((obj.directSnippet || "") + " " + (obj.signalsSnippet || ""))
      .substring(0, 600)
      .trim();
    return `${idx + 1}. Company: ${obj.company}\nEvidence: ${evidence || "No evidence available"}`;
  }).join("\n\n");

  const prompt = CONFIG.PROMPTS.REVENUE_BATCH.replace("{companies_block}", companiesBlock);
  Logger.log(`[Gemini Batch] Prompt length: ${prompt.length} chars`);
  Logger.log(`[Gemini Batch] Companies block preview:\n${companiesBlock.substring(0, 400)}`);

  // ── Call Gemini ────────────────────────────────────────────
  let raw = null;
  try {
    raw = callGeminiNoThinkWithRetry(prompt);
  } catch (err) {
    Logger.log(`[Gemini Batch ERROR] callGeminiNoThinkWithRetry threw: ${err.message}`);
  }

  if (!raw) {
    Logger.log(`[Gemini Batch ERROR] Null response — writing Unknown for all ${queue.length}`);
    queue.forEach(obj => rt_writeRow(resultsSheet, {
      company: obj.company, band: "Unknown", confidence: "Low",
      signal: "Gemini returned null", source: "None", method: "gemini-failed"
    }));
    return queue.length;
  }

  Logger.log(`[Gemini Batch] Raw length: ${raw.length}`);
  Logger.log(`[Gemini Batch] Raw preview: ${raw.substring(0, 400)}`);

  // ── Parse JSON ─────────────────────────────────────────────
  let parsed = null;
  try {
    parsed = parseGeminiJSON(raw);
  } catch (err) {
    Logger.log(`[Gemini Batch ERROR] parseGeminiJSON threw: ${err.message}`);
  }

  if (!parsed) {
    Logger.log(`[Gemini Batch ERROR] parseGeminiJSON returned null`);
    Logger.log(`[Gemini Batch ERROR] Full raw: ${raw}`);
    queue.forEach(obj => rt_writeRow(resultsSheet, {
      company: obj.company, band: "Unknown", confidence: "Low",
      signal: "JSON parse failed — check logs", source: "None", method: "gemini-parse-failed"
    }));
    return queue.length;
  }

  // ── Recover if Gemini wrapped array in object ─────────────
  if (!Array.isArray(parsed)) {
    Logger.log(`[Gemini Batch ERROR] Not an array — type: ${typeof parsed}`);
    Logger.log(`[Gemini Batch ERROR] Value: ${JSON.stringify(parsed).substring(0, 300)}`);
    const recovered = parsed.results || parsed.companies || parsed.data || null;
    if (Array.isArray(recovered)) {
      Logger.log(`[Gemini Batch] Recovered wrapped array — ${recovered.length} items`);
      parsed = recovered;
    } else {
      queue.forEach(obj => rt_writeRow(resultsSheet, {
        company: obj.company, band: "Unknown", confidence: "Low",
        signal: "Response not array — check logs", source: "None", method: "gemini-format-error"
      }));
      return queue.length;
    }
  }

  Logger.log(`[Gemini Batch] Parsed ${parsed.length} results for ${queue.length} companies`);

  // ── Validate and write each result ────────────────────────
  const allowedBands = ["<50Cr", "50-500Cr", "500-1500Cr", ">1500Cr", "Unknown"];
  const allowedConf  = ["High", "Medium", "Low"];

  queue.forEach((obj, idx) => {
    const result = parsed[idx];

    if (!result) {
      Logger.log(`[Gemini Batch WARN] No result at index ${idx} for: ${obj.company}`);
      rt_writeRow(resultsSheet, {
        company: obj.company, band: "Unknown", confidence: "Low",
        signal: `Missing at index ${idx}`, source: "None", method: "gemini-missing"
      });
      return;
    }

    const band       = allowedBands.includes(result.band)       ? result.band       : "Unknown";
    let finalMethod = "gemini";
    if (band === "Unknown") {
      // Check employee count in evidence to decide FAIL vs MANUAL_REVIEW
      const evidenceForCheck = ((obj.directSnippet || "") + " " + (obj.signalsSnippet || "")).toLowerCase();
      const tinyMatch = evidenceForCheck.match(/\b([1-9]|10)\s*\+?\s*employees/i) ||
                        evidenceForCheck.match(/company size[:\s]+1\s*[-–]\s*10/i) ||
                        evidenceForCheck.match(/has\s+[1-9]\s*[-–]\s*10\s*employees/i) ||
                        evidenceForCheck.match(/employs\s+[1-9]\s*employees/i);
      finalMethod = tinyMatch ? "gemini-unknown-fail" : "gemini-unknown-review";
    }
    const confidence = allowedConf.includes(result.confidence)  ? result.confidence : "Low";

    if (!allowedBands.includes(result.band)) {
      Logger.log(`[Gemini Batch WARN] Invalid band "${result.band}" for ${obj.company} → Unknown`);
    }

    Logger.log(`[Gemini Result] ${obj.company} → ${band} (${confidence}) | ${result.signal || ""}`);

    rt_writeRow(resultsSheet, {
      company:    obj.company,
      band:       band,
      confidence: confidence,
      signal:     String(result.signal || "").substring(0, 150),
      source:     String(result.source || "Gemini"),
      method:     finalMethod    
    });
  });

  SpreadsheetApp.flush();
  Logger.log(`[Gemini Batch DONE] ${queue.length} written`);
  return queue.length;
}

// ============================================================
// INTERNAL HELPERS
// ============================================================

function rt_loadCompanies(sheet) {
  const lastRow = sheet.getLastRow();
  if (lastRow < 2) return [];
  const data      = sheet.getRange(2, 1, lastRow - 1, 5).getValues();
  const companies = [];
  data.forEach((row, idx) => {
    const company = String(row[0] || "").trim();
    if (!company || company.toLowerCase() === "company") return;
    companies.push({
      company:        company,
      website:        String(row[1] || "").trim(),
      source:         String(row[2] || "").trim(),
      directSnippet:  String(row[3] || "").trim(),
      signalsSnippet: String(row[4] || "").trim(),
      rowIndex:       idx + 2,
    });
  });
  Logger.log(`[rt_loadCompanies] ${companies.length} companies loaded`);
  return companies;
}

function rt_buildEvidence(obj) {
  return ((obj.directSnippet || "") + " " + (obj.signalsSnippet || ""))
    .substring(0, 1500)
    .trim();
}

function rt_getCompletedCompanies(sheet) {
  const done = new Set();
  if (sheet.getLastRow() < 2) return done;
  const data = sheet.getRange(2, 1, sheet.getLastRow() - 1, 1).getValues();
  data.forEach(row => {
    const name = String(row[0] || "").trim().toLowerCase();
    if (name) done.add(name);
  });
  return done;
}

function rt_writeRow(sheet, obj) {
  sheet.appendRow([
    obj.company    || "",
    obj.band       || "Unknown",
    obj.confidence || "Low",
    obj.signal     || "",
    obj.source     || "",
    obj.method     || "",
  ]);
}