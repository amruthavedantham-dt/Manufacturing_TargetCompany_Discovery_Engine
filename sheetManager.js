// ============================================================
// sheetManager.gs
// All Sheet Operations for ICP Pipeline
// CLEANED + OPTIMIZED VERSION
// ============================================================

// ============================================================
// SECTION 1 — SETUP
// ============================================================

function setupSheets() {

  try {

    const ss =
      SpreadsheetApp.getActiveSpreadsheet();

    const sheetsToCreate = [

      // ------------------------------------------------------
      // STAGE 1 RESULTS
      // ------------------------------------------------------
      {
        name: SHEETS.STAGE1,

        headers: [

          "Company Name",
          "Website",
          "Source",

          "Manufacturer_Flag",
          "Acquired_Flag",

          "Revenue_Band",
          "Revenue_Confidence",
          "Revenue_Evidence",
          "Revenue_Source",

          "Stage1_Status",
          "Fail_Reason",
        ],
      },

      // ------------------------------------------------------
      // SEARCH CACHE
      // ------------------------------------------------------
      {
        name: SHEETS.CACHE,

        headers: [

          "Company Name",
          "Query_Type",
          "Query_String",
          "Snippets",
          "Timestamp",
        ],
      },

      // ------------------------------------------------------
      // SCORES
      // DO NOT CHANGE TODAY
      // ------------------------------------------------------
      {
        name: SHEETS.SCORES,

        headers: [

          "Company Name",
          "Website",
          "Source",

          "C1",
          "C2",

          "C3",
          "C3_Evidence",
          "C3_Confidence",

          "C4",
          "C4_DM_Name",
          "C4_Background",
          "C4_Confidence",

          "C5",
          "C5_Sector",
          "C5_Reason",

          "C6",
          "C6_Signals",
          "C6_Confidence",

          "Final_Score",
          "Band",
          "Band_Label",
        ],
      },

      // ------------------------------------------------------
      // SHORTLIST
      // DO NOT CHANGE TODAY
      // ------------------------------------------------------
      {
        name: SHEETS.SHORTLIST,

        headers: [

          "Rank",

          "Company Name",
          "Website",
          "Source",

          "C1_Score",
          "C2_Score",

          "C3_Score",
          "C3_Evidence",

          "C4_Score",
          "C4_DM_Name",
          "C4_Background",

          "C5_Score",
          "C5_Sector",

          "C6_Score",
          "C6_Signals",

          "Final_Score",

          "Band",
          "Band_Label",

          "Verdict",
          "Manual_Notes",
        ],
      },
    ];

    // --------------------------------------------------------
    // CREATE / VERIFY SHEETS
    // --------------------------------------------------------

    sheetsToCreate.forEach(({ name, headers }) => {

      let sheet =
        ss.getSheetByName(name);

      // ------------------------------------------------------
      // CREATE SHEET
      // ------------------------------------------------------

      if (!sheet) {

        sheet = ss.insertSheet(name);

        Logger.log(
          `[setupSheets] Created sheet: ${name}`
        );
      }

      // ------------------------------------------------------
      // WRITE HEADERS ONLY IF EMPTY
      // ------------------------------------------------------

      const firstCell =
        sheet.getRange(1, 1).getValue();

      if (!firstCell) {

        sheet
          .getRange(
            1,
            1,
            1,
            headers.length
          )
          .setValues([headers]);

        sheet
          .getRange(
            1,
            1,
            1,
            headers.length
          )
          .setFontWeight("bold");

        Logger.log(
          `[setupSheets] Headers added: ${name}`
        );
      }
    });

    Logger.log(
      `[setupSheets SUCCESS]`
    );

  } catch (err) {

    Logger.log(
      `[setupSheets ERROR] ${err.message}`
    );
  }
}



// ============================================================
// SECTION 2 — READ MASTER SHEET
// ============================================================

function getCompanies() {

  try {

    const ss =
      SpreadsheetApp.getActiveSpreadsheet();

    const sheet =
      ss.getSheetByName(
        SHEETS.MASTER
      );

    if (!sheet) {

      throw new Error(
        "MASTER sheet not found"
      );
    }

    const lastRow =
      sheet.getLastRow();

    if (lastRow < 2) {

      Logger.log(
        `[getCompanies] No company rows found`
      );

      return [];
    }

    const data =
      sheet
        .getRange(
          2,
          1,
          lastRow - 1,
          3
        )
        .getValues();

    const companies = [];

    data.forEach((row, index) => {

      const company = String(
        row[MASTER_COLS.COMPANY] || ""
      ).trim();

      if (!company) return;

      companies.push({

        company,

        website: String(
          row[MASTER_COLS.WEBSITE] || ""
        ).trim(),

        source: String(
          row[MASTER_COLS.SOURCE] || ""
        ).trim(),

        rowIndex: index + 2,
      });
    });

    Logger.log(
      `[getCompanies SUCCESS] ${companies.length} loaded`
    );

    return companies;

  } catch (err) {

    Logger.log(
      `[getCompanies ERROR] ${err.message}`
    );

    return [];
  }
}



// ============================================================
// SECTION 3 — CHECKPOINT MANAGEMENT
// ============================================================

function getCheckpoint() {

  try {

    const props =
      PropertiesService
        .getScriptProperties();

    const value =
      props.getProperty(
        "PIPELINE_CHECKPOINT"
      );

    return value
      ? parseInt(value, 10)
      : 0;

  } catch (err) {

    Logger.log(
      `[getCheckpoint ERROR] ${err.message}`
    );

    return 0;
  }
}


function saveCheckpoint(index) {

  try {

    PropertiesService
      .getScriptProperties()
      .setProperty(
        "PIPELINE_CHECKPOINT",
        String(index)
      );

    Logger.log(
      `[Checkpoint Saved] ${index}`
    );

  } catch (err) {

    Logger.log(
      `[saveCheckpoint ERROR] ${err.message}`
    );
  }
}


function resetCheckpoint() {

  try {

    PropertiesService
      .getScriptProperties()
      .deleteProperty(
        "PIPELINE_CHECKPOINT"
      );

    Logger.log(
      `[Checkpoint Reset]`
    );

  } catch (err) {

    Logger.log(
      `[resetCheckpoint ERROR] ${err.message}`
    );
  }
}



// ============================================================
// SECTION 4 — SEARCH CACHE
// ============================================================

function getCachedSearch(
  companyName,
  queryType
) {

  try {

    const ss =
      SpreadsheetApp.getActiveSpreadsheet();

    const sheet =
      ss.getSheetByName(
        SHEETS.CACHE
      );

    if (
      !sheet ||
      sheet.getLastRow() < 2
    ) {

      return null;
    }

    const data =
      sheet
        .getRange(
          2,
          1,
          sheet.getLastRow() - 1,
          5
        )
        .getValues();

    for (const row of data) {

      const cachedCompany =
        String(row[0])
          .trim()
          .toLowerCase();

      const cachedQueryType =
        String(row[1])
          .trim()
          .toUpperCase();

      if (

        cachedCompany ===
          companyName
            .trim()
            .toLowerCase()

        &&

        cachedQueryType ===
          queryType
            .trim()
            .toUpperCase()
      ) {

        const snippets =
          String(row[3] || "").trim();

        if (snippets) {

          return snippets;
        }
      }
    }

    return null;

  } catch (err) {

    Logger.log(
      `[getCachedSearch ERROR] ${err.message}`
    );

    return null;
  }
}



function saveToCache(
  companyName,
  queryType,
  queryString,
  snippets
) {

  try {

    const ss =
      SpreadsheetApp.getActiveSpreadsheet();

    const sheet =
      ss.getSheetByName(
        SHEETS.CACHE
      );

    if (!sheet) {

      throw new Error(
        "SEARCH_CACHE sheet missing"
      );
    }

    sheet.appendRow([

      companyName,

      queryType.toUpperCase(),

      queryString,

      snippets,

      new Date().toISOString(),
    ]);

  } catch (err) {

    Logger.log(
      `[saveToCache ERROR] ${err.message}`
    );
  }
}



// ============================================================
// SECTION 5 — WRITE STAGE 1 RESULTS
// ============================================================

function writeStage1Result(companyObj, result) {
  try {
    const ss = SpreadsheetApp.getActiveSpreadsheet();
    const sheet = ss.getSheetByName(SHEETS.STAGE1);

    if (!sheet) throw new Error("STAGE1_RESULTS sheet missing");

    // Determine band display value
    // "-"              → Gate 1 or Gate 2 failed, revenue never checked
    // "PENDING_REVENUE" → needs Gemini batch
    // "<50Cr" etc.     → direct regex found a number
    // "Unknown"        → Gate 3 reached but no evidence at all
    const band = result.revenueBand?.band ?? "-";
    const confidence = result.revenueBand?.confidence ?? "-";
    const evidence = result.revenueBand?.evidence ?? "-";

    sheet.appendRow([
      companyObj.company,
      companyObj.website,
      companyObj.source,
      result.manufacturer ? "YES" : "NO",
      result.acquired     ? "YES" : "NO",
      band,
      confidence,
      evidence,
      result.revenueSource || "-",
      result.status        || "FAIL",
      result.failReason    || "",
    ]);

  } catch (err) {
    Logger.log(`[writeStage1Result ERROR] ${companyObj.company} | ${err.message}`);
  }
}



// ============================================================
// SECTION 6 — FLAG FOR REVIEW
// ============================================================

function flagForReview(
  companyObj,
  reason
) {

  try {

    writeStage1Result(companyObj, {

      manufacturer: false,

      acquired: false,

      revenueBand: {

        band:
          CONFIG.REVENUE.BANDS.UNKNOWN,

        confidence:
          CONFIG.REVENUE.CONFIDENCE.LOW,

        evidence:
          "Manual review required",
      },

      status: "MANUAL_REVIEW",

      failReason: reason,
    });

  } catch (err) {

    Logger.log(
      `[flagForReview ERROR] ${companyObj.company} | ${err.message}`
    );
  }
}



// ============================================================
// SECTION 7 — WRITE FINAL SCORES
// DO NOT CHANGE TODAY
// ============================================================

function writeScores(
  companyObj,
  scores
) {

  try {

    const ss =
      SpreadsheetApp.getActiveSpreadsheet();

    const sheet =
      ss.getSheetByName(
        SHEETS.SCORES
      );

    if (!sheet) {

      throw new Error(
        "SCORES sheet missing"
      );
    }

    sheet.appendRow([

      companyObj.company,
      companyObj.website,
      companyObj.source,

      scores.c1 || 0,
      scores.c2 || 5,

      scores.c3 || 0,
      scores.c3Evidence || "",
      scores.c3Confidence || "Low",

      scores.c4 || 0,
      scores.c4DmName || "Unknown",
      scores.c4Background || "",
      scores.c4Confidence || "Low",

      scores.c5 || 0,
      scores.c5Sector || "Other",
      scores.c5Reason || "",

      scores.c6 || 0,
      scores.c6Signals || "",
      scores.c6Confidence || "Low",

      scores.finalScore || 0,

      scores.band || "D",

      scores.bandLabel || "Not ICP",
    ]);

  } catch (err) {

    Logger.log(
      `[writeScores ERROR] ${companyObj.company} | ${err.message}`
    );
  }
}



// ============================================================
// SECTION 8 — BUILD SHORTLIST
// ============================================================
function buildShortlist() {
  try {
    Logger.log(`[buildShortlist START]`);

    const ss            = SpreadsheetApp.getActiveSpreadsheet();
    const scoresSheet   = ss.getSheetByName(SHEETS.SCORES);
    const stage1Sheet   = ss.getSheetByName(SHEETS.STAGE1);
    const shortlistSheet = ss.getSheetByName(SHEETS.SHORTLIST);

    if (!scoresSheet || !shortlistSheet || !stage1Sheet) {
      throw new Error("Required sheets missing — run setupSheets() first");
    }

    // Clear existing shortlist content but keep headers
    if (shortlistSheet.getLastRow() > 1) {
      shortlistSheet.getRange(
        2, 1,
        shortlistSheet.getLastRow() - 1,
        shortlistSheet.getLastColumn()
      ).clearContent();
    }

    // ── Section 1: Pull all scored companies from SCORES ───
    const scoresData = scoresSheet.getLastRow() > 1
      ? scoresSheet.getRange(2, 1, scoresSheet.getLastRow() - 1, 21).getValues()
      : [];

    // Sort by final score descending
    scoresData.sort((a, b) => (b[18] || 0) - (a[18] || 0));

    let rank = 1;
    const rows = [];

    scoresData.forEach(row => {
      const company    = String(row[0]  || "").trim();
      const website    = String(row[1]  || "").trim();
      const source     = String(row[2]  || "").trim();
      const c1         = row[3]  || 0;
      const c2         = row[4]  || 0;
      const c3         = row[5]  || 0;
      const c3Evidence = row[6]  || "";
      const c4         = row[8]  || 0;
      const c4DmName   = row[9]  || "";
      const c4Bg       = row[10] || "";
      const c5         = row[12] || 0;
      const c5Sector   = row[13] || "";
      const c6         = row[15] || 0;
      const c6Signals  = row[16] || "";
      const finalScore = row[18] || 0;
      const band       = row[19] || "";
      const bandLabel  = row[20] || "";

      if (!company) return;

      // Verdict based on band
      let verdict = "Not ICP";
      if (band === "A")      verdict = "Strong ICP — prioritise outreach";
      else if (band === "B") verdict = "Probable ICP — include in outreach";
      else if (band === "C") verdict = "Borderline — low priority";

      rows.push([
        rank++,
        company,
        website,
        source,
        c1,
        c2,
        c3,
        c3Evidence,
        c4,
        c4DmName,
        c4Bg,
        c5,
        c5Sector,
        c6,
        c6Signals,
        finalScore,
        band,
        bandLabel,
        verdict,
        "", // Manual_Notes — empty, for you to fill
      ]);
    });

    // ── Section 2: Pull MANUAL_REVIEW companies from STAGE1
    // These never reached scoring — need human decision
    const stage1Data = stage1Sheet.getLastRow() > 1
      ? stage1Sheet.getRange(2, 1, stage1Sheet.getLastRow() - 1, 11).getValues()
      : [];

    stage1Data.forEach(row => {
      const company    = String(row[0]  || "").trim();
      const website    = String(row[1]  || "").trim();
      const source     = String(row[2]  || "").trim();
      const status     = String(row[9]  || "").trim();
      const failReason = String(row[10] || "").trim();

      if (!company || status !== "MANUAL_REVIEW") return;

      rows.push([
        "", // no rank for manual review
        company,
        website,
        source,
        "", "", "", "", "", "", "",
        "", "", "", "",
        "", // no final score
        "MANUAL_REVIEW",
        "Needs human decision",
        `Manual review required: ${failReason}`,
        "", // Manual_Notes
      ]);
    });

    // Write all rows
    if (rows.length) {
      // Extend headers to include Manual_Notes column
      const headers = shortlistSheet.getRange(1, 1, 1, 20).getValues()[0];
      if (!headers[19]) {
        shortlistSheet.getRange(1, 20).setValue("Manual_Notes");
        shortlistSheet.getRange(1, 20).setFontWeight("bold");
      }

      shortlistSheet.getRange(2, 1, rows.length, 20).setValues(rows);
    }

    // ── Formatting ─────────────────────────────────────────
    // Color code by band
    if (rows.length) {
      rows.forEach((row, idx) => {
        const band      = String(row[16] || "");
        const rowNum    = idx + 2;
        const range     = shortlistSheet.getRange(rowNum, 1, 1, 20);

        if (band === "A") {
          range.setBackground("#d4edda"); // green
        } else if (band === "B") {
          range.setBackground("#cce5ff"); // blue
        } else if (band === "C") {
          range.setBackground("#fff3cd"); // yellow
        } else if (band === "MANUAL_REVIEW") {
          range.setBackground("#f8d7da"); // red/pink
        }
      });
    }

    // Auto-resize key columns
    shortlistSheet.autoResizeColumn(2);  // Company
    shortlistSheet.autoResizeColumn(8);  // C3 Evidence
    shortlistSheet.autoResizeColumn(19); // Verdict

    const scored       = rows.filter(r => r[16] !== "MANUAL_REVIEW").length;
    const manualReview = rows.filter(r => r[16] === "MANUAL_REVIEW").length;

    Logger.log(`[buildShortlist SUCCESS] ${scored} scored companies + ${manualReview} manual review`);
    Logger.log(`[buildShortlist] Band A: ${rows.filter(r => r[16] === "A").length}`);
    Logger.log(`[buildShortlist] Band B: ${rows.filter(r => r[16] === "B").length}`);
    Logger.log(`[buildShortlist] Band C: ${rows.filter(r => r[16] === "C").length}`);
    Logger.log(`[buildShortlist] Band D: ${rows.filter(r => r[16] === "D").length}`);
    Logger.log(`[buildShortlist] Manual Review: ${manualReview}`);

  } catch (err) {
    Logger.log(`[buildShortlist ERROR] ${err.message}`);
  }
}

// ============================================================
// SECTION 9 — STATUS HELPERS
// ============================================================

function isAlreadyScored(
  companyName
) {

  try {

    const ss =
      SpreadsheetApp.getActiveSpreadsheet();

    const sheet =
      ss.getSheetByName(
        SHEETS.SCORES
      );

    if (
      !sheet ||
      sheet.getLastRow() < 2
    ) {

      return false;
    }

    const data =
      sheet
        .getRange(
          2,
          1,
          sheet.getLastRow() - 1,
          1
        )
        .getValues();

    return data.some(
      row =>

        String(row[0])
          .trim()
          .toLowerCase()

        ===

        companyName
          .trim()
          .toLowerCase()
    );

  } catch (err) {

    Logger.log(
      `[isAlreadyScored ERROR] ${err.message}`
    );

    return false;
  }
}



function isAlreadyFiltered(
  companyName
) {

  try {

    const ss =
      SpreadsheetApp.getActiveSpreadsheet();

    const sheet =
      ss.getSheetByName(
        SHEETS.STAGE1
      );

    if (
      !sheet ||
      sheet.getLastRow() < 2
    ) {

      return false;
    }

    const data =
      sheet
        .getRange(
          2,
          1,
          sheet.getLastRow() - 1,
          1
        )
        .getValues();

    return data.some(
      row =>

        String(row[0])
          .trim()
          .toLowerCase()

        ===

        companyName
          .trim()
          .toLowerCase()
    );

  } catch (err) {

    Logger.log(
      `[isAlreadyFiltered ERROR] ${err.message}`
    );

    return false;
  }
}



// ============================================================
// SECTION 10 — GET STAGE1 STATUS
// ============================================================

function getStage1Status(
  companyName
) {

  try {

    const ss =
      SpreadsheetApp.getActiveSpreadsheet();

    const sheet =
      ss.getSheetByName(
        SHEETS.STAGE1
      );

    if (
      !sheet ||
      sheet.getLastRow() < 2
    ) {

      return null;
    }

    // NOW 11 COLUMNS (Revenue_Source added at col 9)
    const data =
      sheet
        .getRange(
          2,
          1,
          sheet.getLastRow() - 1,
          11
        )
        .getValues();

    for (const row of data) {

      if (

        String(row[0])
          .trim()
          .toLowerCase()

        ===

        companyName
          .trim()
          .toLowerCase()
      ) {

        return {

          revenueBand: {

            band: row[5],

            confidence: row[6],

            evidence: row[7],
          },
          manufacturerFlag: row[3],
          revenueSource: row[8],
          status: row[9],
          failReason: row[10],
        };
      }
    }

    return null;

  } catch (err) {

    Logger.log(
      `[getStage1Status ERROR] ${err.message}`
    );

    return null;
  }
}



// ============================================================
// SECTION 11 — TEST FUNCTION
// ============================================================

function testSheetManager() {

  Logger.log(
    `=== testSheetManager START ===`
  );

  try {

    setupSheets();

    const companies =
      getCompanies();

    Logger.log(
      `[Companies Loaded] ${companies.length}`
    );

    saveCheckpoint(0);

    Logger.log(
      `[Checkpoint Test] ${getCheckpoint()}`
    );

    Logger.log(
      `=== testSheetManager SUCCESS ===`
    );

  } catch (err) {

    Logger.log(
      `[testSheetManager ERROR] ${err.message}`
    );
  }
}