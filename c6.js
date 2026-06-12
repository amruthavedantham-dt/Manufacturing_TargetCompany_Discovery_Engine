// ============================================================
// c6.gs — C6 Growth Signals Scoring
// Zero AI. Fully deterministic signal detection.
// Makes one Serper call (or reads cache) per company.
// Depends on: config.gs, ai.gs, sheetManager.gs
// ============================================================

// ============================================================
// SECTION 1 — MASTER FUNCTION
// Call this from main.gs for each company that passes Stage 1.
// Returns a scores object — never throws.
// ============================================================

function runC6(companyObj) {
  if (!companyObj || !companyObj.company) {
    Logger.log("C6 ERROR: runC6() called with no companyObj.");
    return { c6: 0, c6Signals: "Invalid call", c6Confidence: "Low" };
  }

  const company = companyObj.company;
  Logger.log(`\nC6: starting for "${company}"`);

  // ── Step 1: Get C6-specific snippets ─────────────────────
  const snippets = callSerper(company, "C6");

  // ── Step 2: Also pull from Stage 1 cache as fallback ─────
  const cachedMfg = getCachedSearch(company, "STAGE1_MFG") || "";
  const cachedC3  = getCachedSearch(company, "C3")         || "";

  const combinedEvidence = [
    snippets     || "",
    cachedMfg,
    cachedC3,
  ].join("\n").trim();

  if (combinedEvidence.length < 50) {
    Logger.log(`C6: no evidence at all for "${company}" — scoring 0`);
    EventLog.warn(CURRENT_RUN_ID, company, companyObj.website || '', 'sc-c6', 'OK',
      'C6: 0/20 — no search evidence found');
    return { c6: 0, c6Signals: "No search evidence found", c6Confidence: "Low" };
  }

  // ── Step 3: Deterministic pass (fast, no API cost) ───────
  const { firedSignals, totalStrength } = detectC6Signals(combinedEvidence);

  // If deterministic already found 2+ signals, trust it — skip Gemini
  if (totalStrength >= 2) {
    const c6Score      = getC6Score(totalStrength);
    const c6Confidence = getC6Confidence(totalStrength);
    const c6Signals    = buildC6SignalString(firedSignals);
    Logger.log(`C6: "${company}" → deterministic strong (${totalStrength}) → score=${c6Score}`);
    EventLog.info(CURRENT_RUN_ID, company, companyObj.website || '', 'sc-c6', 'OK',
      'C6: ' + c6Score + '/20 — ' + totalStrength + ' signals (deterministic): ' + c6Signals);
    return { c6: c6Score, c6Signals, c6Confidence };
  }

  // ── Step 4: Gemini pass for ambiguous cases ───────────────
  // Deterministic found 0 or 1 signals — Gemini reads more carefully
  Logger.log(`C6: "${company}" → deterministic weak (${totalStrength}), calling Gemini`);

  const evidenceTrimmed = combinedEvidence.substring(0, 2000);
  const prompt = PROMPTS.C6.replace("{evidence}", evidenceTrimmed);
  const raw    = callGeminiWithRetry(prompt, { company, stage: 'c6' });

  if (!raw) {
    Logger.log(`C6: Gemini null for "${company}" — using deterministic result`);
    const c6Score      = getC6Score(totalStrength);
    const c6Confidence = getC6Confidence(totalStrength);
    const c6Signals    = buildC6SignalString(firedSignals) || "No signals detected";
    EventLog.warn(CURRENT_RUN_ID, company, companyObj.website || '', 'sc-c6', 'OK',
      'C6: ' + c6Score + '/20 — Gemini null, used deterministic fallback: ' + c6Signals);
    return { c6: c6Score, c6Signals, c6Confidence };
  }

  const parsed = parseGeminiJSON(raw);

  if (!parsed) {
    Logger.log(`C6: Gemini parse failed for "${company}" — using deterministic result`);
    const c6Score      = getC6Score(totalStrength);
    const c6Confidence = getC6Confidence(totalStrength);
    const c6Signals    = buildC6SignalString(firedSignals) || "No signals detected";
    return { c6: c6Score, c6Signals, c6Confidence };
  }

  // ── Step 5: Merge Gemini result with deterministic ────────
  // Count how many of the 5 boolean flags Gemini set to true
  const geminiSignals = [];
  if (parsed.hiring)        geminiSignals.push("Hiring");
  if (parsed.facility)      geminiSignals.push("Facility_Expansion");
  if (parsed.certifications) geminiSignals.push("Certifications");
  if (parsed.active)        geminiSignals.push("Active_News");
  if (parsed.exports)       geminiSignals.push("Export_Growth");

  // Merge: take the union of deterministic and Gemini signals
  const deterministicNames = firedSignals.map(s => s.signal);
  const allSignalNames     = [...new Set([...deterministicNames, ...geminiSignals])];
  const mergedStrength     = allSignalNames.length;

  const c6Score      = getC6Score(mergedStrength);
  const c6Confidence = getC6Confidence(mergedStrength);
  const reasonNote   = String(parsed.x || "").trim();

  // Build signal string: deterministic signals keep their keyword, Gemini-only ones labelled
  const deterministicStr = buildC6SignalString(firedSignals);
  const geminiOnly       = geminiSignals.filter(s => !deterministicNames.includes(s));
  const geminiStr        = geminiOnly.map(s => `${s} (Gemini)`).join(", ");
  const c6Signals        = [deterministicStr, geminiStr].filter(Boolean).join(", ")
                           || "No signals detected";

  Logger.log(`C6: "${company}" → merged strength=${mergedStrength}, score=${c6Score}`);
  Logger.log(`C6: deterministic=${deterministicNames.join(",") || "none"} | gemini=${geminiOnly.join(",") || "none"}`);
  if (reasonNote) Logger.log(`C6: Gemini note: ${reasonNote}`);
  EventLog.info(CURRENT_RUN_ID, company, companyObj.website || '', 'sc-c6', 'OK',
    'C6: ' + c6Score + '/20 — ' + mergedStrength + ' signals (merged): ' + c6Signals);

  return { c6: c6Score, c6Signals, c6Confidence };
}

// ============================================================
// SECTION 2 — SIGNAL DETECTOR
// Loops every signal in CONFIG.C6.SIGNALS.
// For each signal, checks if ANY of its keywords appear
// in the snippets. One signal = one point of strength,
// regardless of how many keywords matched within it.
// Returns firedSignals array and totalStrength count.
// ============================================================

function detectC6Signals(snippets) {
  const snippetsLower = snippets.toLowerCase();
  const firedSignals  = [];
  let totalStrength   = 0;

  for (const [signalName, signalConfig] of Object.entries(CONFIG.C6.SIGNALS)) {
    const matchedKeyword = signalConfig.keywords.find(kw =>
      snippetsLower.includes(kw.toLowerCase())
    );

    if (matchedKeyword) {
      firedSignals.push({
        signal:  signalName,
        keyword: matchedKeyword,
        weight:  signalConfig.weight,
      });
      totalStrength += signalConfig.weight;
      Logger.log(`C6: signal "${signalName}" fired — keyword: "${matchedKeyword}"`);
    } else {
      Logger.log(`C6: signal "${signalName}" — no match`);
    }
  }

  return { firedSignals, totalStrength };
}

// ============================================================
// SECTION 3 — SIGNAL STRING BUILDER
// Builds readable evidence for SCORES sheet.
// Format: "Hiring (hiring), Certifications (usfda), Export_Growth (exports)"
// The matched keyword in brackets makes it auditable.
// ============================================================

function buildC6SignalString(firedSignals) {
  if (!firedSignals || firedSignals.length === 0) return "No signals detected";
  return firedSignals
    .map(s => `${s.signal} (${s.keyword})`)
    .join(", ");
}

// ============================================================
// SECTION 4 — CONFIDENCE LEVEL
// Reads from CONFIG.C6.CONFIDENCE_MAP.
// ============================================================

function getC6Confidence(totalStrength) {
  for (const entry of CONFIG.C6.CONFIDENCE_MAP) {
    if (totalStrength >= entry.minStrength) return entry.level;
  }
  return "Low";
}

// ============================================================
// SECTION 5 — TEST FUNCTION
// Tests three companies covering all score bands:
//   Divi's Laboratories  → expect 20 (major exporter, certs, hiring)
//   Avra Synthesis       → expect 10 (some signals, smaller presence)
//   Dummy dormant co     → expect  0 (seeded with flat snippets)
//
// Prints full signal audit per company — which keywords
// fired and which didn't — so you can verify detection logic.
// ============================================================

function testC6() {
  Logger.log("=== testC6() start ===\n");

  // --------------------------------------------------------
  // Seed cache for companies that haven't run Stage 1.
  // Divi's and Avra may already have C6 cache from prior
  // runs — the seed is skipped if cache exists.
  // --------------------------------------------------------
  const testSnippets = [
    {
      company:   "Divi's Laboratories",
      queryType: "C6",
      query:     "test",
      snippets:  [
        "Divi's Laboratories announces expansion of its Unit II manufacturing facility",
        "with a new greenfield plant approved for API production at Vizag.",
        "The company is actively hiring chemical engineers and production staff for 2024.",
        "Divi's holds USFDA and EU-GMP approved facilities for regulated market exports.",
        "Revenue growth driven by strong export demand from USA, Europe and Japan.",
        "Latest press release 2025: Divi's wins new long-term supply contracts.",
      ].join(" "),
    },
    {
      company:   "Avra Synthesis",
      queryType: "C6",
      query:     "test",
      snippets:  "Avra Synthesis offers catalogue compounds for research use. ISO certified laboratory. Contact our Hyderabad office for bulk orders.",
    },
    {
      company:   "Dormant Chemicals Ltd",
      queryType: "C6",
      query:     "test",
      snippets:  [
        "Dormant Chemicals Ltd manufactures basic industrial chemicals.",
        "Contact us at our Hyderabad office for bulk orders.",
        "We supply sodium sulphate and calcium carbonate to local industries.",
      ].join(" "),
    },
  ];

  testSnippets.forEach(({ company, queryType, query, snippets }) => {
    const existing = getCachedSearch(company, queryType);
    if (!existing) {
      saveToCache(company, queryType, query, snippets);
      Logger.log(`Seeded cache: ${company} | ${queryType}`);
    } else {
      Logger.log(`Cache already exists, skipping seed: ${company} | ${queryType}`);
    }
  });

  Logger.log("");

  // --------------------------------------------------------
  // Test cases — one per score band
  // --------------------------------------------------------
  const testCases = [
    {
      company:       "Divi's Laboratories",
      website:       "divislabs.com",
      source:        "Test",
      expect:        20,
      expectReason:  "5 signals: Hiring, Expansion, Certifications, Active_News, Export_Growth",
    },
    {
    company:      "Avra Synthesis",
    website:      "avrasynthesis.com",
    source:       "Test",
    expect:       10,
    expectReason: "1 signal only: Certifications (iso certified)",
    },
    {
      company:       "Dormant Chemicals Ltd",
      website:       "dormantchem.com",
      source:        "Test",
      expect:        0,
      expectReason:  "No growth signals — basic local supplier, no hiring/expansion/certs/news",
    },
  ];

  let passed = 0;
  let failed = 0;

  testCases.forEach(({ company, website, source, expect, expectReason }) => {
    Logger.log(`--- Testing: ${company} ---`);
    Logger.log(`Expected score: ${expect} — ${expectReason}`);

    const result = runC6({ company, website, source });

    Logger.log(`Score:      ${result.c6}`);
    Logger.log(`Signals:    ${result.c6Signals}`);
    Logger.log(`Confidence: ${result.c6Confidence}`);
    Logger.log(`C6 contributes ${result.c6}/20 toward final score`);

    if (result.c6 === expect) {
      Logger.log(`✓ PASS`);
      passed++;
    } else {
      Logger.log(`✗ FAIL — expected ${expect}, got ${result.c6}`);
      failed++;
    }

    Logger.log("");
  });

  // --------------------------------------------------------
  // Summary
  // --------------------------------------------------------
  Logger.log(`--- Results: ${passed} passed, ${failed} failed ---\n`);

  // --------------------------------------------------------
  // Signal keyword audit — prints every signal and its
  // keywords. Run after editing CONFIG.C6.SIGNALS to verify.
  // --------------------------------------------------------
  Logger.log("--- C6 signal map ---");
  for (const [signalName, signalConfig] of Object.entries(CONFIG.C6.SIGNALS)) {
    Logger.log(`${signalName} (weight: ${signalConfig.weight})`);
    Logger.log(`   Keywords: ${signalConfig.keywords.join(", ")}`);
  }

  Logger.log("\n--- Score thresholds ---");
  CONFIG.C6.SCORE_MAP.forEach(entry => {
    Logger.log(`  Strength ≥ ${entry.minStrength} → ${entry.score}pts`);
  });

  Logger.log("\n=== testC6() complete ===");
}