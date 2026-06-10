// ============================================================
// SheetIO.gs — Sheet names and column indices for the pipeline
// All sheet I/O structure lives here. config.gs holds no
// sheet references — look here first for any sheet constant.
// ============================================================

// ----------------------------------------------------------
// SHEET NAMES
// Keys map to the actual tab names in the spreadsheet.
// ----------------------------------------------------------
const SHEETS = {
  MASTER:    "MASTER",
  STAGE1:    "STAGE1_RESULTS",
  CACHE:     "SEARCH_CACHE",
  SCORES:    "SCORES",
  SHORTLIST: "SHORTLIST",
};


// ----------------------------------------------------------
// MASTER SHEET COLUMNS
// Zero-based column indices for the MASTER input sheet.
// ----------------------------------------------------------
const MASTER_COLS = {
  COMPANY: 0,
  WEBSITE: 1,
  SOURCE:  2,
};
