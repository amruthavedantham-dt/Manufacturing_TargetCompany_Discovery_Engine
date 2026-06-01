// ============================================================
// test_revenue_v2.gs  —  STANDALONE revenue tester
// No dependency on main pipeline (no CONFIG, no shared cache)
// Reads from MASTER_TEST → writes to REVENUE_TEST_RESULTS
// ============================================================

// ─────────────────────────────────────────────────────────────
// PASTE YOUR KEYS HERE
// ─────────────────────────────────────────────────────────────
const RT_SERPER_KEY   = CONFIG.KEYS.SERPER;
const RT_SERPER_SLEEP = 1200;   // ms between Serper calls
const RT_TIME_LIMIT   = 300;    // seconds before checkpoint saves & stops

// ─────────────────────────────────────────────────────────────
// SHEET NAMES  (change if yours differ)
// ─────────────────────────────────────────────────────────────
const MASTER_SHEET    = "MASTER_TEST";
const RESULTS_SHEET   = "REVENUE_TEST_RESULTS";
const PROMPT_SHEET    = "DEEPSEEK_PROMPT";
const CHECKPOINT_KEY  = "RT_CHECKPOINT";   // PropertiesService key

// ============================================================
// FUNCTION 1 — createRevenueSheets()
// Run this ONCE manually to set up all required sheets
// ============================================================
function createRevenueSheets() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();

  // ── MASTER_TEST ───────────────────────────────────────────
  let master = ss.getSheetByName(MASTER_SHEET);
  if (!master) {
    master = ss.insertSheet(MASTER_SHEET);
    master.getRange(1, 1, 1, 3).setValues([["Company_Name", "Website", "Source"]]);
    master.getRange(1, 1, 1, 3).setFontWeight("bold");
    master.setColumnWidth(1, 220);
    master.setColumnWidth(2, 280);
    master.setColumnWidth(3, 160);
    Logger.log("[createRevenueSheets] MASTER_TEST created — add your companies here");
  } else {
    Logger.log("[createRevenueSheets] MASTER_TEST already exists — left untouched");
  }

  // ── REVENUE_TEST_RESULTS ──────────────────────────────────
  let results = ss.getSheetByName(RESULTS_SHEET);
  if (results) {
    results.clearContents();
    Logger.log("[createRevenueSheets] REVENUE_TEST_RESULTS cleared and reset");
  } else {
    results = ss.insertSheet(RESULTS_SHEET);
    Logger.log("[createRevenueSheets] REVENUE_TEST_RESULTS created");
  }

  const headers = [
    "Company",
    "Direct_Snippet",
    "Signals_Snippet",
    "Direct_Band_Found",    // <50Cr | 50-500Cr | 500-1500Cr | >1500Cr | -
    "Direct_Evidence",
    "Snippet_Quality_Score",
    "Quality_Notes",
    "Recommended_Action",
    // ── filled after DeepSeek paste ──
    "AI_Band",
    "AI_Confidence",
    "AI_Source_Reliability",
    "AI_Deciding_Signal",
    "AI_Supporting_Signals",
  ];

  results.getRange(1, 1, 1, headers.length).setValues([headers]);
  results.getRange(1, 1, 1, headers.length).setFontWeight("bold");

  const widths = [220, 400, 400, 130, 220, 100, 300, 180, 130, 100, 180, 250, 300];
  widths.forEach((w, i) => results.setColumnWidth(i + 1, w));

  // ── DEEPSEEK_PROMPT ───────────────────────────────────────
  let prompt = ss.getSheetByName(PROMPT_SHEET);
  if (!prompt) {
    prompt = ss.insertSheet(PROMPT_SHEET);
    Logger.log("[createRevenueSheets] DEEPSEEK_PROMPT sheet created");
  }
  prompt.clearContents();
  prompt.getRange(1, 1).setValue("Prompt will appear in A1 after running buildDeepSeekPrompt20()");
  prompt.getRange(1, 2).setValue("Paste DeepSeek JSON output here (B1)");
  prompt.getRange(1, 1, 1, 2).setFontWeight("bold");
  prompt.setColumnWidth(1, 800);
  prompt.setColumnWidth(2, 800);

  // Clear any saved checkpoint
  PropertiesService.getScriptProperties().deleteProperty(CHECKPOINT_KEY);

  Logger.log("[createRevenueSheets] ✓ All sheets ready. Add companies to MASTER_TEST, then run runRevenueTest()");
}


// ============================================================
// FUNCTION 2 — runRevenueTest()
// Runs Serper queries for all companies in MASTER_TEST.
// Automatically resumes from checkpoint if time ran out.
// ============================================================
function runRevenueTest() {
  const START = new Date();
  Logger.log("=== runRevenueTest START ===");

  const ss      = SpreadsheetApp.getActiveSpreadsheet();
  const results = ss.getSheetByName(RESULTS_SHEET);

  if (!results) {
    Logger.log("[ERROR] REVENUE_TEST_RESULTS sheet not found — run createRevenueSheets() first");
    return;
  }

  // ── Load all companies ─────────────────────────────────────
  const companies = rt_getMasterCompanies();
  if (!companies.length) {
    Logger.log("[runRevenueTest] No companies found in MASTER_TEST");
    return;
  }

  // ── Checkpoint: find where to resume ──────────────────────
  const props          = PropertiesService.getScriptProperties();
  const checkpointRaw  = props.getProperty(CHECKPOINT_KEY);
  const startIndex     = checkpointRaw ? parseInt(checkpointRaw) : 0;

  if (startIndex > 0) {
    Logger.log(`[Checkpoint] Resuming from company index ${startIndex} (${companies[startIndex]?.company || "end"})`);
  }

  // ── Figure out which rows already exist in results sheet ──
  // We write one row per company in order; rows 2..N map to companies[0..N-1]
  // If resuming, rows 1..startIndex already exist — we append from startIndex onward

  let processedCount = 0;
  let directFound    = 0;
  let goodSignals    = 0;
  let queryFailed    = 0;

  for (let i = startIndex; i < companies.length; i++) {
    // ── Time-limit check ──────────────────────────────────
    const elapsed = (new Date() - START) / 1000;
    if (elapsed > RT_TIME_LIMIT) {
      props.setProperty(CHECKPOINT_KEY, String(i));
      Logger.log(`[Checkpoint SAVED] Stopped at index ${i} (${companies[i].company}) after ${elapsed.toFixed(0)}s`);
      Logger.log(`Re-run runRevenueTest() to continue from here`);
      break;
    }

    const companyObj = companies[i];
    const company    = rt_cleanName(companyObj.company);

    Logger.log(`\n[${i + 1}/${companies.length}] ${company}`);
    processedCount++;

    // ── QUERY 1 — Direct revenue (Tofler / Zauba / Screener) ─
    const directQuery =
      `"${company}" (site:tofler.in OR site:zaubacorp.com OR site:screener.in OR site:moneycontrol.com) ` +
      `("revenue" OR "turnover" OR "operating revenue") ("2024" OR "2025" OR "FY24" OR "FY25")`;

    const directSnippet = rt_serperSearch(directQuery, company, "DIRECT");
    Utilities.sleep(RT_SERPER_SLEEP);

    // Try extracting a direct figure
    const directResult = rt_extractRevenue(directSnippet);
    if (directResult) {
      directFound++;
      Logger.log(`[Direct Found] ${company} → ${directResult.band} (${directResult.value} Cr)`);
    }

    // ── QUERY 2 — Signals (only if direct failed) ─────────
    let signalsSnippet = "";
    if (!directResult) {
      const signalsQuery =
        `"${company}" ("annual revenue" OR "turnover" OR "crore" OR "employees" OR "workforce" OR ` +
        `"export turnover" OR "production capacity" OR "manufacturing capacity" OR "installed capacity") ` +
        `-site:justdial.com -site:indiamart.com -site:tradeindia.com ` +
        `-site:facebook.com -site:instagram.com -site:sulekha.com -site:exportersindia.com`;

      signalsSnippet = rt_serperSearch(signalsQuery, company, "SIGNALS");
      Utilities.sleep(RT_SERPER_SLEEP);
    }

    // ── Quality score ─────────────────────────────────────
    const quality = rt_scoreQuality(company, directSnippet, signalsSnippet);

    if (quality.action === "SEND_TO_AI" || quality.action === "SEND_TO_AI_LOW_CONF") goodSignals++;
    if (quality.action === "QUERY_FAILED") queryFailed++;

    Logger.log(`[Quality] score=${quality.score} | action=${quality.action}`);
    Logger.log(`[Notes] ${quality.notes}`);

    // ── Write row ─────────────────────────────────────────
    // Direct_Band_Found: real band if found, else "-" (means → DeepSeek)
    const bandCell    = directResult ? directResult.band : "-";
    const evidenceCell = directResult ? directResult.evidence : "-";

    // Find the correct output row
    // Row 1 = headers; company index i → row i+2
    const outputRow = i + 2;

    results.getRange(outputRow, 1, 1, 8).setValues([[
      companyObj.company,
      (directSnippet  || "").substring(0, 800),
      (signalsSnippet || "").substring(0, 800),
      bandCell,
      evidenceCell,
      quality.score,
      quality.notes,
      quality.action,
    ]]);

    // Flush every 5 rows to avoid data loss on timeout
    if (processedCount % 5 === 0) {
      SpreadsheetApp.flush();
    }
  }

  // ── If we got through all companies, clear checkpoint ────
  if (startIndex + processedCount >= companies.length) {
    props.deleteProperty(CHECKPOINT_KEY);
    Logger.log("[Checkpoint CLEARED] All companies processed");
  }

  SpreadsheetApp.flush();

  Logger.log(`\n=== runRevenueTest DONE ===`);
  Logger.log(`This run processed : ${processedCount}`);
  Logger.log(`Direct revenue found: ${directFound}`);
  Logger.log(`Good signals for AI : ${goodSignals}`);
  Logger.log(`Query failed (noise): ${queryFailed}`);
}

// ============================================================
// FUNCTION 3 — buildDeepSeekPrompt20()
// ============================================================
function buildDeepSeekPrompt20() {
  const ss      = SpreadsheetApp.getActiveSpreadsheet();
  const results = ss.getSheetByName(RESULTS_SHEET);

  if (!results || results.getLastRow() < 2) {
    Logger.log("[buildDeepSeekPrompt20] No results yet — run runRevenueTest() first");
    return;
  }

  const lastRow        = results.getLastRow();
  const lastCol        = results.getLastColumn();
  const dataRowCount   = lastRow - 1;

  // Read cols 1-8 (always present after runRevenueTest)
  const data = results.getRange(2, 1, dataRowCount, 8).getValues();

  // Read col 9 (AI_Band) only if it exists — pad to same length regardless
  let aiDoneRows = [];
  if (lastCol >= 9) {
    const raw = results.getRange(2, 9, dataRowCount, 1).getValues();
    aiDoneRows = raw.map(r => String(r[0] || "").trim());
  } else {
    aiDoneRows = new Array(dataRowCount).fill("");
  }

  const pending = [];
  data.forEach((row, idx) => {
    const band    = String(row[3] || "").trim();
    const action  = String(row[7] || "").trim();
    const aiDone  = aiDoneRows[idx] ?? "";          // always a string now
    const needsAI = band === "-" && action.startsWith("SEND_TO_AI") && aiDone === "";
    if (needsAI) pending.push({ row, sheetRow: idx + 2 });
  });

  if (!pending.length) {
    Logger.log("[buildDeepSeekPrompt20] No companies pending AI classification");
    return;
  }

  const batch = pending.slice(0, 20);
  Logger.log(`[buildDeepSeekPrompt20] Building prompt for ${batch.length} companies (${pending.length} total pending)`);

  // ── System prompt ─────────────────────────────────────────
  const systemPrompt =
`You are classifying Indian manufacturers by annual revenue band.
Bands: <50Cr, 50-500Cr, 500-1500Cr, >1500Cr, Unknown

STRICT RULES:
- Use ONLY the snippet text provided as evidence
- Never infer, assume, or fabricate revenue not stated in evidence
- If a direct turnover or revenue figure exists → confidence = "High"
- If only employee count or export signals exist → confidence = "Medium"
- If only directory listings or LinkedIn → band = "Unknown", confidence = "Low"
- Treat ICRA/CRISIL data as highest reliability
- Treat ZoomInfo/RocketReach employee ranges as medium reliability
- Treat JustDial/IndiaMart/directory snippets as low reliability

Return ONLY a JSON array. Start with [ end with ]
No markdown. No explanation outside the array. No preamble.

Output format:
[
  {
    "company_name": "",
    "band": "<50Cr | 50-500Cr | 500-1500Cr | >1500Cr | Unknown",
    "confidence": "High | Medium | Low",
    "source_reliability": "ICRA/CRISIL | MCA/Tofler/Zauba | ZoomInfo/RocketReach | Directory | Unknown",
    "deciding_signal": "exact phrase from snippet that determined the band",
    "supporting_signals": ["phrase 1", "phrase 2"],
    "what_would_change_classification": "specific evidence that would move to different band",
    "band_boundary_risk": "High | Low"
  }
]

Companies to classify:
`;

  let entries = "";
  batch.forEach(({ row }, idx) => {
    const company    = String(row[0] || "").trim();
    const directSnip = String(row[1] || "").trim();
    const signalsSnip = String(row[2] || "").trim();
    const evidence   = (directSnip + " " + signalsSnip).substring(0, 1200);
    entries += `\n${idx + 1}. Company: ${company}\nEvidence: ${evidence}\n`;
  });

  const fullPrompt = systemPrompt + entries;

  const promptSheet = ss.getSheetByName(PROMPT_SHEET) || ss.insertSheet(PROMPT_SHEET);
  promptSheet.clearContents();
  promptSheet.getRange(1, 1).setValue(fullPrompt);
  promptSheet.getRange(1, 1).setWrap(true);
  promptSheet.setColumnWidth(1, 800);
  promptSheet.getRange(1, 2).setValue("← Paste DeepSeek JSON output HERE (in this cell B1)");
  promptSheet.getRange(1, 2).setFontWeight("bold");
  promptSheet.setColumnWidth(2, 800);

  const batchMeta = batch.map(b => b.sheetRow).join(",");
  PropertiesService.getScriptProperties().setProperty("RT_BATCH_ROWS", batchMeta);

  SpreadsheetApp.flush();

  Logger.log(`[buildDeepSeekPrompt20] Prompt written to ${PROMPT_SHEET} A1`);
  Logger.log(`Batch covers result sheet rows: ${batchMeta}`);
  Logger.log(`${pending.length - batch.length} companies remain after this batch`);
  Logger.log(`Copy A1 → paste into DeepSeek → paste response into B1 → run writeDeepSeekResults()`);
}


// ============================================================
// FUNCTION 4 — writeDeepSeekResults()
// ============================================================
function writeDeepSeekResults() {
  const ss           = SpreadsheetApp.getActiveSpreadsheet();
  const promptSheet  = ss.getSheetByName(PROMPT_SHEET);
  const resultsSheet = ss.getSheetByName(RESULTS_SHEET);

  if (!promptSheet || !resultsSheet) {
    Logger.log("[writeDeepSeekResults ERROR] Required sheets not found");
    return;
  }

  const rawJson = promptSheet.getRange(1, 2).getValue();
  if (!rawJson || String(rawJson).trim().length < 5) {
    Logger.log("[writeDeepSeekResults] B1 is empty — paste DeepSeek output into DEEPSEEK_PROMPT B1 first");
    return;
  }

  let parsed;
  try {
    const clean = String(rawJson).replace(/```json|```/g, "").trim();
    parsed = JSON.parse(clean);
  } catch (err) {
    Logger.log(`[writeDeepSeekResults ERROR] JSON parse failed: ${err.message}`);
    Logger.log("Make sure B1 contains a valid JSON array from DeepSeek");
    return;
  }

  if (!Array.isArray(parsed) || !parsed.length) {
    Logger.log("[writeDeepSeekResults ERROR] Parsed result is not an array or is empty");
    return;
  }

  const props     = PropertiesService.getScriptProperties();
  const batchMeta = props.getProperty("RT_BATCH_ROWS");
  let batchRows   = batchMeta ? batchMeta.split(",").map(Number) : [];

  const useFallback = batchRows.length === 0;
  if (useFallback) {
    Logger.log("[writeDeepSeekResults] No batch metadata — matching by company name");
    const allData  = resultsSheet.getRange(2, 1, resultsSheet.getLastRow() - 1, 1).getValues();
    const nameToRow = {};
    allData.forEach((r, idx) => {
      nameToRow[String(r[0] || "").trim().toLowerCase()] = idx + 2;
    });

    parsed.forEach(item => {
      const key = String(item.company_name || "").trim().toLowerCase();
      const row = nameToRow[key];
      if (!row) {
        Logger.log(`[writeDeepSeekResults] No row found for: ${item.company_name}`);
        return;
      }
      rt_writeAIRow(resultsSheet, row, item);
    });
  } else {
    parsed.forEach((item, idx) => {
      const row = batchRows[idx];
      if (!row) {
        Logger.log(`[writeDeepSeekResults] No batch row for index ${idx}`);
        return;
      }
      rt_writeAIRow(resultsSheet, row, item);
    });
  }

  SpreadsheetApp.flush();

  // Only clear batch metadata after a successful write
  props.deleteProperty("RT_BATCH_ROWS");

  Logger.log(`[writeDeepSeekResults] ✓ ${parsed.length} companies updated in ${RESULTS_SHEET}`);
  Logger.log(`Run buildDeepSeekPrompt20() again to process the next batch if any remain`);
}




// Helper — writes one AI result row into REVENUE_TEST_RESULTS
function rt_writeAIRow(sheet, rowNum, item) {
  const band        = String(item.band                            || "Unknown").trim();
  const confidence  = String(item.confidence                      || "").trim();
  const reliability = String(item.source_reliability              || "").trim();
  const deciding    = String(item.deciding_signal                 || "").trim();
  const supporting  = (item.supporting_signals || []).join(" | ");
  const changeTip   = String(item.what_would_change_classification || "").trim();

  // Col 4 (Direct_Band_Found): overwrite "-" with AI band
  sheet.getRange(rowNum, 4).setValue(band);

  // Col 5 (Direct_Evidence): note it came from AI
  const existingEvidence = String(sheet.getRange(rowNum, 5).getValue() || "");
  if (existingEvidence === "-" || existingEvidence === "") {
    sheet.getRange(rowNum, 5).setValue(`AI: ${confidence} | ${deciding}`);
  }

  // Cols 9-13: AI detail columns
  sheet.getRange(rowNum, 9, 1, 5).setValues([[
    band,
    confidence,
    reliability,
    deciding,
    supporting,
  ]]);

  Logger.log(`  Row ${rowNum}: ${item.company_name} → ${band} (${confidence}) | ${deciding}`);
}


// ============================================================
// INTERNAL HELPERS
// ============================================================

// Clean company name for search query (remove Pvt Ltd noise etc.)
function rt_cleanName(name) {
  return String(name || "")
    .replace(/\s+(pvt\.?\s*ltd\.?|private\s+limited|limited|ltd\.?)\s*$/i, "")
    .replace(/['"]/g, "")
    .trim();
}

// Read MASTER_TEST companies
function rt_getMasterCompanies() {
  try {
    const ss    = SpreadsheetApp.getActiveSpreadsheet();
    const sheet = ss.getSheetByName(MASTER_SHEET);
    if (!sheet) throw new Error(`${MASTER_SHEET} sheet not found`);

    const lastRow = sheet.getLastRow();
    if (lastRow < 2) return [];

    const data      = sheet.getRange(2, 1, lastRow - 1, 3).getValues();
    const companies = [];

    data.forEach((row, idx) => {
      const company = String(row[0] || "").trim();
      if (!company || company.toLowerCase() === "company_name") return;
      companies.push({
        company:  company,
        website:  String(row[1] || "").trim(),
        source:   String(row[2] || "").trim(),
        rowIndex: idx + 2,
      });
    });

    Logger.log(`[rt_getMasterCompanies] ${companies.length} companies loaded`);
    return companies;
  } catch (err) {
    Logger.log(`[rt_getMasterCompanies ERROR] ${err.message}`);
    return [];
  }
}

// Call Serper and return joined snippet text
function rt_serperSearch(queryString, companyName, queryType) {
  const options = {
    method:  "post",
    headers: {
      "X-API-KEY":    RT_SERPER_KEY,
      "Content-Type": "application/json",
    },
    payload:            JSON.stringify({ q: queryString, num: 8 }),
    muteHttpExceptions: true,
  };

  try {
    const response = UrlFetchApp.fetch("https://google.serper.dev/search", options);
    const code     = response.getResponseCode();

    if (code !== 200) {
      Logger.log(`[rt_serperSearch] HTTP ${code} for "${companyName}" (${queryType})`);
      return "";
    }

    const data    = JSON.parse(response.getContentText());
    const snippet = rt_buildSnippet(data);

    Logger.log(`[rt_serperSearch] ${snippet.length} chars — "${companyName}" (${queryType})`);
    return snippet;
  } catch (e) {
    Logger.log(`[rt_serperSearch ERROR] "${companyName}" (${queryType}): ${e.message}`);
    return "";
  }
}

// Build a single text blob from Serper organic results
function rt_buildSnippet(data) {
  const parts = [];

  // Knowledge graph
  if (data.knowledgeGraph) {
    const kg = data.knowledgeGraph;
    if (kg.title)       parts.push(kg.title);
    if (kg.description) parts.push(kg.description);
    if (kg.attributes) {
      Object.entries(kg.attributes).forEach(([k, v]) => parts.push(`${k}: ${v}`));
    }
  }

  // Organic results
  (data.organic || []).forEach(r => {
    if (r.title)   parts.push(r.title);
    if (r.snippet) parts.push(r.snippet);
    if (r.link)    parts.push(r.link);
    if (r.sitelinks) {
      (r.sitelinks || []).forEach(sl => {
        if (sl.title)   parts.push(sl.title);
        if (sl.snippet) parts.push(sl.snippet);
      });
    }
  });

  // Answer box
  if (data.answerBox) {
    const ab = data.answerBox;
    if (ab.answer)  parts.push(ab.answer);
    if (ab.snippet) parts.push(ab.snippet);
  }

  return parts.join(" | ").substring(0, 2000);
}

// Regex-based direct revenue extraction
function rt_extractRevenue(snippetText) {
  if (!snippetText || snippetText.trim().length < 10) return null;

  const toflerPattern  = /operating revenue[:\s]+(?:rs\.?|₹|inr)?\s*([\d,]+(?:\.\d+)?)\s*(?:cr|crore)/i;
  const zaubaPattern   = /(?:total revenue|net revenue|revenue from operations)[^\d]{0,20}([\d,]+(?:\.\d+)?)\s*(?:cr|crore)/i;
  const generalPattern = /(?:revenue|turnover|sales)[^\d]{0,40}(?:rs\.?|₹|inr)?\s*([\d,]+(?:\.\d+)?)\s*(?:cr|crore|crs)/i;
  const lakhPattern    = /(?:revenue|turnover)[^\d]{0,30}([\d,]+(?:\.\d+)?)\s*(?:lakh|lac)/i;

  const patterns = [toflerPattern, zaubaPattern, generalPattern, lakhPattern];

  for (const pattern of patterns) {
    const match = snippetText.match(pattern);
    if (!match) continue;

    let revenueCr = parseFloat(match[1].replace(/,/g, ""));
    if (isNaN(revenueCr)) continue;

    if (pattern === lakhPattern) revenueCr = revenueCr / 100;

    let band;
    if      (revenueCr < 50)                           band = "<50Cr";
    else if (revenueCr >= 50  && revenueCr <= 500)     band = "50-500Cr";
    else if (revenueCr >  500 && revenueCr <= 1500)    band = "500-1500Cr";
    else                                               band = ">1500Cr";

    return {
      band:     band,
      evidence: `Direct figure: ${revenueCr} Cr`,
      value:    revenueCr,
    };
  }

  return null;
}

// Snippet quality scorer — returns { score, notes, action }
function rt_scoreQuality(company, directSnippet, signalsSnippet) {
  const combined = (directSnippet + " " + signalsSnippet).toLowerCase();
  const notes    = [];
  let score      = 0;

  // ── Positive signals ───────────────────────────────────────
  if (combined.includes("tofler.in"))    { score += 4; notes.push("Tofler found"); }
  if (combined.includes("zaubacorp"))    { score += 4; notes.push("Zauba found"); }
  if (combined.includes("screener.in"))  { score += 4; notes.push("Screener found"); }
  if (combined.includes("moneycontrol")) { score += 3; notes.push("MoneyControl found"); }
  if (combined.includes("bse") || combined.includes("nse")) { score += 3; notes.push("BSE/NSE listed"); }
  if (combined.includes("bloomberg"))   { score += 3; notes.push("Bloomberg profile"); }

  const empMatch = combined.match(/(\d+)\s*(?:\+)?\s*employees/);
  if (empMatch) {
    const count = parseInt(empMatch[1]);
    if      (count >= 500) { score += 4; notes.push(`${count} employees (large)`); }
    else if (count >= 100) { score += 3; notes.push(`${count} employees (medium)`); }
    else if (count >= 20)  { score += 1; notes.push(`${count} employees (small)`); }
  }

  if (combined.match(/(?:crore|cr)\s*(?:revenue|turnover)/i) ||
      combined.match(/(?:revenue|turnover)[^\d]{0,20}(?:crore|cr)/i)) {
    score += 3; notes.push("Revenue in crore mentioned");
  }

  if (combined.includes("export"))                       { score += 2; notes.push("Exports mentioned"); }
  if (combined.match(/exports?\s+to\s+\d+/i) || combined.match(/\d+\s+countries/i)) {
    score += 2; notes.push("Export scale");
  }
  if (combined.match(/\d+\s+(?:manufacturing\s+)?(?:plants?|units?|facilities)/i)) {
    score += 2; notes.push("Multiple plants");
  }
  if (combined.includes("production capacity") || combined.includes("installed capacity")) {
    score += 1; notes.push("Capacity mentioned");
  }
  if (combined.includes("linkedin.com"))  { score += 2; notes.push("LinkedIn present"); }
  if (combined.includes("annual report") || combined.includes("investor")) {
    score += 3; notes.push("Annual report/investor");
  }

  // ── Negative signals ───────────────────────────────────────
  const dirs = ["justdial","indiamart","tradeindia","sulekha","exportersindia","alibaba"]
    .filter(d => combined.includes(d)).length;
  if      (dirs >= 3) { score -= 3; notes.push("Only directories"); }
  else if (dirs >= 1) { score -= 1; notes.push("Some directories"); }

  const social = ["instagram.com","facebook.com","twitter.com"]
    .filter(s => combined.includes(s)).length;
  if (social >= 2) { score -= 3; notes.push("Social media noise"); }

  const companyLower = company.toLowerCase();
  if (combined.split(companyLower).length < 3) { score -= 2; notes.push("Query noise risk"); }

  // ── Action ─────────────────────────────────────────────────
  let action;
  if      (score >= 6) action = "SEND_TO_AI";
  else if (score >= 3) action = "SEND_TO_AI_LOW_CONF";
  else if (score >= 1) action = "MANUAL_REVIEW";
  else                 action = "QUERY_FAILED";

  return {
    score:  score,
    notes:  notes.join("; ") || "No signals",
    action: action,
  };
}