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
    Logger.log("C6 ERROR: runC6() called with no companyObj. Run testC6() instead.");
    return { c6: 0, c6Signals: "Invalid call", c6Confidence: "Low" };
  }

  const company = companyObj.company;
  Logger.log(`\nC6: starting for "${company}"`);

  // --------------------------------------------------------
  // Step 1: Get snippets — cache first, live call on miss.
  // C6 uses its own dedicated query (hiring/expansion/news)
  // which Stage 1 and C3 queries don't cover well.
  // --------------------------------------------------------
  const snippets = callSerper(company, "C6");

  // --------------------------------------------------------
  // Step 2: Handle empty evidence
  // --------------------------------------------------------
  if (!snippets || snippets.trim().length < 50) {
    Logger.log(`C6: insufficient evidence for "${company}" — scoring 0`);
    return {
      c6:           0,
      c6Signals:    "No search evidence found",
      c6Confidence: "Low",
    };
  }

  // --------------------------------------------------------
  // Step 3: Deterministic signal detection
  // No AI — pure keyword matching against CONFIG.C6.SIGNALS
  // --------------------------------------------------------
  const { firedSignals, totalStrength } = detectC6Signals(snippets);

  // --------------------------------------------------------
  // Step 4: Score from signal strength
  // --------------------------------------------------------
  const c6Score      = getC6Score(totalStrength);   // from config.gs helper
  const c6Confidence = getC6Confidence(totalStrength);
  const c6Signals    = buildC6SignalString(firedSignals);

  Logger.log(`C6: "${company}" → strength=${totalStrength}, score=${c6Score}, confidence=${c6Confidence}`);
  Logger.log(`C6: signals fired: ${c6Signals || "none"}`);

  return {
    c6:           c6Score,
    c6Signals:    c6Signals,
    c6Confidence: c6Confidence,
  };
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