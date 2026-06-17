// ============================================================
// ai.gs — All API Calls for ICP Pipeline
// Handles: Serper search, Gemini inference, JSON parsing,
//          rate limiting, retry logic, cache integration.
// No sheet logic here. No scoring logic here.
// Just clean API calls that return data or null.
// ============================================================

// ============================================================
// SECTION 1 — ADAPTIVE RATE LIMITER
// Starts at CONFIG defaults each run; backs off on 429/503 and
// gradually speeds up on consecutive successes.
// All API callers use rateLimit() — never Utilities.sleep() directly.
// ============================================================

// Per-type sleep values — initialized lazily from CONFIG on first use.
var _adaptiveSleep = { GEMINI: null, SERPER: null };

function rateLimit(type) {
  var ms;
  if (type === 'GEMINI') {
    if (_adaptiveSleep.GEMINI === null) _adaptiveSleep.GEMINI = CONFIG.BATCH.GEMINI_SLEEP;
    ms = _adaptiveSleep.GEMINI;
  } else if (type === 'SERPER') {
    if (_adaptiveSleep.SERPER === null) _adaptiveSleep.SERPER = CONFIG.BATCH.SERPER_SLEEP;
    ms = _adaptiveSleep.SERPER;
  } else {
    ms = 1000;
  }
  Utilities.sleep(ms);
}

// Called when a 429 or 503 is received — increases sleep for future calls.
function rateLimitBackoff(type) {
  if (type !== 'GEMINI' && type !== 'SERPER') return;
  if (_adaptiveSleep[type] === null) {
    _adaptiveSleep[type] = type === 'GEMINI'
      ? CONFIG.BATCH.GEMINI_SLEEP
      : CONFIG.BATCH.SERPER_SLEEP;
  }
  var maxMs = type === 'GEMINI'
    ? CONFIG.ADAPTIVE_RATE.GEMINI_MAX_SLEEP
    : CONFIG.ADAPTIVE_RATE.SERPER_MAX_SLEEP;
  var prev = _adaptiveSleep[type];
  _adaptiveSleep[type] = Math.min(
    Math.round(prev * CONFIG.ADAPTIVE_RATE.BACKOFF_FACTOR),
    maxMs
  );
  if (_adaptiveSleep[type] !== prev) {
    Logger.log('[RateLimit] ' + type + ' backoff: ' + prev + 'ms → ' + _adaptiveSleep[type] + 'ms');
  }
}

// Called on a successful API response — gradually lowers sleep toward the floor.
function rateLimitSuccess(type) {
  if (type !== 'GEMINI' && type !== 'SERPER') return;
  if (_adaptiveSleep[type] === null) return;
  var minMs = type === 'GEMINI'
    ? CONFIG.ADAPTIVE_RATE.GEMINI_MIN_SLEEP
    : CONFIG.ADAPTIVE_RATE.SERPER_MIN_SLEEP;
  if (_adaptiveSleep[type] <= minMs) return;
  var prev = _adaptiveSleep[type];
  _adaptiveSleep[type] = Math.max(
    Math.round(prev * CONFIG.ADAPTIVE_RATE.DECAY_FACTOR),
    minMs
  );
  if (_adaptiveSleep[type] !== prev) {
    Logger.log('[RateLimit] ' + type + ' decay: ' + prev + 'ms → ' + _adaptiveSleep[type] + 'ms');
  }
}

// Returns the current adaptive sleep for a given type (used by tests).
function getRateLimitSleepMs(type) {
  if (_adaptiveSleep[type] === null) {
    return type === 'GEMINI' ? CONFIG.BATCH.GEMINI_SLEEP : CONFIG.BATCH.SERPER_SLEEP;
  }
  return _adaptiveSleep[type];
}


// ============================================================
// SECTION 2 — HTTP ERROR CLASSIFIER
// Tells callGeminiWithRetry whether to retry or bail.
// ============================================================

function getHttpErrorType(responseCode) {
  const code = parseInt(responseCode, 10);
  switch (code) {
    case 429: return "RATE_LIMIT";   // quota hit — retry with backoff
    case 500: return "SERVER_ERROR"; // transient Gemini error — retry
    case 503: return "SERVER_ERROR"; // service unavailable — retry
    case 400: return "BAD_REQUEST";  // bad prompt/payload — bail
    case 404: return "BAD_REQUEST";  // wrong endpoint — bail
    default:  return "UNKNOWN";      // anything else — bail
  }
}


// ============================================================
// SECTION 3 — SNIPPET BUILDER
// Converts Serper raw JSON response into a clean text string.
// Limits to 2500 chars to control Gemini token usage.
// ============================================================

function buildSnippetText(serperData) {
  if (!serperData || !serperData.organic) return "";

  const snippets = serperData.organic.slice(0, 8).map(item => {
    const title   = String(item.title   || "").trim();
    const snippet = String(item.snippet || "").trim();
    const link    = String(item.link    || "").trim();
    return `TITLE: ${title}\nSNIPPET: ${snippet}\nLINK: ${link}`;
  });

  const joined = snippets.join("\n\n");

  // Hard cap at 2500 chars — enough signal, controlled tokens
  return joined.length > 2500 ? joined.substring(0, 2500) : joined;
}


// ============================================================
// SECTION 4 — SERPER SEARCH
// Checks cache first. On miss: calls API, saves to cache.
// Returns snippet string or "" on failure.
// ============================================================

function callSerper(companyName, queryType) {

  // Step 1: Check cache
  const cached = getCachedSearch(companyName, queryType);
  if (cached) return cached; // cache hit — no API call needed

  if (CircuitBreaker.isHalted('SERPER')) {
    Logger.log(`callSerper: SERPER circuit open — skipping "${companyName}" | ${queryType}`);
    return "";
  }

  // Step 2: Build query from template
  const queryTemplate = CONFIG.QUERIES[queryType];
  if (!queryTemplate) {
    Logger.log(`callSerper: unknown queryType "${queryType}"`);
    return "";
  }
  const query = buildQuery(queryTemplate, companyName);

  // Step 3: Call Serper API
  const options = {
    method:  "post",
    headers: {
      "X-API-KEY":    CONFIG.KEYS.SERPER,
      "Content-Type": "application/json",
    },
    payload:            JSON.stringify({ q: query, num: 8 }),
    muteHttpExceptions: true, // prevents Apps Script from throwing on non-200
  };

  let snippetText = "";

  try {
    const response = UrlFetchApp.fetch("https://google.serper.dev/search", options);
    const code     = response.getResponseCode();

    if (code !== 200) {
      Logger.log(`callSerper: HTTP ${code} for "${companyName}" | ${queryType}`);
      CircuitBreaker.recordFailure('SERPER');
      rateLimitBackoff('SERPER');
      rateLimit("SERPER");
      return "";
    }

    const data       = JSON.parse(response.getContentText());
    const numResults = (data.organic || []).length;
    snippetText      = buildSnippetText(data);
    TokenLog.appendSerper(CURRENT_RUN_ID, companyName, queryType, numResults);
    CircuitBreaker.recordSuccess('SERPER');
    rateLimitSuccess('SERPER');

    if (!snippetText) {
      Logger.log(`callSerper: empty results for "${companyName}" | ${queryType}`);
    } else {
      Logger.log(`callSerper: OK for "${companyName}" | ${queryType} (${snippetText.length} chars)`);
    }

  } catch (e) {
    Logger.log(`callSerper: exception for "${companyName}" | ${queryType}: ${e.message}`);
    CircuitBreaker.recordFailure('SERPER');
    rateLimitBackoff('SERPER');
    rateLimit("SERPER");
    return "";
  }

  // Step 4: Save to cache (even if empty — prevents repeat failed calls)
  saveToCache(companyName, queryType, query, snippetText);

  // Step 5: Rate limit after live call
  rateLimit("SERPER");

  return snippetText;
}


// ============================================================
// SECTION 5 — GEMINI SINGLE CALL
// Makes one API call. Returns raw response text or null.
// Does NOT parse JSON — that's parseGeminiJSON()'s job.
// Always rate limits after call regardless of outcome.
// ============================================================

function callGemini(prompt) {
  const url = CONFIG.GEMINI.ENDPOINT + "?key=" + CONFIG.KEYS.GEMINI;

  const payload = {
    contents: [
      {
        parts: [{ text: prompt }],
      },
    ],
    generationConfig: {
      temperature:     CONFIG.GEMINI.TEMPERATURE,
      maxOutputTokens: CONFIG.GEMINI.MAX_TOKENS,
      thinkingConfig:  { thinkingBudget: 0 },
    },
  };

  const options = {
    method:             "post",
    contentType:        "application/json",
    payload:            JSON.stringify(payload),
    muteHttpExceptions: true,
  };

  let rawText = null;
  let usage   = { inputTokens: 0, outputTokens: 0, thinkingTokens: 0 };

  try {
    Logger.log(`callGemini: sending request to Gemini`);
    const response = UrlFetchApp.fetch(url, options);
    const code     = response.getResponseCode();

    if (code !== 200) {
      // Return the code as a special marker so callGeminiWithRetry can classify it
      Logger.log(`callGemini: HTTP ${code}`);
      Logger.log(response.getContentText());
      rateLimit("GEMINI");
      return { error: true, code: code };
    }

    const data = JSON.parse(response.getContentText());
    const meta = data.usageMetadata || {};
    usage = {
      inputTokens:    meta.promptTokenCount     || 0,
      outputTokens:   meta.candidatesTokenCount || 0,
      thinkingTokens: meta.thoughtsTokenCount   || 0,
    };

    // Extract text from Gemini response structure
    rawText = data?.candidates?.[0]?.content?.parts?.[0]?.text || null;

    if (!rawText) {
      Logger.log("callGemini: response parsed but text content empty");
    } else {
      Logger.log(`callGemini: OK (${rawText.length} chars)`);
    }

  } catch (e) {
    Logger.log(`callGemini: exception: ${e.message}`);
    rateLimit("GEMINI");
    return { error: true, code: "TIMEOUT", message: e.message };
  }

  rateLimit("GEMINI");
  return { text: rawText, usage };
}


// ============================================================
// SECTION 6 — GEMINI WITH RETRY
// Wraps callGemini with exponential backoff.
// Retries ONLY on: 429, 500, 503, timeout.
// Bails immediately on: 400, 404, empty response.
// Returns response text or null.
// ============================================================

function callGeminiWithRetry(prompt, ctx) {
  const company     = (ctx && ctx.company) || '';
  const stage       = (ctx && ctx.stage)   || 'unknown';

  if (CircuitBreaker.isHalted('GEMINI')) {
    Logger.log(`callGeminiWithRetry: GEMINI circuit open — skipping "${company}" | ${stage}`);
    return null;
  }

  const retrySleeps = CONFIG.BATCH.RETRY_SLEEPS; // [5000, 10000, 20000]
  const maxRetries  = CONFIG.BATCH.MAX_RETRIES;  // 3

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    const result = callGemini(prompt);

    // Error object — classify and decide
    if (result && result.error) {
      const errorType = getHttpErrorType(result.code);

      if (errorType === "BAD_REQUEST" || errorType === "UNKNOWN") {
        Logger.log(`callGeminiWithRetry: ${errorType} (${result.code}), not retrying.`);
        return null;
      }

      // RATE_LIMIT or SERVER_ERROR — increase adaptive sleep, then retry
      rateLimitBackoff('GEMINI');
      if (attempt < maxRetries) {
        const sleepMs = retrySleeps[attempt] || 20000;
        Logger.log(`callGeminiWithRetry: ${errorType} (${result.code}), attempt ${attempt + 1}/${maxRetries}. Waiting ${sleepMs}ms...`);
        Utilities.sleep(sleepMs);
        continue;
      }

      Logger.log(`callGeminiWithRetry: exhausted ${maxRetries} retries. Returning null.`);
      CircuitBreaker.recordFailure('GEMINI');
      return null;
    }

    // Success object { text, usage } from HTTP 200
    const text  = result.text;
    const usage = result.usage;

    if (typeof text === "string" && text.length > 0) {
      TokenLog.append(CURRENT_RUN_ID, company, stage, CONFIG.GEMINI.MODEL, usage);
      CircuitBreaker.recordSuccess('GEMINI');
      rateLimitSuccess('GEMINI');
      return text;
    }

    // Empty response — log tokens (wasted call) then bail
    TokenLog.append(CURRENT_RUN_ID, company, stage, CONFIG.GEMINI.MODEL, usage);
    Logger.log("callGeminiWithRetry: empty response, not retrying.");
    CircuitBreaker.recordSuccess('GEMINI'); // HTTP 200 — API is reachable
    rateLimitSuccess('GEMINI');
    return null;
  }

  return null;
}

// ============================================================
// SECTION 7 — JSON PARSER
// Three-layer extraction from Gemini response text.
// Returns parsed object or null — never throws.
//
// Layer 1: strip ```json markdown wrapper → try parse
// Layer 2: extract between first { and last } → try parse
// Layer 3: return null → caller uses safe default object
// ============================================================

function parseGeminiJSON(text) {
  if (!text || typeof text !== "string") return null;

  // Layer 1: strip markdown fences
  let cleaned = text
    .replace(/```json/gi, "")
    .replace(/```/g, "")
    .trim();

  // Layer 2: try direct parse
  try {
    return JSON.parse(cleaned);
  } catch(e1) {}

  // Layer 3: extract between first { and last }
  const start = cleaned.indexOf("{");
  const end   = cleaned.lastIndexOf("}");

  if (start !== -1 && end !== -1 && end > start) {
    try {
      return JSON.parse(cleaned.substring(start, end + 1));
    } catch(e2) {}
  }

  // Layer 4: normalize whitespace and retry
  try {
    const normalized = cleaned
      .replace(/[\r\n\t]/g, " ")  // replace newlines/tabs with spaces
      .replace(/\s+/g, " ")       // collapse multiple spaces
      .trim();
    const s = normalized.indexOf("{");
    const e = normalized.lastIndexOf("}");
    if (s !== -1 && e !== -1) {
      return JSON.parse(normalized.substring(s, e + 1));
    }
  } catch(e3) {}

  // Layer 5: TRUNCATION REPAIR
  try {
    const s = cleaned.indexOf("{");
    if (s !== -1) {
      let partial = cleaned.substring(s);

      // Strategy 1: find last COMPLETE key-value pair
      // A complete pair ends with: ,"  or  "}
      // Look for last occurrence of a closing quote before a comma+quote or end
      const completePattern = /^(\{(?:(?:"[^"]+"\s*:\s*"[^"]*"\s*,\s*)*"[^"]+"\s*:\s*"[^"]*"))/.exec(partial);
      if (completePattern) {
        try { return JSON.parse(completePattern[1] + "}"); } catch(e) {}
      }

      // Strategy 2: walk backwards from end, find last ," boundary
      // Works for both short keys (C3) and long values (C4)
      let cutPoint = partial.length;
      while (cutPoint > 0) {
        cutPoint = partial.lastIndexOf('",', cutPoint - 1);
        if (cutPoint === -1) break;
        const candidate = partial.substring(0, cutPoint) + '"}';
        try { return JSON.parse(candidate); } catch(e) { continue; }
      }

      // Strategy 3: drop entire last field including its key
      // Handles: ..., "key": "truncated value  (no closing quote)
      const lastFieldStart = partial.lastIndexOf(',"');
      if (lastFieldStart > 0) {
        const candidate = partial.substring(0, lastFieldStart) + "}";
        try { return JSON.parse(candidate); } catch(e) {}
      }
    }
  } catch(e5) {}

  Logger.log(`parseGeminiJSON: all layers failed. Raw text: ${text.substring(0, 200)}`);
  return null;
}


// ===========================================================
// ============================================================
// SECTION 7.5 — GEMINI REVENUE HELPER
// Standardized revenue inference helper
// ============================================================

function inferRevenueWithGeminiHelper(
  companyName,
  evidenceText
) {

  try {

    Logger.log(
      `[inferRevenueWithGeminiHelper START] ${companyName}`
    );

    const prompt =
      buildPrompt(
        "REVENUE_SINGLE",
        companyName,
        evidenceText
      );

    const raw =
      callGeminiWithRetry(prompt, { company: companyName, stage: 's1-revenue' });

    if (!raw) {

      Logger.log(
        `[inferRevenueWithGeminiHelper EMPTY] ${companyName}`
      );

      return null;
    }

    const parsed =
      parseGeminiJSON(raw);

    if (!parsed) {

      Logger.log(
        `[inferRevenueWithGeminiHelper PARSE FAIL] ${companyName}`
      );

      return null;
    }

    Logger.log(
      `[inferRevenueWithGeminiHelper SUCCESS] ${companyName}`
    );

    return parsed;

  } catch (err) {

    Logger.log(
      `[inferRevenueWithGeminiHelper ERROR] ${companyName} | ${err.message}`
    );

    return null;
  }
}
// ===========================================================

// ============================================================
// SECTION 7.6 — SERPER CONNECTION TEST
// Standalone — bypasses cache, circuit breaker, and rate limiter.
// Makes exactly ONE Serper call and logs the full response body
// so the real error (quota/credits/key issue) is visible, not
// just the HTTP status code.
// Select "testSerperConnection" from dropdown and hit Run.
// ============================================================

function testSerperConnection() {
  Logger.log("=== testSerperConnection START ===");

  const key = CONFIG.KEYS.SERPER;
  if (!key) {
    Logger.log("FAIL — SERPER_API_KEY is missing from Script Properties.");
    return;
  }
  Logger.log("Key present — length " + key.length + ", starts with: " + key.substring(0, 4) + "...");

  const options = {
    method:             "post",
    headers: {
      "X-API-KEY":    key,
      "Content-Type": "application/json",
    },
    payload:            JSON.stringify({ q: "Tata Motors", num: 3 }),
    muteHttpExceptions: true,
  };

  try {
    const response = UrlFetchApp.fetch("https://google.serper.dev/search", options);
    const code = response.getResponseCode();
    const body = response.getContentText();

    Logger.log("HTTP status: " + code);
    Logger.log("Response body: " + body);

    if (code === 200) {
      Logger.log("RESULT: PASS — Serper is working normally.");
    } else if (code === 400) {
      Logger.log("RESULT: FAIL — HTTP 400. Check response body above — usually means out of credits/quota, or a malformed key.");
    } else if (code === 401 || code === 403) {
      Logger.log("RESULT: FAIL — HTTP " + code + ". API key is invalid, revoked, or unauthorized.");
    } else if (code === 429) {
      Logger.log("RESULT: FAIL — HTTP 429. Rate limited (this is different from quota exhaustion).");
    } else {
      Logger.log("RESULT: FAIL — unexpected HTTP " + code + ". See response body above.");
    }
  } catch (e) {
    Logger.log("RESULT: FAIL — exception: " + e.message);
  }

  Logger.log("=== testSerperConnection COMPLETE ===");
}


// ============================================================
// SECTION 8 — TEST FUNCTION
// Run this to verify both APIs work before running pipeline.
// Select "testAI" from dropdown and hit Run.
// Check Execution Log for results.
// ============================================================

function testAI() {
  Logger.log("=== testAI() start ===");
  Logger.log("Test company: Avra Synthesis");

  // --- Test 1: Serper ---
  Logger.log("\n--- Test 1: Serper (C3 query) ---");
  const snippets = callSerper("Avra Synthesis", "C3");

  if (snippets && snippets.length > 50) {
    Logger.log(`Serper: PASS — got ${snippets.length} chars`);
    Logger.log(`Preview: ${snippets.substring(0, 300)}...`);
  } else {
    Logger.log("Serper: FAIL — empty or too short. Check SERPER API key in config.gs");
  }

  // --- Test 2: Gemini JSON parsing ---
  Logger.log("\n--- Test 2: Gemini C3 call ---");

  if (!snippets || snippets.length < 50) {
    Logger.log("Skipping Gemini test — no Serper evidence to send.");
  } else {
    const prompt = buildPrompt("C3", "Avra Synthesis", snippets);
    const raw    = callGeminiWithRetry(prompt, { company: 'Avra Synthesis', stage: 'test-c3' });

    if (!raw) {
      Logger.log("Gemini: FAIL — null response. Check GEMINI API key in config.gs");
    } else {
      Logger.log(`Gemini raw response (first 300 chars): ${raw.substring(0, 300)}`);

      Logger.log(`Full raw length: ${raw.length}`);
      Logger.log(`Full raw: ${raw}`);
      const parsed = parseGeminiJSON(raw);
      if (parsed) {
        Logger.log("JSON parsing: PASS");
        Logger.log(`Parsed result: ${JSON.stringify(parsed)}`);
      } else {
        Logger.log("JSON parsing: FAIL — parseGeminiJSON returned null");
        Logger.log("This means Gemini returned something unparseable. Check raw response above.");
      }
    }
  }

  // --- Test 3: JSON repair test ---
  Logger.log("\n--- Test 3: parseGeminiJSON repair layers ---");

  const testCases = [
    {
      label: "Clean JSON",
      input: '{"Patents": "Strong", "DSIR": "Absent"}',
    },
    {
      label: "Markdown wrapped",
      input: '```json\n{"Patents": "Weak", "DSIR": "Absent"}\n```',
    },
    {
      label: "Text before/after",
      input: 'Sure! Here is the result:\n{"Patents": "Absent"}\nHope that helps!',
    },
    {
      label: "Total garbage",
      input: "Sorry, I cannot process this request.",
    },
  ];

  testCases.forEach(({ label, input }) => {
    const result = parseGeminiJSON(input);
    Logger.log(`  ${label}: ${result ? "PASS → " + JSON.stringify(result) : "null (Layer 3 fallback)"}`);
  });

  Logger.log("\n=== testAI() complete ===");
}


// ============================================================
// SECTION 9 — ADAPTIVE RATE LIMITER TEST
// No API calls or sleeping — manipulates _adaptiveSleep directly.
// Run from the Apps Script editor; check Execution log.
// ============================================================

function testAdaptiveRateLimiting() {
  Logger.log('=== testAdaptiveRateLimiting START ===\n');
  var passed = 0;
  var failed = 0;

  function assert(label, condition) {
    if (condition) { Logger.log('PASS — ' + label); passed++; }
    else           { Logger.log('FAIL — ' + label); failed++; }
  }

  // Save whatever was in place before the test
  var origGemini = _adaptiveSleep.GEMINI;
  var origSerper = _adaptiveSleep.SERPER;

  // Start from known defaults
  _adaptiveSleep.GEMINI = CONFIG.BATCH.GEMINI_SLEEP;
  _adaptiveSleep.SERPER = CONFIG.BATCH.SERPER_SLEEP;
  var gStart = _adaptiveSleep.GEMINI;
  var sStart = _adaptiveSleep.SERPER;
  Logger.log('  Starting GEMINI=' + gStart + 'ms  SERPER=' + sStart + 'ms\n');

  // ── Test 1: backoff increases sleep ────────────────────────
  rateLimitBackoff('GEMINI');
  var gAfter = _adaptiveSleep.GEMINI;
  assert('GEMINI sleep increases after backoff', gAfter > gStart);
  assert('GEMINI backoff = round(start × BACKOFF_FACTOR)',
    gAfter === Math.min(
      Math.round(gStart * CONFIG.ADAPTIVE_RATE.BACKOFF_FACTOR),
      CONFIG.ADAPTIVE_RATE.GEMINI_MAX_SLEEP
    ));
  Logger.log('  GEMINI: ' + gStart + ' → ' + gAfter + 'ms');

  // ── Test 2: success reduces sleep ──────────────────────────
  rateLimitSuccess('GEMINI');
  var gDecayed = _adaptiveSleep.GEMINI;
  assert('GEMINI sleep decreases after success', gDecayed < gAfter);
  Logger.log('  GEMINI: ' + gAfter + ' → ' + gDecayed + 'ms');

  // ── Test 3: many successes hit the floor ───────────────────
  for (var i = 0; i < 200; i++) rateLimitSuccess('GEMINI');
  assert('GEMINI hits floor after many successes',
    _adaptiveSleep.GEMINI === CONFIG.ADAPTIVE_RATE.GEMINI_MIN_SLEEP);
  Logger.log('  GEMINI floor = ' + _adaptiveSleep.GEMINI + 'ms');

  // ── Test 4: success is a no-op at floor ────────────────────
  var atFloor = _adaptiveSleep.GEMINI;
  rateLimitSuccess('GEMINI');
  assert('GEMINI unchanged at floor', _adaptiveSleep.GEMINI === atFloor);

  // ── Test 5: many backoffs hit the ceiling ──────────────────
  for (var j = 0; j < 30; j++) rateLimitBackoff('GEMINI');
  assert('GEMINI hits ceiling after many backoffs',
    _adaptiveSleep.GEMINI === CONFIG.ADAPTIVE_RATE.GEMINI_MAX_SLEEP);
  Logger.log('  GEMINI ceiling = ' + _adaptiveSleep.GEMINI + 'ms');

  // ── Test 6: backoff is a no-op at ceiling ──────────────────
  var atCeil = _adaptiveSleep.GEMINI;
  rateLimitBackoff('GEMINI');
  assert('GEMINI unchanged at ceiling', _adaptiveSleep.GEMINI === atCeil);

  // ── Test 7: SERPER adapts independently ────────────────────
  _adaptiveSleep.SERPER = sStart;
  rateLimitBackoff('SERPER');
  assert('SERPER backoff is independent of GEMINI',
    _adaptiveSleep.SERPER > sStart && _adaptiveSleep.GEMINI === atCeil);
  Logger.log('  SERPER: ' + sStart + ' → ' + _adaptiveSleep.SERPER + 'ms');

  // ── Test 8: getRateLimitSleepMs returns live values ────────
  assert('getRateLimitSleepMs(GEMINI) matches live state',
    getRateLimitSleepMs('GEMINI') === _adaptiveSleep.GEMINI);
  assert('getRateLimitSleepMs(SERPER) matches live state',
    getRateLimitSleepMs('SERPER') === _adaptiveSleep.SERPER);

  // ── Test 9: uninitialised type returns config default ──────
  _adaptiveSleep.GEMINI = null;
  assert('getRateLimitSleepMs falls back to CONFIG when null',
    getRateLimitSleepMs('GEMINI') === CONFIG.BATCH.GEMINI_SLEEP);

  // Restore
  _adaptiveSleep.GEMINI = origGemini;
  _adaptiveSleep.SERPER = origSerper;

  Logger.log('\n=== RESULT: ' + passed + ' passed, ' + failed + ' failed ===');
  Logger.log('=== testAdaptiveRateLimiting COMPLETE ===');
}
