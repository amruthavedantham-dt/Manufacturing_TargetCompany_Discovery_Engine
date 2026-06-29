// ============================================================
// dsirMatcher.gs
// Cross-references any shortlist sheet against the DSIR R&D
// 2025 directory and writes results to a DSIR_MATCHES tab.
// ============================================================

const DSIR_SHEET_ID = "1hGbS1Rjynz6VZ5CNzjrWUXZmAm9Dvee-Vias4GlQZ4o";
const DSIR_TAB_NAME = "Companies";

// ── Column indices in any shortlist sheet (0-based) ─────────
const SL_COMPANY = 1;   // "Company Name"
const SL_WEBSITE = 2;   // "Website"
const SL_SCORE   = 15;  // "Final_Score"
const SL_BAND    = 16;  // "Band"

// ── Column indices in DSIR sheet (0-based) ──────────────────
const DSIR_RECOG = 1;   // "Recognition Number"
const DSIR_NAME  = 2;   // "Company Name"
const DSIR_STATE = 3;   // "State"
const DSIR_VALID = 4;   // "Valid Upto"


// ============================================================
// NORMALISE — strips legal suffixes + punctuation for matching
// ============================================================
function _normDSIR_(name) {
  return String(name)
    .toLowerCase()
    .replace(/[.\-,&()']/g, ' ')
    .replace(/\b(pvt|private|ltd|limited|co|corp|corporation|india|industries|inc|llp|the)\b/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}


// ============================================================
// SHARED CORE — called by both public functions
// ============================================================
function _runDsirMatch_(sourceSheetName, outputTabName) {
  const ss           = SpreadsheetApp.getActiveSpreadsheet();
  const sourceSheet  = ss.getSheetByName(sourceSheetName);

  if (!sourceSheet || sourceSheet.getLastRow() < 2) {
    SpreadsheetApp.getUi().alert(`"${sourceSheetName}" sheet is empty or missing.`);
    return;
  }

  // ── 1. Build DSIR lookup map ─────────────────────────────
  Logger.log(`[_runDsirMatch_] Opening DSIR sheet for "${sourceSheetName}"...`);
  const dsirSS    = SpreadsheetApp.openById(DSIR_SHEET_ID);
  const dsirSheet = dsirSS.getSheetByName(DSIR_TAB_NAME);
  if (!dsirSheet) throw new Error("DSIR 'Companies' tab not found.");

  const dsirData = dsirSheet
    .getRange(2, 1, dsirSheet.getLastRow() - 1, 5)
    .getValues();

  const dsirMap = new Map();
  dsirData.forEach(row => {
    const rawName = String(row[DSIR_NAME] || "").trim();
    if (!rawName) return;
    const key = _normDSIR_(rawName);
    if (!dsirMap.has(key)) {
      dsirMap.set(key, {
        recognitionNo: String(row[DSIR_RECOG] || "").trim(),
        companyName:   rawName,
        state:         String(row[DSIR_STATE] || "").trim(),
        validUpto:     String(row[DSIR_VALID]  || "").trim(),
      });
    }
  });

  Logger.log(`[_runDsirMatch_] DSIR map: ${dsirMap.size} entries`);

  // ── 2. Load source shortlist ─────────────────────────────
  const numRows = sourceSheet.getLastRow() - 1;
  const numCols = sourceSheet.getLastColumn();
  const slData  = sourceSheet.getRange(2, 1, numRows, numCols).getValues();

  // ── 3. Match ─────────────────────────────────────────────
  const outputRows = [];

  slData.forEach(row => {
    const company = String(row[SL_COMPANY] || "").trim();
    if (!company) return;

    const website = String(row[SL_WEBSITE] || "").trim();
    const band    = String(row[SL_BAND]    || "").trim();
    const score   = row[SL_SCORE];

    const normCompany = _normDSIR_(company);

    let match     = dsirMap.get(normCompany) || null;
    let matchType = match ? "Exact" : "";

    if (!match) {
      for (const [key, val] of dsirMap) {
        if (key.startsWith(normCompany) || normCompany.startsWith(key)) {
          match     = val;
          matchType = "Partial";
          break;
        }
      }
    }

    outputRows.push([
      company,
      website,
      band,
      score,
      match ? "YES" : "NO",
      match ? match.recognitionNo : "",
      match ? match.companyName   : "",
      match ? match.state         : "",
      match ? match.validUpto     : "",
      matchType,
    ]);
  });

  // ── 4. Write output tab ───────────────────────────────────
  let outSheet = ss.getSheetByName(outputTabName);
  if (outSheet) {
    outSheet.clearContents();
    outSheet.clearFormats();
  } else {
    outSheet = ss.insertSheet(outputTabName);
  }

  const headers = [
    "Company Name", "Website", "Band", "Final Score",
    "In DSIR?", "Recognition Number", "DSIR Company Name",
    "State", "Valid Upto", "Match Type",
  ];

  outSheet.getRange(1, 1, 1, headers.length).setValues([headers]);
  if (outputRows.length > 0) {
    outSheet.getRange(2, 1, outputRows.length, headers.length).setValues(outputRows);
  }

  // ── 5. Format ─────────────────────────────────────────────
  outSheet.getRange(1, 1, 1, headers.length).setFontWeight("bold");
  outSheet.setFrozenRows(1);

  for (let i = 0; i < outputRows.length; i++) {
    const color = outputRows[i][4] === "YES" ? "#d9ead3" : "#fce5cd";
    outSheet.getRange(i + 2, 1, 1, headers.length).setBackground(color);
  }

  SpreadsheetApp.flush();

  const matched = outputRows.filter(r => r[4] === "YES").length;
  const msg = `Done — ${matched} of ${outputRows.length} companies from "${sourceSheetName}" found in DSIR.`;
  Logger.log(`[_runDsirMatch_] ${msg}`);
  SpreadsheetApp.getActive().toast(msg, "DSIR Match Complete", 8);
}


// ============================================================
// PUBLIC ENTRY POINTS
// ============================================================
function matchShortlistToDSIR() {
  _runDsirMatch_(SHEETS.SHORTLIST, "DSIR_MATCHES");
}

function match540ShortlistToDSIR() {
  _runDsirMatch_("540_SHORTLIST", "DSIR_MATCHES_540");
}
