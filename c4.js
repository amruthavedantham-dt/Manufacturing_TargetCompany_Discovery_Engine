// ============================================================
// c4.gs — C4 Technical Decision-Maker Scoring
// Flow: Serper(company) → extract DM name → Serper(name+bg) → Gemini assess
// 2 Serper calls + 1 Gemini call per company
// Depends on: config.gs, ai.gs, sheetManager.gs
// ============================================================

// ============================================================
// SECTION 1 — MASTER FUNCTION
// ============================================================
/* 01-06-26
function runC4(companyObj) {
  const company = companyObj.company;
  Logger.log(`\nC4: starting for "${company}"`);

  // ── Serper call 1: find who leads the company ─────────────
  const nameSnippets = callSerper(company, "C4");

  if (!nameSnippets || nameSnippets.trim().length < 50) {
    Logger.log(`C4: no name evidence for "${company}" — scoring 0`);
    return {
      c4: 0, c4DmName: "Unknown",
      c4Background: "No search evidence found",
      c4Confidence: "Low", manualReview: false,
    };
  }

  // ── Extract DM name deterministically from snippets ───────
  // No Gemini used here — just pull the first recognisable person name
  const dmName = c4_extractNameFromSnippets(nameSnippets, company);
  Logger.log(`C4: extracted DM name = "${dmName}"`);

  // ── Serper call 2: fetch background for that person ───────
  let combinedSnippets = nameSnippets;

  if (dmName !== "Unknown") {
    const bgSnippets = c4_searchPersonBackground(dmName, company);
    if (bgSnippets && bgSnippets.trim().length > 50) {
      // Combine both sets of evidence for Gemini
      combinedSnippets = nameSnippets + "\n\n---\n\n" + bgSnippets;
      Logger.log(`C4: background snippets found for "${dmName}"`);
    } else {
      Logger.log(`C4: no background snippets for "${dmName}" — using name snippets only`);
    }
  }

  // ── Deterministic signal check on combined evidence ───────
  const combinedLower = combinedSnippets.toLowerCase();
  const strongHit   = CONFIG.C4.STRONG_SIGNALS.find(kw => combinedLower.includes(kw.toLowerCase()));
  const moderateHit = CONFIG.C4.MODERATE_SIGNALS.find(kw => combinedLower.includes(kw.toLowerCase()));

  // ── Single Gemini call — depth assessment only ────────────
  const prompt  = buildPrompt("C4", company, combinedSnippets);
  const raw     = callGeminiWithRetry(prompt);

  if (!raw) {
    Logger.log(`C4: Gemini null for "${company}"`);
    return c4_deterministicFallback(company, dmName, strongHit, moderateHit, true);
  }

  const parsed = parseGeminiJSON(raw);
  if (!parsed) {
    Logger.log(`C4: parse fail for "${company}"`);
    return c4_deterministicFallback(company, dmName, strongHit, moderateHit, true);
  }

  let depth = String(parsed.depth || "None").trim();

  // ── Deterministic override — always wins over Gemini ──────
  if (strongHit && depth !== "Strong") {
    depth = "Strong";
    Logger.log(`C4: deterministic override → Strong (keyword: "${strongHit}")`);
  } else if (moderateHit && depth === "None") {
    depth = "Moderate";
    Logger.log(`C4: deterministic bump → Moderate (keyword: "${moderateHit}")`);
  }

  const c4Score      = CONFIG.C4.SCORE_MAP[depth] ?? 0;
  const c4Background = buildC4Background(parsed, depth, strongHit, moderateHit);
  const c4Confidence = getC4Confidence(depth, parsed, strongHit);

  Logger.log(`C4: "${company}" → depth=${depth}, score=${c4Score}, name=${dmName}`);
  return { c4: c4Score, c4DmName: dmName, c4Background, c4Confidence, manualReview: false };
}
*/

// ============================================================
// MASTER FUNCTION
// Flow: Serper(company) → Gemini(name) → Serper(background)
//       → Gemini(depth classification)
// 2 Serper calls + 2 Gemini calls per company
// ============================================================

function runC4(companyObj) {
  const company = companyObj.company;
  Logger.log(`\nC4: starting for "${company}"`);

  // ── Serper call 1: identify who leads the company ─────────
  const nameSnippets = callSerper(company, "C4");

  if (!nameSnippets || nameSnippets.trim().length < 50) {
    Logger.log(`C4: no name evidence for "${company}" — scoring 0`);
    return {
      c4: 0, c4DmName: "Unknown",
      c4Background: "No search evidence found",
      c4Confidence: "Low", manualReview: false,
    };
  }

  // ── Gemini call 1: lightweight name extraction only ───────
  const namePrompt = buildPrompt("C4_NAME", company, nameSnippets);
  const nameRaw    = callGeminiWithRetry(namePrompt);

  let dmName = "Unknown";

  if (nameRaw) {
    const nameParsed = parseGeminiJSON(nameRaw);
    if (nameParsed) {
      dmName = String(nameParsed.name || "Unknown").trim();
    }
  }
  Logger.log(`C4: extracted DM name = "${dmName}"`);

  // ── Serper call 2: targeted background search ─────────────
  let bgSnippets = "";

  if (dmName !== "Unknown") {
    bgSnippets = c4_searchPersonBackground(dmName, company);
    if (bgSnippets && bgSnippets.trim().length > 50) {
      Logger.log(`C4: background snippets found (${bgSnippets.length} chars)`);
    } else {
      Logger.log(`C4: no background snippets for "${dmName}"`);
      bgSnippets = "";
    }
  }

  // ── Deterministic check on background snippets ────────────
  // If strong keyword found, skip second Gemini call entirely
  if (bgSnippets) {
    const bgLower    = bgSnippets.toLowerCase();
    const strongHit  = CONFIG.C4.STRONG_SIGNALS.find(kw => bgLower.includes(kw.toLowerCase()));
    const modHit     = CONFIG.C4.MODERATE_SIGNALS.find(kw => bgLower.includes(kw.toLowerCase()));

    if (strongHit) {
      Logger.log(`C4: deterministic Strong (keyword: "${strongHit}") — skipping Gemini call 2`);
      return {
        c4:           CONFIG.C4.SCORE_MAP["Strong"],
        c4DmName:     dmName,
        c4Background: `Strong | keyword: "${strongHit}"`,
        c4Confidence: "High",
        manualReview: false,
      };
    }
  }

  // ── Gemini call 2: depth classification ───────────────────
  // Feed background snippets if available, else fall back to name snippets
  const evidenceForDepth = bgSnippets.trim().length > 50
    ? bgSnippets
    : nameSnippets;

  const depthPrompt = buildPrompt("C4_DEPTH", company, evidenceForDepth);
  const depthRaw    = callGeminiWithRetry(depthPrompt);

  if (!depthRaw) {
    Logger.log(`C4: Gemini call 2 null for "${company}"`);
    // Fall back to deterministic on whatever evidence we have
    const allLower   = (nameSnippets + " " + bgSnippets).toLowerCase();
    const strongHit  = CONFIG.C4.STRONG_SIGNALS.find(kw => allLower.includes(kw.toLowerCase()));
    const moderateHit = CONFIG.C4.MODERATE_SIGNALS.find(kw => allLower.includes(kw.toLowerCase()));
    return c4_deterministicFallback(company, dmName, strongHit, moderateHit, true);
  }

  const depthParsed = parseGeminiJSON(depthRaw);
  if (!depthParsed) {
    Logger.log(`C4: parse fail for "${company}"`);
    return c4_deterministicFallback(company, dmName, null, null, true);
  }

  let depth = String(depthParsed.depth || "None").trim();

  // ── Deterministic override on all evidence ────────────────
  const allLower    = (nameSnippets + " " + bgSnippets).toLowerCase();
  const strongHit   = CONFIG.C4.STRONG_SIGNALS.find(kw => allLower.includes(kw.toLowerCase()));
  const moderateHit = CONFIG.C4.MODERATE_SIGNALS.find(kw => allLower.includes(kw.toLowerCase()));

  if (strongHit && depth !== "Strong") {
    depth = "Strong";
    Logger.log(`C4: deterministic override → Strong (keyword: "${strongHit}")`);
  } else if (moderateHit && depth === "None") {
    depth = "Moderate";
    Logger.log(`C4: deterministic bump → Moderate (keyword: "${moderateHit}")`);
  }

  const c4Score      = CONFIG.C4.SCORE_MAP[depth] ?? 0;
  const c4Background = buildC4Background(depthParsed, depth, strongHit, moderateHit);
  const c4Confidence = getC4Confidence(depth, depthParsed, strongHit);

  Logger.log(`C4: "${company}" → depth=${depth}, score=${c4Score}, name=${dmName}`);
  return { c4: c4Score, c4DmName: dmName, c4Background, c4Confidence, manualReview: false };
}

// ============================================================
// SECTION 2 — NAME EXTRACTOR (no Gemini)
// Scans Tofler/Zauba/LinkedIn snippets for a person name.
// Strategy: look for title patterns like "MD:", "Founder:" etc.
// Falls back to "Unknown" if nothing found.
// ============================================================

function c4_extractNameFromSnippets(snippets, company) {
  // Patterns: "MD: Rajesh Kumar", "Founder - Amit Shah", "Director · Priya Nair"
  const titlePatterns = [
    /(?:managing director|md|founder|promoter|chairman|ceo|proprietor|partner|director)\s*[:\-·|]\s*([A-Z][a-z]+(?:\s[A-Z][a-z]+){1,3})/gi,
    /([A-Z][a-z]+(?:\s[A-Z][a-z]+){1,3})\s*[,·|]\s*(?:managing director|md|founder|promoter|chairman|ceo|proprietor|director)/gi,
  ];

  for (const pattern of titlePatterns) {
    const match = pattern.exec(snippets);
    if (match) {
      const name = (match[1] || match[2] || "").trim();
      // Sanity check: name shouldn't be the company name or a generic word
      if (name.length > 3 && !name.toLowerCase().includes(company.toLowerCase().split(" ")[0])) {
        return name;
      }
    }
  }
  return "Unknown";
}

// ============================================================
// SECTION 3 — BACKGROUND SEARCH
// Uses CONFIG.QUERIES.C4_BACKGROUND template
// ============================================================

function c4_searchPersonBackground(personName, companyName) {
  const cacheKey = `${companyName}__C4_BG`;

  const cached = getCachedSearch(companyName, "C4_BG");
  if (cached) return cached;

  // Use the centralised query template — supports {person} and {company}
  const query = CONFIG.QUERIES.C4_BACKGROUND
    .replace(/\{person\}/g,  personName)
    .replace(/\{company\}/g, companyName);

  const options = {
    method: "post",
    headers: { "X-API-KEY": CONFIG.KEYS.SERPER, "Content-Type": "application/json" },
    payload: JSON.stringify({ q: query, num: 6 }),
    muteHttpExceptions: true,
  };

  try {
    const response = UrlFetchApp.fetch("https://google.serper.dev/search", options);
    if (response.getResponseCode() !== 200) return "";
    const data     = JSON.parse(response.getContentText());
    const snippets = buildSnippetText(data);
    saveToCache(companyName, "C4_BG", query, snippets);
    Utilities.sleep(CONFIG.BATCH.SERPER_SLEEP);
    return snippets;
  } catch(e) {
    Logger.log(`c4_searchPersonBackground ERROR: ${e.message}`);
    return "";
  }
}

// ============================================================
// SECTION 4 — DETERMINISTIC FALLBACK (when Gemini fails)
// ============================================================

function c4_deterministicFallback(company, dmName, strongHit, moderateHit, manualReview) {
  if (strongHit) return {
    c4: 20, c4DmName: dmName,
    c4Background: `Deterministic override: "${strongHit}" found in snippets`,
    c4Confidence: "Medium", manualReview,
  };
  if (moderateHit) return {
    c4: 10, c4DmName: dmName,
    c4Background: `Deterministic override: "${moderateHit}" found in snippets`,
    c4Confidence: "Low", manualReview,
  };
  return {
    c4: 0, c4DmName: dmName,
    c4Background: "Gemini call failed — manual review needed",
    c4Confidence: "Low", manualReview,
  };
}

// ============================================================
// SECTION 5 — BACKGROUND STRING BUILDER
// ============================================================

function buildC4Background(parsed, finalDepth, strongHit, moderateHit) {
  const parts = [];
  parts.push(finalDepth);

  const bg = String(parsed.bg || "").trim();
  if (bg && bg.toLowerCase() !== "unknown") {
    parts.push(bg.substring(0, 80));
  }

  if (strongHit)       parts.push(`keyword: "${strongHit}"`);
  else if (moderateHit) parts.push(`keyword: "${moderateHit}"`);

  const reason = String(parsed.x || "").trim();
  if (reason) parts.push(reason.substring(0, 60));

  return parts.join(" | ").substring(0, 200);
}

// ============================================================
// SECTION 6 — CONFIDENCE LEVEL
// ============================================================

function getC4Confidence(depth, parsed, strongHit) {
  if (depth === "Strong" && strongHit) return "High";
  if (depth === "Strong")              return "Medium";
  if (depth === "Moderate")            return "Medium";
  return "Low";
}

// ============================================================
// TEST — C4 Name Extraction (no checkpoint, no scoring)
// Run this standalone to verify DM name detection
// ============================================================

function testC4NameExtraction() {
  Logger.log("=== testC4NameExtraction START ===");

  const ss    = SpreadsheetApp.getActiveSpreadsheet();
  const sheet = ss.getSheetByName(CONFIG.SHEETS.STAGE1);
  if (!sheet) { Logger.log("STAGE1 sheet not found"); return; }

  const data = sheet.getRange(2, 1, sheet.getLastRow() - 1, 9).getValues();
  const companies = data
    .filter(row => String(row[8]).trim() === "PASS")
    .slice(0, 5)
    .map(row => ({ company: String(row[0]).trim() }));

  if (!companies.length) { Logger.log("No PASS companies found"); return; }

  companies.forEach((companyObj, i) => {
    const company = companyObj.company;
    Logger.log(`\n--- [${i+1}/5] ${company} ---`);

    // ── Step 1: Serper call 1 ─────────────────────────────
    const nameSnippets = callSerper(company, "C4");
    Logger.log(`Serper C4: ${nameSnippets?.length || 0} chars`);
    Logger.log(`Name snippets full:\n${nameSnippets || "EMPTY"}`);

    if (!nameSnippets || nameSnippets.trim().length < 50) {
      Logger.log(`RESULT: No snippets — skipping`);
      return;
    }

    // ── Step 2: Gemini call 1 — name only ─────────────────
    const namePrompt = buildPrompt("C4_NAME", company, nameSnippets);
    const nameRaw    = callGeminiWithRetry(namePrompt);

    if (!nameRaw) {
      Logger.log(`Gemini call 1: null response`);
      return;
    }

    const nameParsed = parseGeminiJSON(nameRaw);
    if (!nameParsed) {
      Logger.log(`Gemini call 1: parse failed — raw: ${nameRaw.substring(0, 200)}`);
      return;
    }

    const dmName = String(nameParsed.name || "Unknown").trim();
    Logger.log(`Gemini call 1 → name="${dmName}"`);

    if (dmName === "Unknown") {
      Logger.log(`Name not found — check name snippets above for clues`);
      return;
    }

    // ── Step 3: Serper call 2 — background ────────────────
    const bgSnippets = c4_searchPersonBackground(dmName, company);
    Logger.log(`Serper background: ${bgSnippets?.length || 0} chars`);
    Logger.log(`Background snippets full:\n${bgSnippets || "EMPTY"}`);

    // ── Step 4: Deterministic check on background ─────────
    const bgLower   = (bgSnippets || "").toLowerCase();
    const strongHit = CONFIG.C4.STRONG_SIGNALS.find(kw => bgLower.includes(kw.toLowerCase()));
    const modHit    = CONFIG.C4.MODERATE_SIGNALS.find(kw => bgLower.includes(kw.toLowerCase()));

    if (strongHit) {
      Logger.log(`Deterministic → Strong (keyword: "${strongHit}") — skipping Gemini call 2`);
      Logger.log(`FINAL → name="${dmName}" | depth="Strong" | score=${CONFIG.C4.SCORE_MAP["Strong"]}`);
      return;
    }

    // ── Step 5: Gemini call 2 — depth classification ──────
    const evidenceForDepth = bgSnippets && bgSnippets.trim().length > 50
      ? bgSnippets
      : nameSnippets;

    Logger.log(`Gemini call 2: using ${bgSnippets?.trim().length > 50 ? "background" : "name"} snippets`);

    const depthPrompt = buildPrompt("C4_DEPTH", company, evidenceForDepth);
    const depthRaw    = callGeminiWithRetry(depthPrompt);

    if (!depthRaw) {
      Logger.log(`Gemini call 2: null response`);
      const allLower    = (nameSnippets + " " + (bgSnippets || "")).toLowerCase();
      const strongFall  = CONFIG.C4.STRONG_SIGNALS.find(kw => allLower.includes(kw.toLowerCase()));
      const modFall     = CONFIG.C4.MODERATE_SIGNALS.find(kw => allLower.includes(kw.toLowerCase()));
      Logger.log(`Deterministic fallback → strong="${strongFall || "none"}", moderate="${modFall || "none"}"`);
      return;
    }

    const depthParsed = parseGeminiJSON(depthRaw);
    if (!depthParsed) {
      Logger.log(`Gemini call 2: parse failed — raw: ${depthRaw.substring(0, 200)}`);
      return;
    }

    let depth = String(depthParsed.depth || "None").trim();
    Logger.log(`Gemini call 2 → depth="${depth}", bg="${depthParsed.bg || ""}", x="${depthParsed.x || ""}"`);

    // ── Step 6: Deterministic override on all evidence ────
    const allLower    = (nameSnippets + " " + (bgSnippets || "")).toLowerCase();
    const strongFinal = CONFIG.C4.STRONG_SIGNALS.find(kw => allLower.includes(kw.toLowerCase()));
    const modFinal    = CONFIG.C4.MODERATE_SIGNALS.find(kw => allLower.includes(kw.toLowerCase()));

    if (strongFinal && depth !== "Strong") {
      depth = "Strong";
      Logger.log(`Deterministic override → Strong (keyword: "${strongFinal}")`);
    } else if (modFinal && depth === "None") {
      depth = "Moderate";
      Logger.log(`Deterministic bump → Moderate (keyword: "${modFinal}")`);
    }

    const finalScore = CONFIG.C4.SCORE_MAP[depth] ?? 0;
    Logger.log(`FINAL → name="${dmName}" | depth="${depth}" | score=${finalScore}`);
  });

  Logger.log("\n=== testC4NameExtraction COMPLETE ===");
}