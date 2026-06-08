// ============================================================
// config.gs — Central Configuration for ICP Pipeline
// ============================================================

const CONFIG = {
  // ----------------------------------------------------------
  // API KEYS
  // ----------------------------------------------------------
  KEYS: {
    get SERPER() {
      return PropertiesService
        .getScriptProperties()
        .getProperty('SERPER_API_KEY');
    },

    get GEMINI() {
      return PropertiesService
        .getScriptProperties()
        .getProperty('GEMINI_API_KEY');
    }
  },

  // ----------------------------------------------------------
  // GEMINI CONFIG
  // ----------------------------------------------------------
  GEMINI: {

    MODEL: "gemini-2.5-flash",
    ENDPOINT: "https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent",

    //MODEL: "gemini-2.0-flash",
    //ENDPOINT: "https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent",

    MAX_TOKENS: 2048,

    TEMPERATURE: 0,
  },



  // ----------------------------------------------------------
  // GEMINI BATCH CONFIG
  // ----------------------------------------------------------
  BATCH_API: {

    ENABLED: true,

    MAX_BATCH_SIZE: 20,

    POLL_INTERVAL_MS: 10000,

    MAX_WAIT_MS: 300000,
  },



  // ----------------------------------------------------------
  // PIPELINE CONTROLS
  // ----------------------------------------------------------
  PIPELINE: {

    // ONLY these pass Stage-1
    STAGE1_PASS_BANDS: [
      "50-500Cr"
    ],
  },



  // ----------------------------------------------------------
  // SHEET NAMES
  // ----------------------------------------------------------
  SHEETS: {

    MASTER: "MASTER",

    STAGE1: "STAGE1_RESULTS",

    CACHE: "SEARCH_CACHE",

    SCORES: "SCORES",

    SHORTLIST: "SHORTLIST",
  },



  // ----------------------------------------------------------
  // MASTER SHEET COLUMNS
  // ----------------------------------------------------------
  MASTER_COLS: {

    COMPANY: 0,

    WEBSITE: 1,

    SOURCE: 2,
  },



  // ----------------------------------------------------------
  // BATCH & RATE LIMITING
  // ----------------------------------------------------------
  BATCH: {

    SIZE: 5,

    SERPER_SLEEP: 1200,

    GEMINI_SLEEP: 8000, // prev 3000

    RETRY_SLEEPS: [10000, 20000, 30000],  // CHANGED: was [10000, 15000, 30000] — longer backoff on 503s
    
    MAX_RETRIES: 3,
  },



  // ----------------------------------------------------------
  // STAGE 1 FILTERS
  // ----------------------------------------------------------
  STAGE1: {

    // --------------------------------------------------------
    // MANUFACTURER SIGNALS
    // --------------------------------------------------------
    MANUFACTURING: [

      "manufacturing",
      "manufacturer",
      "plant",
      "factory",
      "production facility",
      "production unit",
      "gmp facility",
      "processing unit",
      "fabrication",
      "we manufacture",
      "our plant",
      "our facility",
      "r&d facility",
      "manufacturing unit",
      "production capacity",
      "formulation plant",
      "gmp certified",
      "industrial estate",
      "pilot plant",
      "reactor capacity",
      "synthesis facility",
      "bulk manufacturing",
      "api manufacturing",
      "speciality chemicals manufacturing",
      "fermentation facility",
      "clean room",
      "assembly line",
      "manufacturing campus",
    ],


    // --------------------------------------------------------
    // TRADER SIGNALS
    // --------------------------------------------------------
    TRADER: [

      "trading company",
      "trader",
      "distributor",
      "wholesaler",
      "stockist",
      "importer",
      "we trade",
      "wholesale dealer",
      "reseller",
      "merchant exporter",
      "sourcing company",
    ],


    // --------------------------------------------------------
    // CRO / SERVICE SIGNALS
    // --------------------------------------------------------
    CRO: [

      " cro ",
      "contract research organization",
      "cro company",
      "cro services",
      "clinical research organization",
      "contract research and development services",
      "drug discovery services",
      "analytical testing services",
      "bioanalytical services",
      "clinical trial services",
      "research services only",
      "testing laboratory",
      "analytical laboratory",
      "contract testing",
      "testing services",
    ],


    // --------------------------------------------------------
    // PE / ACQUIRED SIGNALS
    // --------------------------------------------------------
    PE_ACQUIRED: [

      "acquired by",
      "acquisition by",
      "stake acquired",
      "majority stake",
      "private equity",
      "pe-backed",
      "portfolio company",
      "taken over by",

      "kkr",
      "blackstone",
      "advent international",
      "chryscapital",
      "carlyle",
      "warburg pincus",
      "general atlantic",
      "tpg capital",
      "bain capital",
      "kedaara",
      "multiples pe",
      "true north",
    ],


    // --------------------------------------------------------
    // DIRECT REVENUE EXTRACTION
    // --------------------------------------------------------
    REVENUE: {

      REGEX:
        /(?:revenue|turnover|sales)[^\d]{0,30}(?:rs\.?|₹|inr)?\s*([\d,]+(?:\.\d+)?)\s*(?:cr|crore|crs)/i,

      MIN_CR: 50,

      MAX_CR: 500,
    },
  },



  // ----------------------------------------------------------
  // REVENUE CONFIG
  // ----------------------------------------------------------
  REVENUE: {

    // --------------------------------------------------------
    // REVENUE BANDS
    // --------------------------------------------------------
    BANDS: {

      VERY_SMALL: "<50Cr",

      MID: "50-500Cr",

      LARGE: "500-1500Cr",

      VERY_LARGE: ">1500Cr",

      UNKNOWN: "Unknown",
    },


    // --------------------------------------------------------
    // CONFIDENCE LEVELS
    // --------------------------------------------------------
    CONFIDENCE: {

      HIGH: "High",

      MEDIUM: "Medium",

      LOW: "Low",
    },


    // --------------------------------------------------------
    // REVENUE SIGNAL KEYWORDS
    // --------------------------------------------------------
    SIGNAL_KEYWORDS: [

      "employees",
      "exports",
      "manufacturing facility",
      "production capacity",
      "global markets",
      "subsidiaries",
      "hiring",
      "expansion",
      "new plant",
      "certifications",
      "usfda",
      "eu-gmp",
      "dsir",
      "international presence",
      "export revenue",
      "gmp",
      "manufacturing unit",
      "production unit",
      "factory",
      "clean room",
      "reactor capacity",
      "global customers",
    ],
  },



  // ----------------------------------------------------------
  // SERPER QUERY TEMPLATES
  // ----------------------------------------------------------
  QUERIES: {

    STAGE1_MFG:
      '"{company}" manufacturer plant factory production facility',

    STAGE1_BIZ:
      '"{company}" acquired PE investment private equity',

    REVENUE_DIRECT:
      '"{company}" (site:tofler.in OR site:zaubacorp.com OR site:screener.in OR site:moneycontrol.com OR site:tracxn.com) ("revenue" OR "turnover" OR "operating revenue") ("2024" OR "2025" OR "FY24" OR "FY25")',

    REVENUE_SIGNALS:
      '"{company}" ("annual revenue" OR "turnover" OR "crore" OR "employees" OR "workforce" OR "manufacturing plant" OR "production capacity" OR "export" OR "founded") -site:justdial.com -site:indiamart.com -site:tradeindia.com -site:facebook.com -site:instagram.com -site:sulekha.com -site:exportersindia.com',

    // CHANGED: was too narrow — demanded patents+DSIR+USFDA+WHO-GMP+EU-GMP all at once
    C3: '"{company}" chemical manufacturer India R&D innovation technical product',

    // C4 name resolution — three targeted gates, tried in order
    C4_TOFLER:  '"{company}" (director OR "managing director" OR founder OR promoter) site:tofler.in',
    C4_ZAUBA:   '"{company}" (director OR "managing director" OR founder OR promoter) site:zaubacorp.com',
    C4_GENERAL: '"{company}" ("managing director" OR "proprietor" OR "founder") India',

    C4_BACKGROUND: '"{person}" "{company}" education qualification engineer scientist PhD doctorate IIT IISc IISER NIT BITS ISRO DRDO patent publication',

    C6: '"{company}" India 2024 2025',
  },



  // ----------------------------------------------------------
  // C3 CONFIG
  // ----------------------------------------------------------
  C3: {

    SIGNAL_WEIGHTS: {

      "Patents": 2,

      "DSIR": 2,

      "Regulatory_Approvals": 2,

      "Proprietary_Products": 1,

      "Pioneer_Claims": 1,

      "Custom_Synthesis": 1,

      "Commodity_Chemicals": -2,
    },

    SCORE_MAP: [
      { minWeight: 4, score: 25 },

      { minWeight: 1, score: 12 },

      { minWeight: 0.5, score: 6 },

      { minWeight: 0, score: 0 },
    ],

    COMMODITY_FLOOR: -0.5,

    CONFIDENCE_MAP: [

      { minWeight: 4, level: "High" },

      { minWeight: 1, level: "Medium" },

      { minWeight: 0, level: "Low" },
    ],
  },



  // ----------------------------------------------------------
  // C4 CONFIG
  // ----------------------------------------------------------
  C4: {

    STRONG_SIGNALS: [

      "iit",
      "iim",
      "iiser",
      "iisc",
      "nit",
      "bits pilani",
      "phd",
      "ph.d",
      "doctorate",
      "ex-isro",
      "ex-drdo",
      "isro",
      "drdo",
      "chief scientist",
      "lead scientist",
      "principal scientist",
      "research fellow",
      "published",
      "patent holder",
    ],

    MODERATE_SIGNALS: [

      "engineer",
      "engineering",
      "b.tech",
      "b.e.",
      "m.tech",
      "m.sc",
      "technical background",
      "technical founder",
      "r&d head",
    ],

    SCORE_MAP: {

      "Strong": 20,

      "Moderate": 10,

      "None": 0,
    },
  },



  // ----------------------------------------------------------
  // C5 — GROWING SECTOR
  // ----------------------------------------------------------
  C5: {
  SECTOR_KEYWORDS: [
    // ---- HIGH TAILWIND (score 20) ----
    {
      sector: "Pharma & API",
      score: 20,
      keywords: ["api", "active pharmaceutical ingredient", "pharmaceutical intermediates",
        "bulk drugs", "pharma intermediates", "drug intermediates", "formulation",
        "nutraceutical", "generic drugs"],
      reason: "API localisation, regulated market exports.",
    },
    {
      sector: "Specialty biotech",
      score: 20,
      keywords: ["recombinant protein", "biologics", "fermentation", "enzyme",
        "probiotic", "biosimilar", "cell culture", "microbial", "biotech manufacturing"],
      reason: "High-growth specialty biotech.",
    },
    {
      sector: "Electronic & semiconductor chemicals",
      score: 20,
      keywords: ["electronic chemicals", "semiconductor", "display chemicals",
        "pcb chemicals", "etching", "photoresist"],
      reason: "Semiconductor manufacturing expansion and China+1 tailwinds.",
    },
    {
      sector: "Specialty chemicals",
      score: 20,
      keywords: ["specialty chemicals", "speciality chemicals", "fine chemicals",
        "organometallic", "niche intermediates", "advanced intermediates"],
      reason: "Export-oriented specialty manufacturing.",
    },
    {
      sector: "Defence & aerospace components",
      score: 20,
      keywords: ["defence", "defense", "aerospace", "drdo", "isro", "missile",
        "avionics", "military", "armament"],
      reason: "Strong government capex and Make-in-India push.",
    },
    {
      sector: "Medical devices & equipment",
      score: 20,
      keywords: ["medical device", "surgical", "implant", "diagnostic equipment",
        "medical equipment", "hospital equipment", "icu equipment", "ventilator"],
      reason: "High-growth domestic demand + export potential.",
    },

    // ---- STRONG TAILWIND (score 18) ----
    {
      sector: "Agrochemical intermediates",
      score: 18,
      keywords: ["agrochemical", "agrochem", "crop protection", "pesticide",
        "herbicide", "fungicide", "insecticide"],
      reason: "Agrochemical export growth.",
    },
    {
      sector: "Auto & EV components",
      score: 18,
      keywords: ["auto component", "automotive component", "ev component",
        "electric vehicle", "battery pack", "drivetrain", "chassis", "powertrain",
        "tier 1 supplier", "tier-1"],
      reason: "EV transition + auto PLI scheme.",
    },
    {
      sector: "Precision engineering & machined parts",
      score: 18,
      keywords: ["precision machined", "precision engineering", "cnc machining",
        "forging", "casting", "stamping", "sheet metal", "machined components",
        "turned parts", "tooling"],
      reason: "Export demand + import substitution.",
    },
    {
      sector: "Electronics & PCB manufacturing",
      score: 18,
      keywords: ["pcb", "printed circuit board", "electronics manufacturing",
      "electronic manufacturing services", "smt", "surface mount technology","electronics assembly"],
      reason: "PLI for electronics + China+1.",
    },

    // ---- MODERATE TAILWIND (score 16) ----
    {
      sector: "Polymer & rubber products",
      score: 16,
      keywords: ["resin", "polymer", "rubber", "gasket", "polymer additives",
        "performance chemicals", "compounding", "masterbatch"],
      reason: "Industrial materials demand.",
    },
    {
      sector: "Technical textiles & performance fabrics",
      score: 16,
      keywords: ["technical textile", "performance fabric", "nonwoven",
        "geotextile", "protective textile", "industrial fabric", "filtration fabric"],
      reason: "Technical textiles PLI and global shift from commodity to functional.",
    },
    {
      sector: "Packaging — specialty & flexible",
      score: 16,
      keywords: ["flexible packaging", "specialty packaging", "multilayer",
        "barrier film", "laminates", "aseptic packaging", "blister packaging"],
      reason: "FMCG and pharma packaging growth.",
    },
    {
      sector: "Industrial equipment & machinery",
      score: 16,
      keywords: ["industrial equipment", "industrial machinery", "process equipment",
        "heat exchanger", "pressure vessel", "reactor", "separator", "pump manufacturer",
        "valve manufacturer", "compressor"],
      reason: "Capex cycle and infrastructure push.",
    },
    {
      sector: "Food processing & ingredients",
      score: 16,
      keywords: ["food processing", "food ingredients", "food additives",
        "spice extract", "oleoresin", "natural extract", "flavour", "flavor",
        "food grade"],
      reason: "Processed food exports and value-added food manufacturing.",
    },
    {
      sector: "Water treatment chemicals",
      score: 15,
      keywords: ["water treatment", "effluent treatment", "water purification chemicals"],
      reason: "Sustainability and industrial water demand.",
    },

    // ---- STANDARD (score 12) ----
    {
      sector: "Textile — commodity",
      score: 12,
      keywords: ["spinning", "weaving", "yarn", "fabric", "dyeing", "textile mill",
        "garment", "apparel", "hosiery"],
      reason: "Large sector but highly competitive, low margins.",
    },
    {
      sector: "Construction materials",
      score: 12,
      keywords: ["cement", "tiles", "ceramic", "sanitary ware", "roofing",
        "construction chemical", "building material", "glass"],
      reason: "Infrastructure boom but commoditised.",
    },
    {
      sector: "Steel & metal fabrication",
      score: 12,
      keywords: ["steel fabrication", "metal fabrication", "structural steel",
        "stainless steel", "aluminium extrusion", "copper product", "brass"],
      reason: "Steady demand but low differentiation.",
    },
    {
      sector: "Paper & packaging — commodity",
      score: 12,
      keywords: ["paper mill", "kraft paper", "corrugated box", "carton",
        "paperboard"],
      reason: "Stable but commodity pricing.",
    },

    // ---- LOW TAILWIND (score 8) ----
    {
      sector: "Commodity / basic chemicals",
      score: 8,
      keywords: ["commodity chemicals", "basic chemicals", "bulk chemicals",
        "inorganic chemicals", "sodium sulphate", "calcium carbonate"],
      reason: "Lower differentiation.",
    },
    {
      sector: "Plastic — commodity moulding",
      score: 8,
      keywords: ["injection moulding", "plastic moulding", "plastic containers",
        "hdpe", "ldpe", "pp granules", "pet bottles"],
      reason: "Commodity, price-driven.",
    },

    // ---- VERY LOW (score 2) ----
    {
      sector: "CRO / CDMO / service",
      score: 2,
      keywords: ["cro", "cdmo", "contract research organization",
        "clinical research organization", "drug discovery services",
        "analytical testing services"],
      reason: "Service-oriented business.",
    },
  ],

  DEFAULT: {
    sector: "Other manufacturing",
    score: 8,
    reason: "Manufacturer confirmed but sector not specifically identified.",
  },
},


  // ----------------------------------------------------------
  // C6 — GROWTH SIGNALS
  // ----------------------------------------------------------
  C6: {

    SIGNALS: {

      Hiring: {
        weight: 1,
        keywords: [
          "careers",
          "job openings",
          "recruitment",
          "hiring",
          "join our team",
          "vacancies",
          "we are hiring"
        ],
      },

      Facility_Expansion: {
        weight: 1,
        keywords: [
          "new plant",
          "expansion",
          "capacity increase",
          "scale-up",
          "greenfield",
          "brownfield",
          "new facility",
          "upgraded facility",
          "new unit"
        ],
      },

      Certifications: {
        weight: 1,
        keywords: [
          "who-gmp",
          "usfda",
          "eu-gmp",
          "iso certified",
          "dsir",
          "halal",
          "kosher",
          "reach certified",
          "gmp certified",
          "approved facility"
        ],
      },

      Active_News: {
        weight: 1,
        keywords: [
          "2024",
          "2025",
          "press release",
          "latest news",
          "recent",
          "announcement",
          "blog"
        ],
      },

      Export_Growth: {
        weight: 1,
        keywords: [
          "exports",
          "export destinations",
          "global markets",
          "international customers",
          "usa",
          "europe",
          "japan",
          "revenue growth",
          "export revenue"
        ],
      },
    },

    SCORE_MAP: [
      { minStrength: 2, score: 20 },
      { minStrength: 1, score: 10 },
      { minStrength: 0, score: 0 },
    ],

    CONFIDENCE_MAP: [
      { minStrength: 3, level: "High" },
      { minStrength: 1, level: "Medium" },
      { minStrength: 0, level: "Low" },
    ],
  },



  // ----------------------------------------------------------
  // FINAL SCORE WEIGHTS
  // ----------------------------------------------------------
  WEIGHTS: {

    C1: 10,

    C2: 5,

    C3: 25,

    C4: 20,

    C5: 20,

    C6: 20,
  },



  // ----------------------------------------------------------
  // BAND CLASSIFICATION
  // ----------------------------------------------------------
  BANDS: [

    {
      min: 80,
      max: 100,
      band: "A",
      label: "Strong Federer"
    },

    {
      min: 60,
      max: 79,
      band: "B",
      label: "Probable Federer"
    },

    {
      min: 40,
      max: 59,
      band: "C",
      label: "Borderline"
    },

    {
      min: 0,
      max: 39,
      band: "D",
      label: "Not ICP"
    },
  ],

  SHORTLIST_MIN_BAND: "B",

  SHORTLIST_TARGET: 25,



  // ----------------------------------------------------------
  // PROMPTS
  // ----------------------------------------------------------
  PROMPTS: {

    // --------------------------------------------------------
    // REVENUE PROMPT
    // --------------------------------------------------------
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

    // --------------------------------------------------------
    // C3 PROMPT
    // --------------------------------------------------------
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



    // --------------------------------------------------------
    // C4 PROMPT
    // -------------------------------------------------------- 
    // Gemini call 1 — name extraction only, lightweight
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

      // Gemini call 2 — depth classification only, no name needed
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

    // --------------------------------------------------------
    // C6 PROMPT
    // -------------------------------------------------------- 
    C6: `You are evaluating growth signals for an Indian manufacturer.
        Evidence: {evidence}

        Return ONLY this exact JSON with no other text:
        {"hiring":false,"facility":false,"certifications":false,"active":false,"exports":false,"x":"max 15 words on strongest signal"}

        hiring = true if job postings, recruitment, team expansion, or headcount growth mentioned
        facility = true if new plant, capacity increase, greenfield, brownfield, expansion, new unit mentioned
        certifications = true if USFDA, WHO-GMP, EU-GMP, DSIR, ISO, HALAL, REACH, or approval mentioned
        active = true if any news, press release, announcement, blog, or event from 2024 or 2025
        exports = true if export destinations, global customers, USA, Europe, Japan, or revenue growth mentioned`,

  },
};


// ============================================================
// HELPERS
// ============================================================

function buildQuery(template, companyName) {

  return template.replace(
    /\{company\}/g,
    companyName
  );
}



function buildPrompt(
  promptKey,
  companyName,
  evidenceText
) {

  return CONFIG.PROMPTS[promptKey]
    .replace(/\{company\}/g, companyName)
    .replace(/\{evidence\}/g, evidenceText);
}



function getC3Score(totalWeight) {

  for (const entry of CONFIG.C3.SCORE_MAP) {

    if (totalWeight >= entry.minWeight) {
      return entry.score;
    }
  }

  return 0;
}



function getBand(finalScore) {

  for (const entry of CONFIG.BANDS) {

    if (
      finalScore >= entry.min &&
      finalScore <= entry.max
    ) {

      return {
        band: entry.band,
        label: entry.label,
      };
    }
  }

  return {
    band: "D",
    label: "Not ICP",
  };
}

function getC6Score(totalStrength) {
  for (const entry of CONFIG.C6.SCORE_MAP) {
    if (totalStrength >= entry.minStrength) return entry.score;
  }
  return 0;
}

function getC6Confidence(totalStrength) {
  for (const entry of CONFIG.C6.CONFIDENCE_MAP) {
    if (totalStrength >= entry.minStrength) return entry.level;
  }
  return "Low";
}

