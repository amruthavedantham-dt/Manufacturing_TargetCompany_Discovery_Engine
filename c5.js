// ============================================================
// c5.gs — C5 Growing Sector Scoring
// Zero API calls. Zero AI. Pure deterministic logic.
// Reads Stage 1 cached snippets → keyword match → score.
// Depends on: config.gs, sheetManager.gs
// ============================================================

// ============================================================
// SECTION 1 — MASTER FUNCTION
// Call this from main.gs for each company that passes Stage 1.
// Returns a scores object — never throws.
// ============================================================

function runC5(companyObj) {
  const company = companyObj.company;
  Logger.log(`\nC5: starting for "${company}"`);

  const stage1 = getStage1Status(company);
  if (stage1 && String(stage1.manufacturerFlag).trim().toUpperCase() === 'NO') {
    Logger.log(`C5: "${company}" — Manufacturer_Flag=NO, capping at default score`);
    return buildC5Result(CONFIG.C5.DEFAULT, 'Non-manufacturer confirmed in Stage 1 — C5 capped');
  }

  // --------------------------------------------------------
  // Step 1: Read from cache — try STAGE1_MFG first,
  // then STAGE1_BIZ, then C3 (broadest evidence).
  // C5 never makes a live Serper call — it reuses what
  // Stage 1 already fetched for free.
  // Priority: STAGE1_MFG has the richest product/process
  // language; C3 has differentiation language that also
  // reveals sector clearly.
  // --------------------------------------------------------
  const queryPriority = ["STAGE1_MFG", "C3", "STAGE1_BIZ"];
  let snippets = null;

  for (const queryType of queryPriority) {
    snippets = getCachedSearch(company, queryType);
    if (snippets && snippets.trim().length >= 50) {
      Logger.log(`C5: using cached "${queryType}" snippets for "${company}"`);
      break;
    }
  }

  // --------------------------------------------------------
  // Step 2: Handle no cache at all
  // This should rarely happen — Stage 1 always runs first.
  // If it does, return default "Other" score.
  // --------------------------------------------------------
  if (!snippets || snippets.trim().length < 50) {
    Logger.log(`C5: no cached snippets found for "${company}" — scoring as Other`);
    return buildC5Result(CONFIG.C5.DEFAULT, "No cached evidence — Stage 1 may not have run");
  }

  const snippetsLower = snippets.toLowerCase();

  // --------------------------------------------------------
  // Step 3: Walk sector list in order (most specific first).
  // First match wins — order in CONFIG.C5.SECTOR_KEYWORDS
  // is intentional and must not be changed casually.
  //
  // Why order matters:
  //   "electronic chemicals" must come before "specialty chemicals"
  //   because semiconductor etching chemicals ARE specialty chemicals
  //   but we want the more specific (higher value) classification.
  //
  //   "pharma intermediates" must come before "commodity/basic"
  //   because bulk drugs could match both — pharma is correct.
  //
  //   "CRO/service" comes last among the named sectors because
  //   a CDMO might also mention APIs — we want to catch the
  //   manufacturing angle first if present.
  // --------------------------------------------------------
  for (const sector of CONFIG.C5.SECTOR_KEYWORDS) {
    const matchedKeyword = sector.keywords.find(kw =>
      snippetsLower.includes(kw.toLowerCase())
    );

    if (matchedKeyword) {
      Logger.log(`C5: "${company}" → sector="${sector.sector}", keyword="${matchedKeyword}", score=${sector.score}`);
      return buildC5Result(sector, matchedKeyword);
    }
  }

  // --------------------------------------------------------
  // Step 4: No sector matched — return default "Other"
  // --------------------------------------------------------
  Logger.log(`C5: "${company}" → no sector match, scoring as Other`);
  return buildC5Result(CONFIG.C5.DEFAULT, "No sector keywords matched");
}

// ============================================================
// SECTION 2 — RESULT BUILDER
// Builds the standardised scores object that main.gs expects.
// ============================================================

function buildC5Result(sectorConfig, matchedKeyword) {
  // Compose a clear, human-readable reason string.
  // Format: "<sector> — matched: '<keyword>' — <tailwind reason>"
  // The matched keyword makes it auditable — you can see exactly
  // why a company was placed in a sector.
  const reason = matchedKeyword && matchedKeyword !== "No cached evidence — Stage 1 may not have run"
    ? `${sectorConfig.sector} — matched: "${matchedKeyword}" — ${sectorConfig.reason}`
    : `${sectorConfig.sector} — ${sectorConfig.reason}`;

  return {
    c5:       sectorConfig.score,
    c5Sector: sectorConfig.sector,
    c5Reason: reason.substring(0, 250),
  };
}

// ============================================================
// SECTION 3 — TEST FUNCTION
// Tests four companies covering different sector paths:
//   Avra Synthesis       → Pharma intermediates (APIs)
//   Divi's Laboratories  → Pharma intermediates (APIs)
//   SRF Limited          → Specialty/Polymer (fluorochemicals)
//   A CRO company        → CRO/service (low score)
//
// Run "testC5" from dropdown. No API calls — instant.
// ============================================================

function testC5() {
  Logger.log("=== testC5() start ===\n");

  // --------------------------------------------------------
  // Seed test snippets directly into cache so C5 has
  // something to classify. In production, Stage 1 populates
  // this automatically. Delete these rows from SEARCH_CACHE
  // sheet before re-running if you want fresh seeds.
  // --------------------------------------------------------
  const testSnippets = [
    {
      company:   "Divi's Laboratories",
      queryType: "STAGE1_MFG",
      query:     "test",
      snippets:  "Divi's Laboratories is a leading manufacturer of active pharmaceutical ingredients (API) and intermediates. bulk drugs pharma intermediates exported to regulated markets.",
    },
    {
      company:   "SRF Limited",
      queryType: "STAGE1_MFG",
      query:     "test",
      snippets:  "SRF Limited manufactures polymer additives, resins, rubber compounds and performance chemicals for automotive and industrial applications.",
    },
    {
      company:   "Syngene International",
      queryType: "STAGE1_MFG",
      query:     "test",
      snippets:  "Syngene International is a contract research organization (CRO) and CDMO providing integrated drug discovery and development services. testing services for pharma clients.",
    },
  ];

  // Write to cache only if not already cached
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
  // Test cases — one per score band:
  //   Divi's      → Pharma intermediates → 20
  //   SRF         → Polymer additives    → 16
  //   Syngene     → CRO/service          →  2
  // Avra uses its existing C3 cache (no seed needed).
  // --------------------------------------------------------
  const testCases = [
    {
      company: "Avra Synthesis",
      website: "avrasynthesis.com",
      source:  "Test",
      expect:  "Other — score 5 (C3 cache has no sector keywords, STAGE1_MFG not run yet)",
    },
    {
      company: "Divi's Laboratories",
      website: "divislabs.com",
      source:  "Test",
      expect:  "Pharma intermediates — score 20",
    },
    {
      company: "SRF Limited",
      website: "srf.com",
      source:  "Test",
      expect:  "Polymer additives — score 16",
    },
    {
      company: "Syngene International",
      website: "syngeneintl.com",
      source:  "Test",
      expect:  "CRO/service — score 2",
    },
  ];

  let passed = 0;
  let failed = 0;

  testCases.forEach(({ company, website, source, expect }) => {
    Logger.log(`--- Testing: ${company} ---`);
    Logger.log(`Expected: ${expect}`);

    const result = runC5({ company, website, source });

    Logger.log(`Score:    ${result.c5}`);
    Logger.log(`Sector:   ${result.c5Sector}`);
    Logger.log(`Reason:   ${result.c5Reason}`);
    Logger.log(`C5 contributes ${result.c5}/20 toward final score`);

    // Simple pass/fail check against expected score
    const expectedScore = parseInt(expect.match(/score (\d+)/)?.[1]);
    if (!isNaN(expectedScore)) {
      if (result.c5 === expectedScore) {
        Logger.log(`✓ PASS`);
        passed++;
      } else {
        Logger.log(`✗ FAIL — expected score ${expectedScore}, got ${result.c5}`);
        failed++;
      }
    }

    Logger.log("");
  });

  // --------------------------------------------------------
  // Summary
  // --------------------------------------------------------
  Logger.log(`--- Results: ${passed} passed, ${failed} failed ---\n`);

  // --------------------------------------------------------
  // Keyword audit — prints every sector and its keywords
  // in priority order. Run this after editing
  // CONFIG.C5.SECTOR_KEYWORDS to verify no misplacements.
  // --------------------------------------------------------
  Logger.log("--- Sector keyword map (in match priority order) ---");
  CONFIG.C5.SECTOR_KEYWORDS.forEach((sector, idx) => {
    Logger.log(`${idx + 1}. ${sector.sector} (${sector.score}pts)`);
    Logger.log(`   Keywords: ${sector.keywords.join(", ")}`);
    Logger.log(`   Tailwind: ${sector.reason}`);
  });
  Logger.log(`DEFAULT: ${CONFIG.C5.DEFAULT.sector} (${CONFIG.C5.DEFAULT.score}pts)`);

  Logger.log("\n=== testC5() complete ===");
}