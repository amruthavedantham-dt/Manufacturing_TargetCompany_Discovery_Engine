// ============================================================
// prompts.gs — All Gemini prompt strings for the ICP pipeline
// Keep prompt text here only — no config, no logic.
// buildPrompt() lives here too since it exists solely to
// assemble these strings.
// ============================================================

const PROMPTS = {

  // ----------------------------------------------------------
  // REVENUE BATCH PROMPT
  // Used by inferRevenueBatchGemini() — up to 10 companies
  // per call. Placeholder: {companies_block}
  // ----------------------------------------------------------
  REVENUE_BATCH: `You are classifying Indian manufacturers by annual revenue band.
          You will receive up to 10 companies. For each, use ONLY the snippet evidence provided.

          Allowed bands: <50Cr | 50-500Cr | 500-1500Cr | >1500Cr | Unknown

          Classification rules in priority order:

          1. Direct INR figure in crores → use it directly, confidence High
            Example: "turnover Rs. 150 crore" → 50-500Cr High

          2. USD/EUR revenue figure → convert at 83 INR per USD, 90 INR per EUR
            Example: "$15.7 M revenue" → 15.7 × 83 = ~130 Cr → 50-500Cr Medium
            Example: "$2 M revenue" → ~17 Cr → <50Cr Medium

          3. ICRA or CRISIL rating with facility size → infer from facility
            Example: "bank limits 8 crore" → <50Cr High
            Example: "rated for 200 crore facilities" → 50-500Cr High

          4. Employee count as revenue proxy for Indian manufacturers:
            - Under 25 employees → <50Cr Low
            - 25-50 employees → <50Cr Low
            - 51-200 employees with manufacturing/export/production signals → 50-500Cr Medium
            - 51-200 employees with no other signal → Unknown Low
            - 201-500 employees → 50-500Cr Medium
            - 500+ employees → 50-500Cr or above Medium
          5. Production capacity signals:
            - Under 500 MT/year → likely <50Cr
            - 500-5000 MT/year → likely 50-500Cr
            - Above 5000 MT/year → likely 50-500Cr or above

          6. If evidence only shows "Revenue. Not Available" or "GET PRO" paywalled data → Unknown Low

          7. If Zauba/Tofler page found but revenue hidden behind paywall → Unknown Low

          8. If no financial signal at all → Unknown Low

          Return ONLY a valid JSON array. No markdown. No explanation. Start with [ end with ].

          [
            {
              "company": "exact company name as given",
              "band": "<50Cr | 50-500Cr | 500-1500Cr | >1500Cr | Unknown",
              "confidence": "High | Medium | Low",
              "signal": "exact phrase or calculation that determined the band, max 25 words",
              "source": "Tofler | Zauba | ICRA | CRISIL | MoneyControl | Tracxn | Employee-count | Capacity | USD-converted | Directory | None"
            }
          ]

          Companies:
          {companies_block}`,


  // ----------------------------------------------------------
  // REVENUE SINGLE PROMPT
  // Used by inferRevenueWithGemini() and
  // inferRevenueWithGeminiHelper() — single company path.
  // Placeholders: {company}, {evidence}
  // ----------------------------------------------------------
  REVENUE_SINGLE: `You are classifying an Indian manufacturer by annual revenue band.
          Use ONLY the snippet evidence provided.

          Company: {company}
          Evidence: {evidence}

          Allowed bands: <50Cr | 50-500Cr | 500-1500Cr | >1500Cr | Unknown

          Classification rules in priority order:

          1. Direct INR figure in crores → use it directly, confidence High
            Example: "turnover Rs. 150 crore" → 50-500Cr High

          2. USD/EUR revenue figure → convert at 83 INR per USD, 90 INR per EUR
            Example: "$15.7 M revenue" → 15.7 × 83 = ~130 Cr → 50-500Cr Medium

          3. ICRA or CRISIL rating with facility size → infer from facility
            Example: "bank limits 8 crore" → <50Cr High

          4. Employee count as revenue proxy for Indian manufacturers:
            - Under 25 employees → <50Cr Low
            - 25-50 employees → <50Cr Low
            - 51-200 employees with manufacturing/export/production signals → 50-500Cr Medium
            - 51-200 employees with no other signal → Unknown Low
            - 201-500 employees → 50-500Cr Medium
            - 500+ employees → 50-500Cr or above Medium

          5. Production capacity signals:
            - Under 500 MT/year → likely <50Cr
            - 500-5000 MT/year → likely 50-500Cr
            - Above 5000 MT/year → likely 50-500Cr or above

          6. If evidence only shows "Revenue. Not Available" or "GET PRO" paywalled data → Unknown Low

          7. If Zauba/Tofler page found but revenue hidden behind paywall → Unknown Low

          8. If no financial signal at all → Unknown Low

          Return ONLY a valid JSON object. No markdown. No explanation.
          {"band":"<50Cr|50-500Cr|500-1500Cr|>1500Cr|Unknown","confidence":"High|Medium|Low","signal":"max 25 words","source":"Tofler|Zauba|ICRA|CRISIL|MoneyControl|Tracxn|Employee-count|Capacity|USD-converted|Directory|None"}`,


  // ----------------------------------------------------------
  // C3 PROMPT
  // Used by runC3() — technical differentiation signals.
  // Placeholders: {company}, {evidence}
  // ----------------------------------------------------------
  C3: `You are a strict manufacturing research analyst. Evaluate technical differentiation signals.
          Company: {company}
          Evidence: {evidence}

          Return ONLY this exact JSON with no other text:
          {"P":"S/W/A","D":"S/W/A","R":"S/W/A","PR":"S/W/A","PC":"S/W/A","CS":"S/W/A","CC":"S/W/A","x":"max 20 words reason"}

          Field meanings:
          P = Patents filed or granted
          D = DSIR recognition
          R = Regulatory approvals (USFDA, WHO-GMP, EU-GMP)
          PR = Proprietary or branded products
          PC = Pioneer or first-mover claims
          CS = Custom synthesis capability
          CC = Commodity chemicals (penalty signal)

          Values: S=Strong evidence, W=Weak/indirect evidence, A=Absent`,


  // ----------------------------------------------------------
  // C4 NAME PROMPT
  // Gemini call 1 — name extraction only, lightweight.
  // Placeholders: {company}, {evidence}
  // ----------------------------------------------------------
  C4_NAME: `Extract the decision-maker's name from these search results about an Indian company.

      Company: {company}

      Evidence:
      {evidence}

      Identify the most senior person:
      - Prefer: Founder, MD, Managing Director, Chairman, Promoter, CEO, Proprietor
      - If multiple directors listed, pick the most senior title
      - Names may appear as "Name - Title", "Title: Name", "Directors are Name1, Name2", or "Name is the founder"
      - If no person found, use "Unknown"


      Priority order: Founder > MD > Managing Director > Chairman > Promoter > CEO > Proprietor > Director

      If multiple people found, pick the most senior title.
      If only a LinkedIn URL is available with no title context, extract the name from the URL slug.

      Return ONLY:
      {"name":"Full Name or Unknown"}`,


  // ----------------------------------------------------------
  // C4 DEPTH PROMPT
  // Gemini call 2 — depth classification only, no name needed.
  // Placeholders: {company}, {evidence}
  // ----------------------------------------------------------
  C4_DEPTH: `You are classifying the technical depth of a decision-maker at an Indian manufacturing company.

      Company: {company}

      Evidence:
      {evidence}

      Strong:
      - PhD, IIT, IISc, IISER, NIT, BITS
      - ex-ISRO, ex-DRDO, scientist, patent holder, published researcher

      Moderate:
      - B.Tech, BE, M.Tech, MSc
      - engineering background, technical founder, R&D leadership

      None:
      - MBA only, finance background, sales background, no evidence found

      Return ONLY:
      {"depth":"Strong/Moderate/None","bg":"max 15 words","x":"max 15 words"}`,


  // ----------------------------------------------------------
  // C6 PROMPT
  // Used by runC6() — growth signal detection for ambiguous
  // cases where deterministic found fewer than 2 signals.
  // Placeholder: {evidence}
  // ----------------------------------------------------------
  C6: `You are evaluating growth signals for an Indian manufacturer.
        Evidence: {evidence}

        Return ONLY this exact JSON with no other text:
        {"hiring":false,"facility":false,"certifications":false,"active":false,"exports":false,"x":"max 15 words on strongest signal"}

        hiring = true if job postings, recruitment, team expansion, or headcount growth mentioned
        facility = true if new plant, capacity increase, greenfield, brownfield, expansion, new unit mentioned
        certifications = true if USFDA, WHO-GMP, EU-GMP, DSIR, ISO, HALAL, REACH, or approval mentioned
        active = true if any news, press release, announcement, blog, or event from 2024 or 2025
        exports = true if export destinations, global customers, USA, Europe, Japan, or revenue growth mentioned`,

};


// ============================================================
// buildPrompt — assembles a prompt string for a single company.
// Replaces {company} and {evidence} placeholders.
// For REVENUE_BATCH use PROMPTS.REVENUE_BATCH.replace() directly
// since its placeholder is {companies_block} (multi-company).
// ============================================================

function buildPrompt(promptKey, companyName, evidenceText) {
  return PROMPTS[promptKey]
    .replace(/\{company\}/g, companyName)
    .replace(/\{evidence\}/g, evidenceText);
}
