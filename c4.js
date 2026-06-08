// ============================================================
// c4.gs — C4 Technical Decision-Maker Scoring
// Flow: Gate1(Tofler scrape) → Gate2(Zauba scrape) → Gate3(General+Gemini)
// Serper: 1–3 calls  |  Gemini: 0–1 calls (name) + 0–1 calls (depth)
// ============================================================


// ============================================================
// SECTION 1 — MASTER FUNCTION
// ============================================================

function runC4(companyObj) {
  const company = companyObj.company;
  Logger.log(`\nC4: starting for "${company}"`);

  // ── Gated DM name resolution ──────────────────────────────
  const nameResult = c4_getNameGated(company);
  const dmName     = nameResult.name;

  Logger.log(`C4: DM name="${dmName}" | source="${nameResult.source}" | failReason="${nameResult.failReason || "ok"}"`);

  if (dmName === "Unknown") {
    return {
      c4: 0, c4DmName: "Unknown",
      c4Background: `Name not found: ${nameResult.failReason}`,
      c4Confidence: "Low", manualReview: true,
      c4FailReason: nameResult.failReason,
    };
  }

  // ── Serper: targeted background search ───────────────────
  let bgSnippets = c4_searchPersonBackground(dmName, company);
  if (!bgSnippets || bgSnippets.trim().length <= 50) {
    Logger.log(`C4: no background snippets for "${dmName}"`);
    bgSnippets = "";
  } else {
    Logger.log(`C4: background snippets found (${bgSnippets.length} chars)`);
  }

  // ── Deterministic check — skip Gemini if strong keyword ──
  if (bgSnippets) {
    const bgLower   = bgSnippets.toLowerCase();
    const strongHit = CONFIG.C4.STRONG_SIGNALS.find(kw => bgLower.includes(kw.toLowerCase()));
    if (strongHit) {
      Logger.log(`C4: deterministic Strong (keyword: "${strongHit}") — skipping Gemini depth call`);
      return {
        c4: CONFIG.C4.SCORE_MAP["Strong"], c4DmName: dmName,
        c4Background: `Strong | keyword: "${strongHit}"`,
        c4Confidence: "High", manualReview: false,
      };
    }
  }

  // ── Gemini: depth classification ─────────────────────────
  const evidenceForDepth = bgSnippets.trim().length > 50 ? bgSnippets : nameResult.allSnippets;
  const depthPrompt      = buildPrompt("C4_DEPTH", company, evidenceForDepth);
  const depthRaw         = callGeminiWithRetry(depthPrompt);

  if (!depthRaw) {
    Logger.log(`C4: Gemini depth null for "${company}"`);
    const allLower    = (nameResult.allSnippets + " " + bgSnippets).toLowerCase();
    const strongHit   = CONFIG.C4.STRONG_SIGNALS.find(kw => allLower.includes(kw.toLowerCase()));
    const moderateHit = CONFIG.C4.MODERATE_SIGNALS.find(kw => allLower.includes(kw.toLowerCase()));
    return c4_deterministicFallback(company, dmName, strongHit, moderateHit, true);
  }

  const depthParsed = parseGeminiJSON(depthRaw);
  if (!depthParsed) {
    Logger.log(`C4: depth parse fail for "${company}"`);
    return c4_deterministicFallback(company, dmName, null, null, true);
  }

  let depth = String(depthParsed.depth || "None").trim();

  // ── Deterministic override on all accumulated evidence ────
  const allLower    = (nameResult.allSnippets + " " + bgSnippets).toLowerCase();
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
// SECTION 2 — GATED NAME RESOLUTION
// Each gate accumulates snippets into a shared buffer.
// Scraping is attempted before Gemini in Gates 1 & 2.
// Gate 3 sends the full buffer to Gemini as a last resort.
// Returns: { name, designation, source, allSnippets, failReason }
// ============================================================

function c4_getNameGated(company) {
  const buf = [];   // snippet accumulator — fed to Gemini in Gate 3

  // ── Gate 1: Tofler ────────────────────────────────────────
  Logger.log(`C4 Gate1: Tofler — "${company}"`);
  const toflerSnippets = callSerper(company, "C4_TOFLER");

  if (toflerSnippets && toflerSnippets.length > 30) {
    buf.push(toflerSnippets);

    // Fast path: name already in snippet text
    const fromSnippet = c4_extractNameFromSnippets(toflerSnippets, company);
    if (fromSnippet !== "Unknown") {
      Logger.log(`C4 Gate1: name in Tofler snippet: "${fromSnippet}"`);
      return { name: fromSnippet, designation: "", source: "tofler_snippet", allSnippets: toflerSnippets, failReason: null };
    }

    // Slow path: fetch and scrape the actual Tofler page
    const toflerUrl = c4_extractUrl(toflerSnippets, "tofler.in");
    if (toflerUrl) {
      const scraped = c4_scrapePage(toflerUrl);
      if (scraped) {
        Logger.log(`C4 Gate1: Tofler scrape → "${scraped.name}"`);
        return { name: scraped.name, designation: scraped.designation, source: "tofler_scrape", allSnippets: toflerSnippets, failReason: null };
      }
      Logger.log(`C4 Gate1: Tofler page scrape returned nothing`);
    } else {
      Logger.log(`C4 Gate1: no Tofler URL in snippets`);
    }
  } else {
    Logger.log(`C4 Gate1: no Tofler results`);
  }

  // ── Gate 2: Zauba ─────────────────────────────────────────
  Logger.log(`C4 Gate2: Zauba — "${company}"`);
  const zaubaSnippets = callSerper(company, "C4_ZAUBA");

  if (zaubaSnippets && zaubaSnippets.length > 30) {
    buf.push(zaubaSnippets);

    const fromSnippet = c4_extractNameFromSnippets(zaubaSnippets, company);
    if (fromSnippet !== "Unknown") {
      Logger.log(`C4 Gate2: name in Zauba snippet: "${fromSnippet}"`);
      return { name: fromSnippet, designation: "", source: "zauba_snippet", allSnippets: buf.join("\n\n---\n\n"), failReason: null };
    }

    const zaubaUrl = c4_extractUrl(zaubaSnippets, "zaubacorp.com");
    if (zaubaUrl) {
      const scraped = c4_scrapePage(zaubaUrl);
      if (scraped) {
        Logger.log(`C4 Gate2: Zauba scrape → "${scraped.name}"`);
        return { name: scraped.name, designation: scraped.designation, source: "zauba_scrape", allSnippets: buf.join("\n\n---\n\n"), failReason: null };
      }
      Logger.log(`C4 Gate2: Zauba page scrape returned nothing (likely paywall)`);
    } else {
      Logger.log(`C4 Gate2: no Zauba URL in snippets`);
    }
  } else {
    Logger.log(`C4 Gate2: no Zauba results`);
  }

  // ── Gate 3: General query → snippet regex → Gemini ────────
  Logger.log(`C4 Gate3: general query — "${company}"`);
  const generalSnippets = callSerper(company, "C4_GENERAL");
  if (generalSnippets && generalSnippets.length > 30) buf.push(generalSnippets);

  const allSnippets = buf.join("\n\n---\n\n");

  if (allSnippets.length < 50) {
    Logger.log(`C4 Gate3: no snippets from any gate`);
    return { name: "Unknown", designation: "", source: "none", allSnippets: "", failReason: "no_snippets" };
  }

  // Try regex on the full accumulated buffer before spending a Gemini call
  const fromSnippet = c4_extractNameFromSnippets(allSnippets, company);
  if (fromSnippet !== "Unknown") {
    Logger.log(`C4 Gate3: name found in snippets (no Gemini needed): "${fromSnippet}"`);
    return { name: fromSnippet, designation: "", source: "general_snippet", allSnippets, failReason: null };
  }

  Logger.log(`C4 Gate3: sending ${allSnippets.length} chars to Gemini`);
  const namePrompt = buildPrompt("C4_NAME", company, allSnippets);
  const nameRaw    = callGeminiWithRetry(namePrompt);

  if (!nameRaw) {
    return { name: "Unknown", designation: "", source: "gemini", allSnippets, failReason: "gemini_null" };
  }

  const nameParsed = parseGeminiJSON(nameRaw);
  if (!nameParsed) {
    return { name: "Unknown", designation: "", source: "gemini", allSnippets, failReason: "gemini_parse_fail" };
  }

  const dmName = String(nameParsed.name || "Unknown").trim();
  if (!dmName || dmName === "Unknown" || dmName.toLowerCase() === "null") {
    return { name: "Unknown", designation: "", source: "gemini", allSnippets, failReason: "gemini_unknown" };
  }

  Logger.log(`C4 Gate3: Gemini → "${dmName}"`);
  return { name: dmName, designation: nameParsed.designation || "", source: "gemini", allSnippets, failReason: null };
}


// ============================================================
// SECTION 3 — URL EXTRACTOR
// Pulls the first matching URL for a given domain from the
// snippet text produced by buildSnippetText() ("LINK: url").
// ============================================================

function c4_extractUrl(snippets, domain) {
  const escaped = domain.replace(/\./g, '\\.');
  const re      = new RegExp('LINK:\\s*(https?:\\/\\/(?:www\\.)?' + escaped + '\\/[^\\s\\n]+)', 'i');
  const m       = snippets.match(re);
  return m ? m[1].trim() : null;
}


// ============================================================
// SECTION 4 — PAGE SCRAPER
// Fetches a Tofler or Zauba URL and delegates to the parser.
// Returns { name, designation } or null.
// ============================================================

function c4_scrapePage(url) {
  Logger.log(`C4 scrape: fetching ${url}`);
  try {
    const response = UrlFetchApp.fetch(url, {
      muteHttpExceptions: true,
      followRedirects:    true,
      headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120 Safari/537.36' },
    });

    const code = response.getResponseCode();
    if (code !== 200) {
      Logger.log(`C4 scrape: HTTP ${code} for ${url}`);
      return null;
    }

    const html = response.getContentText();
    if (!html || html.length < 500) return null;

    if (/get pro|subscribe|unlock|sign up to view|login to view|please login/i.test(html)) {
      Logger.log(`C4 scrape: paywall detected at ${url}`);
      return null;
    }

    return c4_parseDirectorFromHtml(html);

  } catch(e) {
    Logger.log(`C4 scrape error: ${e.message}`);
    return null;
  }
}


// ============================================================
// SECTION 5 — JSON-LD PARSER
// Tofler and other modern pages embed structured data.
// This is the most reliable extraction path when present.
// ============================================================

function c4_parseFromJsonLd(html) {
  const re = /<script[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi;
  const seniorTitles = ['managing director', 'chairman', 'founder', 'ceo', 'md', 'proprietor', 'promoter'];
  let m;

  while ((m = re.exec(html)) !== null) {
    try {
      const data  = JSON.parse(m[1]);
      const items = Array.isArray(data) ? data : [data];

      for (const item of items) {
        if (!item || typeof item !== 'object') continue;

        for (const field of ['employee', 'founder', 'member', 'director']) {
          const persons = [].concat(item[field] || []);
          if (!persons.length) continue;

          // Try to find the most senior title first
          for (const tp of seniorTitles) {
            const found = persons.find(p => p && String(p.jobTitle || '').toLowerCase().includes(tp));
            if (found && found.name && c4_isValidName(String(found.name))) {
              return { name: String(found.name).trim(), designation: found.jobTitle || tp };
            }
          }

          // Fall back to first person with a valid name
          for (const person of persons) {
            const name = String(person?.name || '').trim();
            if (name && c4_isValidName(name)) {
              return { name, designation: person.jobTitle || '' };
            }
          }
        }
      }
    } catch(e) {}
  }
  return null;
}


// ============================================================
// SECTION 6 — HTML DIRECTOR PARSER
// Strips tags to plain text, then searches for title+name pairs.
// Tofler/MCA use ALL CAPS for names; general pages use Title Case.
// Priority: Managing Director > Chairman > Founder > CEO > Proprietor > Director
// ============================================================

function c4_parseDirectorFromHtml(html) {
  // Try structured data first — most reliable
  const ldResult = c4_parseFromJsonLd(html);
  if (ldResult) return ldResult;

  // Strip scripts, styles, and HTML tags to get readable text
  const text = html
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&amp;/g, '&').replace(/&nbsp;/g, ' ').replace(/&#\d+;/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

  const titlePairs = [
    { label: "Managing Director", re: /managing\s+director/i },
    { label: "MD",                re: /\bmd\b/i              },
    { label: "Chairman",          re: /chairman/i            },
    { label: "Founder",           re: /founder/i             },
    { label: "Promoter",          re: /promoter/i            },
    { label: "CEO",               re: /\bceo\b/i             },
    { label: "Proprietor",        re: /proprietor/i          },
    { label: "Director",          re: /director/i            },
  ];

  for (const { label, re } of titlePairs) {
    const idx = text.search(re);
    if (idx === -1) continue;

    // 120-char window either side of the title keyword
    const window = text.substring(Math.max(0, idx - 120), Math.min(text.length, idx + 120));

    // Pattern A: ALL CAPS name — Tofler/MCA format (e.g. "RAJESH KUMAR SHARMA")
    const allCapsMatch = window.match(/\b([A-Z][A-Z]+(?:\s[A-Z][A-Z]+){1,3})\b/);
    if (allCapsMatch) {
      const name = allCapsMatch[1].trim();
      if (c4_isValidName(name)) return { name: c4_toTitleCase(name), designation: label };
    }

    // Pattern B: Title Case name — general web pages
    const titleCaseMatch = window.match(/\b([A-Z][a-z]{1,}(?:\s[A-Z][a-z]{1,}){1,3})\b/);
    if (titleCaseMatch) {
      const name = titleCaseMatch[1].trim();
      if (c4_isValidName(name)) return { name, designation: label };
    }
  }

  return null;
}


// ============================================================
// SECTION 7 — NAME HELPERS
// ============================================================

function c4_isValidName(name) {
  if (!name || name.length < 5 || name.length > 50) return false;

  const upper = name.toUpperCase().trim();
  const stopWords = [
    'INDIA', 'LIMITED', 'PRIVATE', 'COMPANY', 'CORPORATION', 'DIRECTOR',
    'MANAGING', 'SHAREHOLDER', 'PROMOTER', 'CHAIRMAN', 'FOUNDER', 'PROPRIETOR',
    'OFFICER', 'EXECUTIVE', 'PARTNER', 'TRUSTEE', 'MEMBER', 'SECRETARY',
    'AUTHORIZED', 'REGISTERED', 'CORPORATE', 'BUSINESS', 'SERVICES',
    'INDUSTRIES', 'ENTERPRISE', 'TRADING', 'EXPORTS', 'IMPORTS', 'SOLUTIONS',
  ];

  for (const s of stopWords) {
    if (upper === s || upper.startsWith(s + ' ') || upper.endsWith(' ' + s)) return false;
  }

  // Require at least 2 words, each 2+ characters
  const words = upper.trim().split(/\s+/);
  return words.length >= 2 && words.every(w => w.length >= 2);
}

function c4_toTitleCase(allCapsName) {
  return allCapsName
    .toLowerCase()
    .replace(/\b([a-z])/g, c => c.toUpperCase());
}


// ============================================================
// SECTION 8 — SNIPPET-BASED NAME EXTRACTOR
// Runs before page scraping as a fast/free first attempt.
// Handles both Title Case (LinkedIn) and ALL CAPS (Tofler/MCA).
// ============================================================

function c4_extractNameFromSnippets(snippets, company) {
  const companyFirstWord = company.toLowerCase().split(" ")[0];

  function tryName(raw) {
    if (!raw) return null;
    raw = raw.trim();
    // Cross-line captures are never valid names
    if (raw.includes('\n') || raw.includes('\r')) return null;
    // First char must be strictly A-Z — the 'i' flag makes [A-Z] match lowercase too,
    // so this guard is the only thing that stops "page SNIPPET" from being accepted
    const code = raw.charCodeAt(0);
    if (code < 65 || code > 90) return null;
    const name = (raw === raw.toUpperCase() && raw.includes(' ')) ? c4_toTitleCase(raw) : raw;
    if (name.length > 3 && !name.toLowerCase().includes(companyFirstWord) && c4_isValidName(name)) {
      return name;
    }
    return null;
  }

  // Pattern 1 — title before name: "MD: Rajesh Kumar" / "Director - RAJESH KUMAR"
  const p1 = /(?:managing director|md|founder|promoter|chairman|ceo|proprietor|partner|director)\s*[:\-·|]\s*([A-Z][a-z]+(?:\s[A-Z][a-z]+){1,3})/gi;
  // Pattern 2 — name before title with -, ·, ,, | separators (LinkedIn: "Sanjeev Fogla - Managing Director")
  const p2 = /([A-Z][a-z]+(?:\s[A-Z][a-z]+){1,3})\s*[-,·|@]\s*(?:managing director|md|founder|promoter|chairman|ceo|proprietor|director)/gi;
  // Pattern 3 — ALL CAPS name before title (MCA/Tofler format)
  const p3 = /([A-Z]{2,}(?:\s[A-Z]{2,}){1,3})\s*[-·|,]\s*(?:MANAGING DIRECTOR|MD|FOUNDER|PROMOTER|CHAIRMAN|CEO|PROPRIETOR|DIRECTOR)/g;
  // Pattern 4 — ALL CAPS name after title
  const p4 = /(?:managing director|md|founder|promoter|chairman|ceo|proprietor|director)\s*[:\-·|\s]\s*([A-Z]{2,}(?:\s[A-Z]{2,}){1,3})/gi;
  // Pattern 5 — "Name is the Proprietor/Founder/MD of..." (FAQ / IndiaMART format)
  const p5 = /([A-Z][a-z]+(?:\s[A-Z][a-z]+){1,3})\s+is\s+the\s+(?:proprietor|founder|md|managing director|ceo|chairman)/gi;
  // Pattern 6 — Tofler director page URL slug: tofler.in/first-last-name/director
  const p6 = /tofler\.in\/([a-z]+(?:-[a-z]+){1,4})\/director/gi;

  for (const pattern of [p1, p2, p3, p4, p5]) {
    pattern.lastIndex = 0;
    const match = pattern.exec(snippets);
    if (!match) continue;
    const result = tryName(match[1] || match[2] || "");
    if (result) return result;
  }

  // Tofler URL slug — convert "pratik-patel" → "Pratik Patel"
  p6.lastIndex = 0;
  const urlMatch = p6.exec(snippets);
  if (urlMatch) {
    const fromSlug = urlMatch[1]
      .split('-')
      .map(w => w.charAt(0).toUpperCase() + w.slice(1))
      .join(' ');
    const result = tryName(fromSlug);
    if (result) return result;
  }

  // Zauba director page title: "TITLE: PRATYUSH CHOUDHARY | ZaubaCorp"
  // Name and designation are on separate lines, so cross-line patterns can't catch this.
  // Read the name directly from the structured title format instead.
  const zaubaTitle = /TITLE:\s+([A-Z]{2,}(?:\s[A-Z]{2,}){1,3})\s*\|\s*ZaubaCorp/g;
  zaubaTitle.lastIndex = 0;
  const ztMatch = zaubaTitle.exec(snippets);
  if (ztMatch) {
    const result = tryName(c4_toTitleCase(ztMatch[1]));
    if (result) return result;
  }

  return "Unknown";
}


// ============================================================
// SECTION 9 — BACKGROUND SEARCH
// ============================================================

function c4_searchPersonBackground(personName, companyName) {
  const cached = getCachedSearch(companyName, "C4_BG");
  if (cached) return cached;

  const query = CONFIG.QUERIES.C4_BACKGROUND
    .replace(/\{person\}/g,  personName)
    .replace(/\{company\}/g, companyName);

  const options = {
    method:  "post",
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
// SECTION 10 — DETERMINISTIC FALLBACK, BACKGROUND BUILDER, CONFIDENCE
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
    c4Background: "Gemini depth call failed — manual review needed",
    c4Confidence: "Low", manualReview,
  };
}

function buildC4Background(parsed, finalDepth, strongHit, moderateHit) {
  const parts = [finalDepth];
  const bg    = String(parsed.bg || "").trim();

  if (bg && bg.toLowerCase() !== "unknown") parts.push(bg.substring(0, 80));
  if (strongHit)        parts.push(`keyword: "${strongHit}"`);
  else if (moderateHit) parts.push(`keyword: "${moderateHit}"`);

  const reason = String(parsed.x || "").trim();
  if (reason) parts.push(reason.substring(0, 60));

  return parts.join(" | ").substring(0, 200);
}

function getC4Confidence(depth, parsed, strongHit) {
  if (depth === "Strong" && strongHit) return "High";
  if (depth === "Strong")              return "Medium";
  if (depth === "Moderate")            return "Medium";
  return "Low";
}


// ============================================================
// SECTION 11 — TEST: gate-by-gate name extraction
// Run standalone to diagnose which gate is hitting/missing.
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

  const summary = { resolved: 0, failed: 0, bySource: {} };

  companies.forEach((companyObj, i) => {
    const company = companyObj.company;
    Logger.log(`\n--- [${i+1}/${companies.length}] ${company} ---`);

    const buf = [];

    // ── Gate 1: Tofler ──────────────────────────────────────
    Logger.log(`Gate1: Tofler`);
    const toflerSnippets = callSerper(company, "C4_TOFLER");
    if (toflerSnippets && toflerSnippets.length > 30) {
      buf.push(toflerSnippets);
      const fromSnippet = c4_extractNameFromSnippets(toflerSnippets, company);
      if (fromSnippet !== "Unknown") {
        Logger.log(`Gate1 DONE (snippet): "${fromSnippet}"`);
        summary.resolved++;
        summary.bySource["tofler_snippet"] = (summary.bySource["tofler_snippet"] || 0) + 1;
        return;
      }
      const toflerUrl = c4_extractUrl(toflerSnippets, "tofler.in");
      if (toflerUrl) {
        Logger.log(`Gate1: scraping ${toflerUrl}`);
        const scraped = c4_scrapePage(toflerUrl);
        if (scraped) {
          Logger.log(`Gate1 DONE (scrape): "${scraped.name}" | "${scraped.designation}"`);
          summary.resolved++;
          summary.bySource["tofler_scrape"] = (summary.bySource["tofler_scrape"] || 0) + 1;
          return;
        }
        Logger.log(`Gate1: scrape returned nothing`);
      } else {
        Logger.log(`Gate1: no Tofler URL in snippets`);
        Logger.log(`Gate1 snippet preview:\n${toflerSnippets.substring(0, 400)}`);
      }
    } else {
      Logger.log(`Gate1: no results`);
    }

    // ── Gate 2: Zauba ───────────────────────────────────────
    Logger.log(`Gate2: Zauba`);
    const zaubaSnippets = callSerper(company, "C4_ZAUBA");
    if (zaubaSnippets && zaubaSnippets.length > 30) {
      buf.push(zaubaSnippets);
      const fromSnippet = c4_extractNameFromSnippets(zaubaSnippets, company);
      if (fromSnippet !== "Unknown") {
        Logger.log(`Gate2 DONE (snippet): "${fromSnippet}"`);
        summary.resolved++;
        summary.bySource["zauba_snippet"] = (summary.bySource["zauba_snippet"] || 0) + 1;
        return;
      }
      const zaubaUrl = c4_extractUrl(zaubaSnippets, "zaubacorp.com");
      if (zaubaUrl) {
        Logger.log(`Gate2: scraping ${zaubaUrl}`);
        const scraped = c4_scrapePage(zaubaUrl);
        if (scraped) {
          Logger.log(`Gate2 DONE (scrape): "${scraped.name}" | "${scraped.designation}"`);
          summary.resolved++;
          summary.bySource["zauba_scrape"] = (summary.bySource["zauba_scrape"] || 0) + 1;
          return;
        }
        Logger.log(`Gate2: scrape returned nothing (likely paywall)`);
      } else {
        Logger.log(`Gate2: no Zauba URL in snippets`);
        Logger.log(`Gate2 snippet preview:\n${zaubaSnippets.substring(0, 400)}`);
      }
    } else {
      Logger.log(`Gate2: no results`);
    }

    // ── Gate 3: General snippets + regex (Gemini SKIPPED) ───
    Logger.log(`Gate3: general query (Gemini SKIPPED)`);
    const generalSnippets = callSerper(company, "C4_GENERAL");
    if (generalSnippets && generalSnippets.length > 30) buf.push(generalSnippets);

    const allSnippets = buf.join("\n\n---\n\n");
    if (allSnippets.length < 50) {
      Logger.log(`Gate3: no snippets from any gate → FAIL no_snippets`);
      summary.failed++;
      summary.bySource["FAIL:no_snippets"] = (summary.bySource["FAIL:no_snippets"] || 0) + 1;
    } else {
      // Try regex on accumulated buffer before deciding Gemini is needed
      const fromSnippet = c4_extractNameFromSnippets(allSnippets, company);
      if (fromSnippet !== "Unknown") {
        Logger.log(`Gate3 DONE (snippet regex): "${fromSnippet}"`);
        summary.resolved++;
        summary.bySource["general_snippet"] = (summary.bySource["general_snippet"] || 0) + 1;
      } else {
        Logger.log(`Gate3: regex found nothing → would need Gemini`);
        Logger.log(`Gate3 snippet preview:\n${allSnippets.substring(0, 500)}`);
        summary.failed++;
        summary.bySource["needs_gemini"] = (summary.bySource["needs_gemini"] || 0) + 1;
      }
    }
  });

  // End summary
  Logger.log(`\n=== SUMMARY ===`);
  Logger.log(`Resolved: ${summary.resolved}/${companies.length}`);
  Logger.log(`Failed:   ${summary.failed}/${companies.length}`);
  Logger.log(`Breakdown:`);
  Object.entries(summary.bySource).forEach(([k, v]) => Logger.log(`  ${k}: ${v}`));
  Logger.log("=== testC4NameExtraction COMPLETE ===");
}
