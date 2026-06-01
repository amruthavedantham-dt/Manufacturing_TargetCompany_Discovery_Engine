// ============================================================
// c4.gs — C4 Technical Decision-Maker Scoring
// Uses: Serper (evidence retrieval) + Gemini (interpretation)
// + deterministic override for strong keyword matches
// Depends on: config.gs, ai.gs, sheetManager.gs
// ============================================================

// ============================================================
// SECTION 1 — MASTER FUNCTION
// Call this from main.gs for each company that passes Stage 1.
// Returns a scores object — never throws.
// ============================================================

function runC4(companyObj) {
  const company = companyObj.company;
  Logger.log(`\nC4: starting for "${company}"`);

  // --------------------------------------------------------
  // Step 1: Get search evidence (cache first, live on miss)
  // --------------------------------------------------------
  const snippets = callSerper(company, "C4");

  // --------------------------------------------------------
  // Step 2: Handle empty evidence
  // --------------------------------------------------------
  if (!snippets || snippets.trim().length < 50) {
    Logger.log(`C4: insufficient evidence for "${company}" — scoring 0`);
    return {
      c4:           0,
      c4DmName:     "Unknown",
      c4Background: "No search evidence found",
      c4Confidence: "Low",
      manualReview: false,
    };
  }

  // --------------------------------------------------------
  // Step 3: Deterministic override — check strong signals
  // directly in snippets before calling Gemini.
  // If elite institution/credential found → Strong (20pts)
  // regardless of what Gemini says.
  // --------------------------------------------------------
  const snippetsLower = snippets.toLowerCase();
  const strongHit = CONFIG.C4.STRONG_SIGNALS.find(kw =>
    snippetsLower.includes(kw.toLowerCase())
  );
  const moderateHit = CONFIG.C4.MODERATE_SIGNALS.find(kw =>
    snippetsLower.includes(kw.toLowerCase())
  );

  // --------------------------------------------------------
  // Step 4: Build prompt and call Gemini
  // --------------------------------------------------------
  const prompt = buildPrompt("C4", company, snippets);
  const raw = callGeminiWithRetry(prompt);

  // --------------------------------------------------------
  // Step 5: Handle null Gemini response
  // --------------------------------------------------------
  if (!raw) {
    Logger.log(`C4: Gemini returned null for "${company}" — using deterministic fallback`);

    // Even if Gemini fails, use deterministic signals
    if (strongHit) {
      return {
        c4:           20,
        c4DmName:     "Unknown",
        c4Background: `Deterministic override: "${strongHit}" found in snippets`,
        c4Confidence: "Medium",  // medium not high — name unknown
        manualReview: true,      // flag since Gemini failed
      };
    }
    if (moderateHit) {
      return {
        c4:           10,
        c4DmName:     "Unknown",
        c4Background: `Deterministic override: "${moderateHit}" found in snippets`,
        c4Confidence: "Low",
        manualReview: true,
      };
    }
    return {
      c4:           0,
      c4DmName:     "Unknown",
      c4Background: "Gemini call failed — manual review needed",
      c4Confidence: "Low",
      manualReview: true,
    };
  }

  // --------------------------------------------------------
  // Step 6: Parse JSON
  // --------------------------------------------------------
  const parsed = parseGeminiJSON(raw);
  Logger.log(`Raw Gemini signals: ${JSON.stringify(parsed)}`);

  // --------------------------------------------------------
  // Step 7: Handle parse failure
  // --------------------------------------------------------
  if (!parsed) {
    Logger.log(`C4: JSON parse failed for "${company}" — using deterministic fallback`);
    if (strongHit) {
      return {
        c4:           20,
        c4DmName:     "Unknown",
        c4Background: `Deterministic override: "${strongHit}" found in snippets`,
        c4Confidence: "Medium",
        manualReview: true,
      };
    }
    return {
      c4:           0,
      c4DmName:     "Unknown",
      c4Background: "JSON parse failed — manual review needed",
      c4Confidence: "Low",
      manualReview: true,
    };
  }

  // --------------------------------------------------------
  // Step 8: Score — deterministic override takes priority
  // If strong keyword found in raw snippets, override Gemini
  // to Strong regardless of what it returned.
  // --------------------------------------------------------
  let depth = String(parsed.depth || "None").trim();

  if (strongHit && depth !== "Strong") {
    Logger.log(`C4: deterministic override → Strong (keyword: "${strongHit}")`);
    depth = "Strong";
  } else if (moderateHit && depth === "None") {
    Logger.log(`C4: deterministic bump → Moderate (keyword: "${moderateHit}")`);
    depth = "Moderate";
  }

  const c4Score      = CONFIG.C4.SCORE_MAP[depth] ?? 0;
  const c4DmName     = String(parsed.name || "Unknown").trim();
  const c4Background = buildC4Background(parsed, depth, strongHit, moderateHit);
  const c4Confidence = getC4Confidence(depth, parsed, strongHit);

  Logger.log(`C4: "${company}" → depth=${depth}, score=${c4Score}, name=${c4DmName}`);

  return {
    c4:           c4Score,
    c4DmName:     c4DmName,
    c4Background: c4Background,
    c4Confidence: c4Confidence,
    manualReview: false,
  };
}

// ============================================================
// SECTION 2 — BACKGROUND STRING BUILDER
// Builds a concise one-line background for the SCORES sheet.
// Format: "Strong | IIT Bombay, PhD Chemistry | name confirmed"
// ============================================================

function buildC4Background(parsed, finalDepth, strongHit, moderateHit) {
  const parts = [];

  // Add depth classification
  parts.push(finalDepth);

  // Add Gemini's background summary if available
  const bg = String(parsed.bg || "").trim();
  if (bg && bg.toLowerCase() !== "unknown") {
    parts.push(bg.substring(0, 80));
  }

  // Note if deterministic override fired
  if (strongHit) parts.push(`keyword: "${strongHit}"`);
  else if (moderateHit) parts.push(`keyword: "${moderateHit}"`);

  // Add Gemini's reason
  const reason = String(parsed.x || "").trim();
  if (reason) parts.push(reason.substring(0, 60));

  return parts.join(" | ").substring(0, 200);
}

// ============================================================
// SECTION 3 — CONFIDENCE LEVEL
// Strong + deterministic hit → High
// Strong from Gemini only → Medium (could be hallucinated)
// Moderate → Medium
// None → Low
// ============================================================

function getC4Confidence(depth, parsed, strongHit) {
  if (depth === "Strong" && strongHit) return "High";
  if (depth === "Strong")              return "Medium";
  if (depth === "Moderate")            return "Medium";
  return "Low";
}

// ============================================================
// SECTION 4 — TEST FUNCTION
// Tests two companies:
//   Avra Synthesis  — expect None/Low (catalogue trading business)
//   A known IIT-founder company — expect Strong/High
// Run "testC4" from the dropdown and check Execution Log.
// ============================================================

function testC4() {
  Logger.log("=== testC4() start ===\n");

  const testCases = [
    {
      company:  "Avra Synthesis",
      website:  "avrasynthesis.com",
      source:   "Test",
      expect:   "None — catalogue business, no strong technical founder expected",
    },
    {
      company:  "Divi's Laboratories",
      website:  "divislabs.com",
      source:   "Test",
      expect:   "Strong — known IIT/PhD founder, major pharma manufacturer",
    },
  ];

  testCases.forEach(({ company, website, source, expect }) => {
    Logger.log(`--- Testing: ${company} ---`);
    Logger.log(`Expected: ${expect}`);

    const result = runC4({ company, website, source });

    Logger.log(`Score:        ${result.c4}`);
    Logger.log(`DM Name:      ${result.c4DmName}`);
    Logger.log(`Background:   ${result.c4Background}`);
    Logger.log(`Confidence:   ${result.c4Confidence}`);
    Logger.log(`ManualReview: ${result.manualReview}`);
    Logger.log(`C4 contributes ${result.c4}/20 toward final score`);
    Logger.log("");
  });

  // --- JSON repair stress test (same as testC3) ---
  Logger.log("--- C4 JSON repair layers ---");
  const repairCases = [
    {
      label: "Clean JSON",
      input: '{"depth":"Strong","name":"Dr. Murali","bg":"IIT Bombay PhD Chemistry","x":"clear technical founder"}',
    },
    {
      label: "Markdown wrapped",
      input: '```json\n{"depth":"Moderate","name":"Unknown","bg":"B.Tech engineering","x":"some technical background"}\n```',
    },
    {
      label: "Truncated — x field cut off",
      input: '{"depth":"Strong","name":"Dr. Reddy","bg":"IIT Madras","x":"Founded after 20 years',
    },
    {
      label: "Total garbage",
      input: "I cannot determine the technical background from this evidence.",
    },
  ];

  repairCases.forEach(({ label, input }) => {
    const result = parseGeminiJSON(input);
    Logger.log(`  ${label}: ${result ? "PASS → " + JSON.stringify(result) : "null (fallback to default)"}`);
  });

  Logger.log("\n=== testC4() complete ===");
}