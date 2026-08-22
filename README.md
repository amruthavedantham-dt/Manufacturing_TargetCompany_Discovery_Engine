# Target Company Pipeline (Manufacturing ICP)

Ideal Customer Profile — Automated Research & Scoring System

## 1. What It Is — Objective

An automated system, built entirely in Google Apps Script, that turns a raw list of
Indian manufacturing companies into a ranked shortlist of the best sales prospects —
with no manual research per company. Each company runs through three qualification
gates, survivors are scored across six criteria, and the result is a banded (A–D)
shortlist with a written verdict the sales team can act on. Everything is logged in
Google Sheets so any automated decision can be reviewed or overridden.

**What it sets out to do:**
- Process hundreds of company names automatically, from a single input sheet.
- Filter out non-manufacturers, PE-acquired firms, and anything outside the 50–500 Cr
  revenue band.
- Score the qualifying companies on six commercial-attractiveness criteria (max 100).
- Classify each into bands A–D and output a ranked, auditable shortlist.

**Target:** Indian B2B manufacturers, 50–500 Cr annual revenue.
**Output:** Ranked shortlist with A/B/C/D bands and outreach verdicts.

## 2. Criteria

Companies that clear Stage 1 are scored on six criteria. The total (max 100) maps to
a band.

| Code | Criterion | Max | Method |
|---|---|---|---|
| C1 | Manufacturing | 10 | Stage 1 gate |
| C2 | India Based | 5 | Stage 1 gate |
| C3 | Differentiated | 25 | Gemini + keyword weights |
| C4 | Technical Decision Maker | 20 | Gemini + keyword overrides |
| C5 | Growing Sector | 20 | Deterministic keyword match |
| C6 | Growth Signals | 20 | Deterministic (keyword), Gemini for ambiguous |
| | **TOTAL** | **100** | |

**C3 (Differentiated)** rewards companies doing something niche or technical rather
than commodity work — patents, an R&D centre, regulatory approvals (USFDA, EU-GMP,
DSIR-recognised), "first / only / pioneer in India" claims, or proprietary products.

### Bands and the action each triggers

| Band | Score | Label | Action |
|---|---|---|---|
| A | 80–100 | Strong | Prioritise outreach immediately |
| B | 60–79 | Probable | Include in outreach campaign |
| C | 40–59 | Borderline | Low priority — revisit later |
| D | 0–39 | Not ICP | Remove from active pipeline |

## 3. Tools & Stack

- **Google Apps Script** — JavaScript runtime inside Google Workspace. No hosting
  cost. The 6-minute execution limit is handled by checkpointing.
- **Gemini 2.5 Flash** — AI inference for revenue inference, founder-name extraction,
  and technical/decision-maker classification. `thinkingBudget` is disabled on
  production calls to cut cost and latency.
- **Serper API** — structured Google Search results (titles, snippets, URLs) used as
  evidence about each company.
- **Google Sheets** — input list, working storage, logs, and the human-readable
  output.
- **API keys** are stored safely in Script Properties (`PropertiesService`), never
  hard-coded in the source.

## 4. Architecture

A Pipeline Orchestrator coordinates two phases — Stage 1 filtering, then scoring. The
whole pipeline is cache-first and checkpointed, so it resumes exactly where it stopped
after the 6-minute limit. A circuit breaker halts the run after N consecutive
failures, every action is written to a user-visible Event Log, and all API usage is
tracked in Token Logs for cost reporting.

### Flow

| Step | What happens |
|---|---|
| MASTER list | Raw company names, websites, sources |
| Stage 1 — Filtering | Gate 1 Revenue → Gate 2 Manufacturer → Gate 3 Acquired |
| PASS | 50–500 Cr manufacturers, not PE-acquired |
| Scoring (C3–C6) | Technical depth, decision-maker, sector, growth signals |
| SHORTLIST | Ranked A / B / C / D with verdicts |

### Cross-cutting services used throughout both phases

- **Caching** — every Serper call is cached by company + query type; re-runs reuse it
  at zero API cost.
- **Checkpointing** — a single counter in `PropertiesService` lets an interrupted run
  resume with no reprocessing.
- **Circuit breaker** — stops the run after N consecutive failures to avoid burning
  the quota on a broken state. Separate thresholds for Gemini (12) and Serper (8). A
  15-minute cooldown resets both.
- **Adaptive rate limiting** — request pacing adjusts dynamically to API responses.
  Sleep grows on 429/503 (backoff factor 1.5×), decays gradually on success (decay
  factor 0.95). Separate floors/ceilings for Gemini (4s–30s) and Serper (0.8s–10s).
- **Auto-run** — a self-managing GAS time trigger fires every 10 minutes and chains
  Stage 1 → Scoring automatically. Stage 1 completion flips a mode flag; scoring
  completion deletes the trigger.
- **Event Log + Token Logs** — a readable activity log per stage per company, plus
  separate token logs for all Gemini and Serper calls used for cost reporting.

## 5. Stages & Modules

### 5.1 Stage 1 — Filtering

Stage 1 trims the MASTER list down to the companies worth scoring. Each company runs
through three gates and must clear all three; the moment one fails, the FAIL and its
reason are recorded and the company stops there.

**Gate 1 — Revenue (50–500 Cr).** A three-level cascade that stops at the first level
to give an answer:
- **L1 — Direct:** a regex pulls an explicit crore/lakh/USD figure from finance
  sources (Tofler, Zauba, Screener, MoneyControl).
- **L2 — Heuristic:** if no figure is found, employee count is checked. Fewer than 50
  employees → auto-reject (<50Cr). 50 or more employees → routed to Gemini batch
  (employee count alone is not reliable enough to auto-pass).
- **L3 — Gemini:** still-ambiguous companies are batched together and inferred by
  Gemini.

Both the direct figure (`Revenue_Direct`) and the Gemini result (`Revenue_Gemini`) are
written to the Event Log, so a reviewer can see exactly how the band was decided.

**Gate 2 — Manufacturer.** Passes on clear manufacturing signals (plant, factory,
production, GMP, API manufacturing); fails on service-only or CRO signals.

**Gate 3 — Acquired.** Fails on private-equity or acquisition signals ("acquired by",
majority stake, private equity, or a named PE firm).

Two extra rules keep the stage honest:
- Companies that are ambiguous but clearly not tiny are marked `MANUAL_REVIEW`
  instead of `FAIL`, so legitimate firms with no online financials still surface.
- A batch failures summary is written at the end of the run, grouping every FAIL by
  reason.

### 5.2 Scoring (C1–C6)

C1 (Manufacturing) and C2 (India-based) are confirmed during Stage 1. C3–C6 are then
scored from the evidence already gathered.

- **C3 — Differentiated (0–25).** Searches for R&D signals (patents, DSIR,
  proprietary products, pioneer claims), sends the snippets to Gemini to confirm
  which are present, then applies weighted scoring.
- **C4 — Technical Decision-Maker (0–20).** Finds the founder/MD name via a
  three-step lookup (Tofler → Zauba → general search), then checks their background
  (IIT, PhD, DRDO, etc.) through Gemini. Strong credentials score full marks.
- **C5 — Growing Sector (0–20).** No AI and no API calls — keyword-matches Stage 1
  cached snippets against a sector list (pharma, EV, specialty chemicals, etc.) and
  returns the highest matching sector score. Stage 1 snippet text is passed straight
  into `runC5()`.
- **C6 — Growth Signals (0–20).** One Serper call plus cached snippets, looking for
  hiring, facility expansion, new certifications, and export growth. Deterministic
  keyword scan runs first — if 2 or more signals are found, the score is returned
  immediately with no AI cost. If fewer than 2 signals are found deterministically,
  Gemini is called to check for signals the keyword scan may have missed; both
  results are merged and the union is scored.

### 5.3 Shortlist & Bands

- Sums all six scores, maps to a band (A–D), and writes the SHORTLIST sheet in
  descending order with colour-coded rows and a notes column for reviewers.
- Only companies scoring Band B or above (60+) appear as ranked entries.
- `MANUAL_REVIEW` companies — those that never reached scoring because their revenue
  was ambiguous — are appended at the bottom of the SHORTLIST in pink, flagged for
  human decision, with their fail reason in the Verdict column.

#### EST_MISTAKE — Orange Highlights in SHORTLIST

**Why it exists:** During manual review of completed pipeline runs, it was found that
~47% of heuristic-passed companies and ~39% of signals-passed companies had incorrect
revenue classifications — they were placed in the shortlist but did not actually meet
the 50–500 Cr ICP criteria. These false positives are tracked in a separate
`EST_MISTAKE` sheet for visibility, and marked in the SHORTLIST so reviewers can
identify them at a glance.

**What it does:** Companies listed in `EST_MISTAKE` are highlighted orange
(`#ffe0b2`) in the SHORTLIST sheet. The `Manual_Notes` column (col 20) is tagged with
the source of the error:

| Tag | Meaning |
|---|---|
| Signals Est Mistake | Revenue was estimated from general web signal snippets; the regex matched a number that belonged to a different entity or a different context within the snippet text |
| Estimation Mistake | Revenue was inferred from employee count (≥200 employees assumed to imply 50–500 Cr); this is unreliable for traders, distributors, and services firms |

**Where it runs:** Applied automatically at the end of every "Build Shortlist" run via
`markEstMistakeInShortlist()`. Also safe to run standalone from the menu. The function
looks up the `Company Name` and `Revenue_Source` columns in the `EST_MISTAKE` sheet,
matches against column 2 of SHORTLIST (case-insensitive), and re-applies marks cleanly
— previous tags are stripped before re-writing, so re-runs do not double-tag.

**Fix applied (June 2026):** Both estimation paths are now restricted. The heuristic
path (`employeeHeuristic()` in `revenue.js`) returns a band only for counts below 50
(auto-rejects as <50Cr); any count of 50 or above returns `null` and is routed to the
Gemini batch for validation. The signals path is similarly restricted so that any
mid-band result from snippet regex matching is rerouted to Gemini rather than
auto-passing. This reduces but does not fully eliminate estimation errors, as Gemini
itself can mis-classify — the `EST_MISTAKE` review process remains active.

### 5.4 Reporting

- **Cost Summary** — reads the Token Logs and writes per-run and per-stage totals
  (Gemini input/output/thinking tokens and Serper call counts, converted to INR) into
  a summary view, triggered from the custom menu via "Show Cost Summary."
- **Pipeline Summary** — a live funnel dashboard (`PIPELINE_SUMMARY` sheet) showing
  aggregate counts at every gate and band distribution. Rebuilt automatically every 25
  companies during Stage 1, every 10 companies during scoring, and at every clean
  exit (time limit, circuit breaker, or completion). Also available as "Refresh
  Pipeline Summary" in the menu.
- **Company Summary (Not Yet Built)** — a planned per-company summary card
  auto-written for each shortlisted company. Not currently implemented.

## 6. Code Files

Logic is split across small, single-purpose files — each one owns a single job, which
keeps the system easy to navigate and change.

### Core pipeline files

| File | What it does |
|---|---|
| `config.js` | Central config — all constants live here: API keys, revenue bands, Stage 1 keyword lists, C3–C6 scoring weights, Serper query templates, circuit breaker thresholds, adaptive rate limits, band labels (A/B/C/D). Nothing else defines its own constants. |
| `SheetIO.js` | Sheet-name constants and column-index maps only. One place to look up what each tab is called and which column maps to which field. |
| `sheetManager.js` | All read/write operations on the spreadsheet — creates tabs, reads MASTER companies, writes Stage 1 results, reads/writes the cache, writes scores, builds and formats the SHORTLIST, and runs `markEstMistakeInShortlist()`. |
| `main.js` | The orchestrator. Runs the pipeline end-to-end: reads companies from MASTER, calls Stage 1, then hands passing companies to scoring (C3–C6). Manages time limits, the pending queue, and checkpointing so runs resume after Google's 6-minute execution cutoff. Also drains any leftover `PENDING_REVENUE` rows from crashed prior runs at the top of each new run. |
| `pipeline.js` | Per-company Stage 1 logic. Runs the three gates in sequence — manufacturer check → PE/acquired check → revenue check — and returns a result object. No sheet writes, no batch management. |
| `revenue.js` | Revenue-specific logic. Makes two Serper calls (direct revenue sites + general signals), tries to extract a crore figure via regex, falls back to employee heuristic for rejection only, and queues ambiguous cases for a Gemini batch call. |
| `ai.js` | All external API calls — Serper search and Gemini inference. Handles adaptive rate limiting, retries with exponential backoff, and cache integration (checks `SEARCH_CACHE` before hitting Serper). No scoring, no sheet logic. |
| `prompts.js` | Gemini prompt strings only: revenue batch prompt, revenue single prompt, C3 prompt, C4 name-resolution prompt, C4 depth prompt, and C6 prompt. No logic — just the text templates. |

### Scoring files

| File | What it does |
|---|---|
| `c3.js` | C3 scorer — Technical Differentiation. Searches for R&D signals (patents, DSIR, proprietary products), sends snippets to Gemini to identify which are present, then applies weighted scoring. Score: 0–25. |
| `c4.js` | C4 scorer — Technical Decision-Maker. Finds the founder/MD name via a 3-gate lookup (Tofler → Zauba → general search), then checks their background (IIT/PhD/DRDO, etc.) via Gemini. Includes direct HTML scraping of Tofler and Zauba pages and regex extraction from snippet text to avoid Gemini calls where possible. Score: 0–20. |
| `c5.js` | C5 scorer — Growing Sector. Zero AI, zero API calls. Keyword-matches Stage 1 cached snippets against a priority-ordered sector list (pharma, EV, specialty chemicals, etc.) and returns the highest matching sector score. Score: 2–20. |
| `c6.js` | C6 scorer — Growth Signals. One Serper call plus cached snippets. Deterministic keyword scan first — scores immediately if 2+ signals found. Calls Gemini only when the deterministic result is ambiguous (fewer than 2 signals). Merges both results. Score: 0–20. |

### Orchestration and resilience files

| File | What it does |
|---|---|
| `Menu.js` | Owns `onOpen()` and all custom menu item definitions. Creates the "ICP Pipeline" menu when the spreadsheet is opened. |
| `AutoRun.js` | Self-managing GAS time trigger that chains Stage 1 → Scoring automatically. "Start Overnight Run" creates a 10-minute recurring trigger and sets the initial mode; "Stop Auto-Run" destroys it. Scoring completion self-destructs the trigger. |
| `CircuitBreaker.js` | Tracks consecutive Gemini and Serper failures independently. Halts the pipeline after hitting the configured threshold. Resets after a 15-minute cooldown. |
| `batchFailures.js` | Error accumulator. Collects company-level failures during a run into Script Properties, then surfaces them as an HTML popup dialog via the "Show Batch Failures" menu item. |
| `EventLog.js` | Structured run log. Appends one row per stage per company to an `EVENT_LOG` sheet with timestamp, run ID, stage, level (INFO/WARN/ERROR), and a message. Never throws — purely observability. |

### Reporting files

| File | What it does |
|---|---|
| `TokenLog.js` | Appends one row per Gemini or Serper API call to the `TOKEN_LOG` sheet, recording model, token counts (input/output/thinking), and call context. Used as the data source for CostSummary. |
| `CostSummary.js` | Reads the `TOKEN_LOG` sheet and computes per-run and per-stage cost totals in USD and INR. Triggered from "Show Cost Summary" in the menu. |
| `PipelineSummary.js` | Builds a live funnel dashboard in the `PIPELINE_SUMMARY` sheet: total companies, processed, gate pass/fail counts, band distribution, percent complete. Auto-rebuilt at regular intervals and on every clean exit. |

### DSIR integration files

Implements the DSIR future-source integration flagged in [§7.2](#72-future-sources) —
cross-referencing shortlisted companies against the government-published in-house R&D
directory, outside the PDF's original file table.

| File | What it does |
|---|---|
| `dsir_extractor.py` | One-time offline script (not Apps Script). Parses `DSIR R&D 2025.pdf` table-by-table with PyMuPDF, extracts company name / recognition number / state / valid-upto per row, and writes them to a new Google Sheet ("DSIR R&D 2025 - Company List") via `gspread`. Needs `credentials.json` (Google Cloud OAuth client) and produces `token.json` on first run. Its own trailing print statement references a `dsir_website_lookup.py` "next step" to fill in the Website column — that script is not present in this repo. |
| `dsirMatcher.js` | Apps Script cross-reference tool. `matchShortlistToDSIR()` / `match540ShortlistToDSIR()` read the `SHORTLIST` (or `540_SHORTLIST`) sheet, normalize company names (strips legal suffixes like Pvt/Ltd/Inc), and match them against the DSIR sheet produced by `dsir_extractor.py` (hardcoded `DSIR_SHEET_ID`). Writes a `DSIR_MATCHES` (or `DSIR_MATCHES_540`) tab with match status, recognition number, state, and match type (Exact/Partial), color-coded green/orange. Not yet wired into C3 scoring — the PDF's suggestion to "pre-tag companies so C3 can credit DSIR automatically" is not implemented; this is a standalone lookup tool run manually from the menu. |

`all_code_combined.js` in this folder is a flattened concatenation of every other
`.js` file above (for pasting into a single Apps Script editor tab or external
review) — not a separate module, so it's excluded from the tables above.

### Maintenance files

| File | What it does |
|---|---|
| `Cleanup.js` | Recovery tool for the Serper API credit outage incident. Identifies false-FAIL rows (Stage 1 FAILs caused by the API never running, not by genuine bad data), deletes them from `STAGE1_RESULTS`, clears their cache entries, and rolls the checkpoint back so they are reprocessed. Has a safe dry-run mode — run with no arguments first to log what would change before committing. |
| `DiagnoseCorruption.js` | Read-only diagnostic for `STAGE1_RESULTS` column-shift corruption. Does not modify any data. Writes findings to a `CORRUPTION_REPORT` sheet showing the exact shift pattern with real cell values. |
| `RepairCorruption.js` | Applies fixes identified by `DiagnoseCorruption` — realigns column-shifted rows in `STAGE1_RESULTS`. |

### Mental model

`main.js` drives the run → `pipeline.js` handles Stage 1 per company → `revenue.js`
handles the revenue sub-problem → `c3–c6.js` each own one scoring dimension →
`ai.js` is the only file that touches external APIs → `sheetManager.js` is the only
file that touches the spreadsheet → `config.js`, `SheetIO.js`, and `prompts.js` are
pure data/constants → `EventLog.js`, `TokenLog.js`, and `batchFailures.js` are
observability only → `AutoRun.js` and `CircuitBreaker.js` are resilience
infrastructure → `Menu.js` is the entry point for all human-triggered actions →
`Cleanup.js`, `DiagnoseCorruption.js`, and `RepairCorruption.js` are maintenance
tools used on-demand.

## 7. Sources

The MASTER sheet is populated before the pipeline runs. Company names and websites are
extracted from external directories, websites are validated, and duplicates across and
within sources are removed. Each row carries a `Source` tag in column 3 that records
which directory it came from. The pipeline code reads this column and passes it
through to all output sheets as a tracking field — source name does not affect gate
logic or scoring.

### 7.1 Current Sources

| Source | Full Name | Type |
|---|---|---|
| Chemexcil | Chemicals Export Promotion Council of India | Member directory — dyes, specialty chemicals, inorganic chemicals exporters |
| Pharmexcil | Pharmaceuticals Export Promotion Council of India | Member directory — API, drug intermediates, formulation exporters |
| EEPC | Engineering Export Promotion Council of India | Member directory — engineering goods, precision parts, machinery exporters |
| PLEXCONCIL | Plastics Export Promotion Council | Member directory — polymer products, rubber goods, plastic components exporters |
| IMTMA | Indian Machine Tool Manufacturers' Association | Member directory — machine tool and industrial equipment manufacturers |
| IMTEX 2025 | Indian Machine Tool Exhibition 2025 | Exhibitor list — machine tools, precision engineering, automation companies |

**Process applied to each source:**
1. Company names and websites extracted from the published member/exhibitor
   directory.
2. Websites verified as reachable (dead links removed).
3. Duplicates removed across sources (same company appearing in multiple directories
   kept once, with the primary source tagged).
4. Rows appended to the MASTER sheet with `Company Name`, `Website`, `Source`.

### 7.2 Future Sources

The following sources are identified for future ingestion. The same extraction,
validation, and deduplication process applies.

| Source | Full Name | Type | Notes |
|---|---|---|---|
| AEPC | Apparel Export Promotion Council | Member directory — garment and apparel exporters | Textile sector; will score as Textile — commodity (C5: 12) |
| IPCA | Indian Pharmaceutical Congress Association | Conference participants — pharma companies | Pharma sector; covered by C5 Pharma & API (score: 20) |
| IPA | Indian Pharmaceutical Alliance | Member directory — branded pharma companies | Members may skew large (>500 Cr); verify revenue range before bulk ingestion as many may fail Gate 1 |
| IDMA | Indian Drug Manufacturers' Association | Member directory — generic drug manufacturers | Good fit for 50–500 Cr range; pharma sector (C5: 20) |
| 2025 Directory of Recognised In-House R&D Units | DSIR — Department of Scientific & Industrial Research | Government-published list of companies with recognised in-house R&D | Companies in this directory are government-verified as having in-house R&D. DSIR recognition is a Strong signal (weight +2) in C3 scoring. Consider pre-tagging these companies so C3 can credit DSIR automatically without an API call. |

---
*Document version 2 — Updated June 2026*

## GitHub

[amruthavedantham-dt/Manufacturing_TargetCompany_Discovery_Engine](https://github.com/amruthavedantham-dt/Manufacturing_TargetCompany_Discovery_Engine)
