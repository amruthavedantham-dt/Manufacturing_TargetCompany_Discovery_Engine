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

function runC5(companyObj, snippets) {
  const company = companyObj.company;
  Logger.log(`\nC5: starting for "${company}"`);

  const stage1 = getStage1Status(company);
  if (stage1 && String(stage1.manufacturerFlag).trim().toUpperCase() === 'NO') {
    Logger.log(`C5: "${company}" — Manufacturer_Flag=NO, capping at default score`);
    const r = buildC5Result(CONFIG.C5.DEFAULT, 'Non-manufacturer confirmed in Stage 1 — C5 capped');
    EventLog.warn(CURRENT_RUN_ID, company, companyObj.website || '', 'sc-c5', 'OK',
      'C5: ' + r.c5 + '/20 — capped (non-manufacturer flag set in Stage 1)');
    return r;
  }

  if (!snippets || snippets.trim().length < 50) {
    Logger.log(`C5: no snippets provided for "${company}" — scoring as Other`);
    const r = buildC5Result(CONFIG.C5.DEFAULT, "No cached evidence — Stage 1 may not have run");
    EventLog.warn(CURRENT_RUN_ID, company, companyObj.website || '', 'sc-c5', 'OK',
      'C5: ' + r.c5 + '/20 — no cached snippets, defaulted to Other');
    return r;
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
      const r = buildC5Result(sector, matchedKeyword);
      EventLog.info(CURRENT_RUN_ID, company, companyObj.website || '', 'sc-c5', 'OK',
        'C5: ' + r.c5 + '/20 — sector: ' + sector.sector + ' (keyword: "' + matchedKeyword + '")');
      return r;
    }
  }

  // --------------------------------------------------------
  // Step 4: No sector matched — return default "Other"
  // --------------------------------------------------------
  Logger.log(`C5: "${company}" → no sector match, scoring as Other`);
  const r = buildC5Result(CONFIG.C5.DEFAULT, "No sector keywords matched");
  EventLog.info(CURRENT_RUN_ID, company, companyObj.website || '', 'sc-c5', 'OK',
    'C5: ' + r.c5 + '/20 — no sector match, defaulted to Other');
  return r;
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
  // Test cases — snippets passed directly, no cache needed.
  //   Divi's      → Pharma intermediates → 20
  //   SRF         → Polymer additives    → 16
  //   Syngene     → CRO/service          →  2
  //   Avra        → No sector match      →  5
  // --------------------------------------------------------
  const testCases = [
    {
      company:  "Avra Synthesis",
      website:  "avrasynthesis.com",
      source:   "Test",
      snippets: "Avra Synthesis is a Hyderabad-based manufacturer supplying custom molecules, laboratory reagents and compound libraries to research institutions.",
      expect:   "Other — score 8",
    },
    {
      company:  "Divi's Laboratories",
      website:  "divislabs.com",
      source:   "Test",
      snippets: "Divi's Laboratories is a leading manufacturer of active pharmaceutical ingredients (API) and intermediates. bulk drugs pharma intermediates exported to regulated markets.",
      expect:   "Pharma intermediates — score 20",
    },
    {
      company:  "SRF Limited",
      website:  "srf.com",
      source:   "Test",
      snippets: "SRF Limited manufactures polymer additives, resins, rubber compounds and performance chemicals for automotive and industrial applications.",
      expect:   "Polymer additives — score 16",
    },
    {
      company:  "Syngene International",
      website:  "syngeneintl.com",
      source:   "Test",
      snippets: "Syngene International is a contract research organization (CRO) and CDMO providing integrated drug discovery and development services. testing services for pharma clients.",
      expect:   "CRO/service — score 2",
    },
  ];

  let passed = 0;
  let failed = 0;

  testCases.forEach(({ company, website, source, snippets, expect }) => {
    Logger.log(`--- Testing: ${company} ---`);
    Logger.log(`Expected: ${expect}`);

    const result = runC5({ company, website, source }, snippets);

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