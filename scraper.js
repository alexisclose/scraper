const { chromium } = require("playwright-extra");
const stealth = require("puppeteer-extra-plugin-stealth")();

chromium.use(stealth);
const fs = require("fs");
const path = require("path");

function mapModelId(classId) {
  if (!classId) return null;
  return classId.toUpperCase().replace("-CLASS", "");
}

function mapBodyType(bodytypeId) {
  if (!bodytypeId) return null;
  const map = {
    "saloon": "LIMOUSINE",
    "saloon-long": "LONG_SEDAN",
    "estate": "STATION",
    "offroader": "SUV_OFFROADER",
    "shooting-brake": "SHOOTING_BRAKE",
    "hatchback": "HATCHBACK",
    "coupe": "COUPE",
    "cabriolet": "CABRIO_ROADSTER",
    "roadster": "CABRIO_ROADSTER",
    "people-carrier": "PEOPLE_CARRIER",
    "camper": "MARCO_POLO"
  };
  return map[bodytypeId] || bodytypeId.toUpperCase();
}

// ── FCIS Balloon Financing API ────────────────────────────────────────────
const FCIS_API_URL = "https://api.oneweb.mercedes-benz.com/fcis-calculation-api/v1/calculation/CC/BE/nl";

// ── Configurable Balloon Financing Parameters ─────────────────────────────
const BALLOON_DURATION = "48";         // Options: "24", "36", "48", "60"
const BALLOON_DOWNPAYMENT_PCT = 0.20;  // 20% down payment
const BALLOON_CUSTOMER_TYPE = "business"; // "business" or "private"

const FCIS_HEADERS = {
  "Content-Type": "application/json",
  "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/122.0.0.0 Safari/537.36",
  "Origin": "https://www.mercedes-benz.be",
  "Referer": "https://www.mercedes-benz.be/"
};

const BALLOON_RESIDUAL_PCT = 0.25; // Balloon (final payment) defaults to 25% — matches MB website
const FALLBACK_BAUMUSTER = "2446131"; // GLB baumuster as fallback for pages without FCIS widget

// Cache: modelUrl → baumuster
const baumusterCache = new Map();

async function captureBaumuster(context, modelUrl) {
  if (baumusterCache.has(modelUrl)) return baumusterCache.get(modelUrl);

  let captured = null;
  const freshPage = await context.newPage();

  await freshPage.route("**/fcis-calculation-api/**", async (route) => {
    const req = route.request();
    if (req.method() === "POST") {
      try {
        const body = JSON.parse(req.postData());
        const bm = body?.vehicle?.vehicleConfiguration?.baumuster;
        if (bm && !captured) captured = bm;
      } catch (e) { }
    }
    await route.continue();
  });

  try {
    await freshPage.goto(modelUrl, { waitUntil: "domcontentloaded", timeout: 30000 });

    // Dismiss cookie banner if present
    try {
      await freshPage.evaluate(() => {
        const banner = document.querySelector('cmm-cookie-banner');
        if (banner && banner.shadowRoot) {
          const btn = banner.shadowRoot.querySelector('button[data-test="handle-accept-all-button"]');
          if (btn) btn.click();
        }
      });
    } catch (e) { }

    await freshPage.waitForTimeout(6000);

    // If widget didn't fire, scroll to trigger lazy loading
    if (!captured) {
      await freshPage.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
      await freshPage.waitForTimeout(4000);
    }
  } catch (e) { }

  await freshPage.close();

  if (captured) {
    baumusterCache.set(modelUrl, captured);
  }
  return captured || FALLBACK_BAUMUSTER; // Use fallback for pages without FCIS widget
}

async function fetchBalloonFinancing(context, carPrice, modelUrl) {
  if (!carPrice || carPrice <= 0) return null;

  // Step 1: Capture the model's real baumuster from its page
  const baumuster = await captureBaumuster(context, modelUrl);
  if (!baumuster) return null;

  // Step 2: Init call to get the engine ID for this baumuster
  let engineId = null;
  let fundingProductValue = "Balloon Financing Prof (compact cars)";
  try {
    const initRes = await fetch(FCIS_API_URL, {
      method: "POST",
      headers: FCIS_HEADERS,
      body: JSON.stringify({
        vehicle: {
          condition: { condition: "new" },
          prices: [
            { id: "baseListPrice", currency: "EUR", rawValue: carPrice },
            { id: "grossListPrice", currency: "EUR", rawValue: carPrice }
          ],
          vehicleConfiguration: {
            division: "pc", brand: "mercedes-benz",
            baumuster, equipments: []
          },
          technicalData: [],
          alternativeConfiguration: []
        },
        input: [
          { id: "customerType", value: BALLOON_CUSTOMER_TYPE }
        ]
      })
    });
    if (!initRes.ok) return null;
    const initData = await initRes.json();
    engineId = JSON.parse(initData.opaque)?._engineId || null;

    const fpItem = initData.input?.items?.find(i => i.id === "fundingProduct");
    if (fpItem && fpItem.values) {
      const targetOpt = fpItem.values.find(v => v.label === "Ballonfinanciering" || String(v.value).includes("Balloon Financing"));
      if (targetOpt) {
        fundingProductValue = targetOpt.value;
      }
    }
  } catch (e) {
    return null;
  }
  if (!engineId) return null;

  // Step 3: Calculate amounts using gross price
  const downpayment = String(Math.round(carPrice * BALLOON_DOWNPAYMENT_PCT * 100) / 100);
  const balloon = String(Math.round(carPrice * BALLOON_RESIDUAL_PCT * 100) / 100);

  const payload = {
    vehicle: {
      condition: { condition: "new" },
      prices: [
        { id: "baseListPrice", currency: "EUR", rawValue: carPrice },
        { id: "grossListPrice", currency: "EUR", rawValue: carPrice }
      ],
      vehicleConfiguration: {
        division: "pc", brand: "mercedes-benz",
        baumuster, equipments: []
      },
      technicalData: [],
      alternativeConfiguration: []
    },
    input: [
      { id: "fundingProduct", value: fundingProductValue },
      { id: "customerType", value: BALLOON_CUSTOMER_TYPE },
      { id: "carPrice", value: String(carPrice) },
      { id: "downpayment", value: downpayment },
      { id: "duration", value: BALLOON_DURATION },
      { id: "balloon", value: balloon }
    ],
    opaque: JSON.stringify({
      services: {},
      _engineId: engineId,
      _downpayment: true,
      "_dp%": BALLOON_DOWNPAYMENT_PCT,
      _balloon: true,
      _carPrice: carPrice,
      customerType: BALLOON_CUSTOMER_TYPE,
      fundingProduct: fundingProductValue,
      carPrice: String(carPrice),
      downpayment: downpayment,
      duration: BALLOON_DURATION,
      balloon: balloon
    })
  };

  try {
    const res = await fetch(FCIS_API_URL, {
      method: "POST",
      headers: FCIS_HEADERS,
      body: JSON.stringify(payload)
    });

    if (!res.ok) return null;

    const data = await res.json();
    const fullSummary = data?.output?.containers?.find(c => c.id === "fullSummary");
    if (!fullSummary) return null;

    const getField = (id) => {
      const item = fullSummary.items?.find(i => i.id === id);
      return item ? { value: item.value, businessValue: item.businessValue } : null;
    };

    // Get the balloon field from the input section
    const balloonInput = data?.input?.items?.find(i => i.id === "balloon");
    const balloonLabel = balloonInput?.value?.label || "N/A";
    const balloonValue = balloonInput?.value?.value || "0";

    return {
      monthlyPayment: getField("pmtGross")?.value || data?.output?.rate || "N/A",
      monthlyPaymentRaw: parseFloat(getField("pmtGross")?.businessValue || "0"),
      interestRate: getField("anr")?.value || "N/A",
      interestRateRaw: parseFloat(getField("anr")?.businessValue || "0"),
      apr: getField("apr")?.value || "N/A",
      downPayment: getField("dpGross")?.value || "N/A",
      downPaymentRaw: parseFloat(getField("dpGross")?.businessValue || "0"),
      duration: getField("numberInstallments")?.value || "N/A",
      durationRaw: parseInt(getField("numberInstallments")?.businessValue || "0"),
      lastInstallment: balloonLabel,
      lastInstallmentRaw: parseFloat(balloonValue),
      balloonPayment: getField("rvBalloon")?.value || "N/A",
      balloonPaymentRaw: parseFloat(getField("rvBalloon")?.businessValue || "0"),
      totalCost: getField("totalCost")?.value || "N/A",
      totalCostRaw: parseFloat(getField("totalCost")?.businessValue || "0"),
      creditAmount: getField("invoicingPrice")?.value || "N/A",
      financingProduct: data?.output?.financingProduct?.label || "Ballonfinanciering"
    };
  } catch (e) {
    return null;
  }
}

// ── Model list derived from the Mercedes-Benz Belgium navigation menu ─────
const MODELS = [
  // Berline
  { name: "CLA Elektrisch", category: "Berline", url: "https://www.mercedes-benz.be/nl_BE/passengercars/models/saloon/cla-electric/overview.html" },
  { name: "CLA", category: "Berline", url: "https://www.mercedes-benz.be/nl_BE/passengercars/models/saloon/cla/overview.html" },
  { name: "C-Klasse Berline", category: "Berline", url: "https://www.mercedes-benz.be/nl_BE/passengercars/models/saloon/c-class/overview.html" },
  { name: "EQE Berline", category: "Berline", url: "https://www.mercedes-benz.be/nl_BE/passengercars/models/saloon/eqe/overview.html" },
  { name: "EQS Berline", category: "Berline", url: "https://www.mercedes-benz.be/nl_BE/passengercars/models/saloon/eqs/overview.html" },
  { name: "E-Klasse Berline", category: "Berline", url: "https://www.mercedes-benz.be/nl_BE/passengercars/models/saloon/e-class/overview.html" },
  { name: "S-Klasse", category: "Berline", url: "https://www.mercedes-benz.be/nl_BE/passengercars/models/saloon/s-class/overview.html" },
  { name: "S-Klasse Lang", category: "Berline", url: "https://www.mercedes-benz.be/nl_BE/passengercars/models/saloon-long/s-class/overview.html" },
  { name: "Mercedes-Maybach S-Klasse", category: "Berline", url: "https://www.mercedes-benz.be/nl_BE/passengercars/models/saloon-long/mercedes-maybach-s-class/overview.html" },
  // SUV
  { name: "EQA", category: "SUV", url: "https://www.mercedes-benz.be/nl_BE/passengercars/models/suv/eqa/overview.html" },
  { name: "EQB", category: "SUV", url: "https://www.mercedes-benz.be/nl_BE/passengercars/models/suv/eqb/overview.html" },
  { name: "EQE SUV", category: "SUV", url: "https://www.mercedes-benz.be/nl_BE/passengercars/models/suv/eqe/overview.html" },
  { name: "EQS SUV", category: "SUV", url: "https://www.mercedes-benz.be/nl_BE/passengercars/models/suv/eqs/overview.html" },
  { name: "Mercedes-Maybach EQS SUV", category: "SUV", url: "https://www.mercedes-benz.be/nl_BE/passengercars/models/suv/maybach-eqs/overview.html" },
  { name: "GLA", category: "SUV", url: "https://www.mercedes-benz.be/nl_BE/passengercars/models/suv/gla/overview.html" },
  { name: "GLB Elektrisch", category: "SUV", url: "https://www.mercedes-benz.be/nl_BE/passengercars/models/suv/glb-electric/overview.html" },
  { name: "GLC Elektrisch", category: "SUV", url: "https://www.mercedes-benz.be/nl_BE/passengercars/models/suv/glc-electric/overview.html" },
  { name: "GLC", category: "SUV", url: "https://www.mercedes-benz.be/nl_BE/passengercars/models/suv/glc/overview.html" },
  { name: "GLC Coupé", category: "SUV", url: "https://www.mercedes-benz.be/nl_BE/passengercars/models/suv/glc-coupe/overview.html" },
  { name: "GLE", category: "SUV", url: "https://www.mercedes-benz.be/nl_BE/passengercars/models/suv/gle/overview.html" },
  { name: "GLE Coupé", category: "SUV", url: "https://www.mercedes-benz.be/nl_BE/passengercars/models/suv/gle-coupe/overview.html" },
  { name: "GLS", category: "SUV", url: "https://www.mercedes-benz.be/nl_BE/passengercars/models/suv/gls/overview.html" },
  { name: "Mercedes-Maybach GLS", category: "SUV", url: "https://www.mercedes-benz.be/nl_BE/passengercars/models/suv/maybach-gls/overview.html" },
  { name: "G-Klasse Elektrisch", category: "SUV", url: "https://www.mercedes-benz.be/nl_BE/passengercars/models/suv/g-class-electric/overview.html" },
  { name: "G-Klasse Terreinwagen", category: "SUV", url: "https://www.mercedes-benz.be/nl_BE/passengercars/models/suv/g-class/overview.html" },
  // Break
  { name: "CLA Shooting Brake Elektrisch", category: "Break", url: "https://www.mercedes-benz.be/nl_BE/passengercars/models/estate/cla-shooting-brake-electric/overview.html" },
  { name: "CLA Shooting Brake", category: "Break", url: "https://www.mercedes-benz.be/nl_BE/passengercars/models/estate/cla-shooting-brake/overview.html" },
  { name: "C-Klasse Break", category: "Break", url: "https://www.mercedes-benz.be/nl_BE/passengercars/models/estate/c-class/overview.html" },
  { name: "E-Klasse Break", category: "Break", url: "https://www.mercedes-benz.be/nl_BE/passengercars/models/estate/e-class/overview.html" },
  // Hatchback
  { name: "A-Klasse Hatchback", category: "Hatchback", url: "https://www.mercedes-benz.be/nl_BE/passengercars/models/hatchback/a-class/overview.html" },
  { name: "B-Klasse", category: "Hatchback", url: "https://www.mercedes-benz.be/nl_BE/passengercars/models/hatchback/b-class/overview.html" },
  // Coupé
  { name: "CLA Coupé", category: "Coupé", url: "https://www.mercedes-benz.be/nl_BE/passengercars/models/coupe/cla/overview.html" },
  { name: "CLE Coupé", category: "Coupé", url: "https://www.mercedes-benz.be/nl_BE/passengercars/models/coupe/cle/overview.html" },
  { name: "Mercedes-AMG GT Coupé", category: "Coupé", url: "https://www.mercedes-benz.be/nl_BE/passengercars/models/coupe/amg-gt-2-door/overview.html" },
  // Cabrio
  { name: "CLE Cabriolet", category: "Cabrio", url: "https://www.mercedes-benz.be/nl_BE/passengercars/models/cabriolet-roadster/cle/overview.html" },
  { name: "Mercedes-AMG SL Roadster", category: "Cabrio", url: "https://www.mercedes-benz.be/nl_BE/passengercars/models/cabriolet-roadster/sl/overview.html" },
  { name: "Mercedes-Maybach SL", category: "Cabrio", url: "https://www.mercedes-benz.be/nl_BE/passengercars/models/cabriolet-roadster/mercedes-maybach-sl/overview.html" },
  // MPV
  { name: "EQT", category: "MPV", url: "https://www.mercedes-benz.be/nl_BE/passengercars/models/van/eqt/overview.html" },
  { name: "EQV", category: "MPV", url: "https://www.mercedes-benz.be/nl_BE/passengercars/models/van/eqv/overview.html" },
  { name: "T-Klasse", category: "MPV", url: "https://www.mercedes-benz.be/nl_BE/passengercars/models/van/t-class/overview.html" },
  { name: "V-Klasse", category: "MPV", url: "https://www.mercedes-benz.be/nl_BE/passengercars/models/van/v-class/overview.html" },
  { name: "Marco Polo", category: "MPV", url: "https://www.mercedes-benz.be/nl_BE/passengercars/models/van/marco-polo/overview.html" },
];

async function scrape() {
  console.log("🚗 Mercedes-Benz Belgium Price Scraper (Bulk + Leasing Extraction)");
  console.log("━".repeat(70));

  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({
    locale: "nl-BE",
    userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/122.0.0.0 Safari/537.36",
  });

  const results = [];

  try {
    const page = await context.newPage();
    console.log("1. Fetching Starting Prices from Models Overview...");

    await page.goto("https://www.mercedes-benz.be/nl_BE/passengercars/models.html?group=all", {
      waitUntil: "domcontentloaded",
      timeout: 30000,
    });

    await page.waitForTimeout(5000);
    const html = await page.content();
    console.log(`   Page loaded. HTML size: ${Math.round(html.length / 1024)} KB.`);

    // Extract JSON blobs from HTML
    const extractedModels = new Map();
    let startIdx = 0;
    while (true) {
      const idx = html.indexOf('"technicalData":{"priceData"', startIdx);
      if (idx === -1) break;

      let start = idx;
      let depth = 0;
      for (let i = idx; i >= Math.max(0, idx - 1000); i--) {
        if (html[i] === '}') depth++;
        if (html[i] === '{') {
          if (depth === 0) { start = i; break; }
          depth--;
        }
      }

      let end = idx;
      depth = 0;
      for (let i = start; i < Math.min(html.length, start + 3000); i++) {
        if (html[i] === '{') depth++;
        if (html[i] === '}') {
          depth--;
          if (depth === 0) { end = i + 1; break; }
        }
      }

      const jsonStr = html.substring(start, end);
      try {
        const obj = JSON.parse(jsonStr);
        if (obj.name && obj.technicalData && obj.technicalData.priceData) {
          let key = obj.name;
          if (obj.technicalData.priceData.all?.filters?.ELECTRIC) {
            key += " Elektrisch";
          }
          if (!extractedModels.has(key)) {
            extractedModels.set(key, obj);
          }
        }
      } catch (e) { }
      startIdx = idx + 1;
    }

    console.log(`   Found ${extractedModels.size} starting prices.\n`);

    // Cookie dismissal helper
    let cookiesDismissed = false;

    // 2. Query Monthly Leasing Price for Each Model via Direct GraphQL Navigation
    console.log("2. Proceeding to fetch Monthly Leasing Prices...");

    for (let i = 0; i < MODELS.length; i++) {
      const model = MODELS[i];
      let data = extractedModels.get(model.name);

      if (!data) {
        // Try multiple name variants to find the model in the overview page data
        const variants = [
          model.name + " Elektrisch",           // EQ models stored with Elektrisch suffix
          model.name.replace(" Elektrisch", ""), // Our list says Elektrisch but data doesn't
          model.name.replace("Mercedes-Maybach ", ""),
          model.name.replace("Mercedes-AMG ", ""),
        ];
        for (const v of variants) {
          if (extractedModels.has(v)) { data = extractedModels.get(v); break; }
        }
      }
      // Specific fallbacks for known naming mismatches
      if (!data && model.name === "GLB Elektrisch") data = extractedModels.get("GLB Elektrisch") || extractedModels.get("GLB");
      if (!data && model.name === "GLC Elektrisch") data = extractedModels.get("GLC Elektrisch") || extractedModels.get("GLC");
      if (!data && model.name === "GLC Coupé") data = extractedModels.get("GLC Coupé");
      if (!data && model.name === "G-Klasse Elektrisch") data = extractedModels.get("G-Klasse Terreinwagen Elektrisch");
      if (!data && model.name === "Mercedes-Maybach SL") data = extractedModels.get("Mercedes-Maybach SL Monogram Series");

      let startingPrice = "N/A";
      let classId = null;
      let bodytypeId = null;

      if (data && data.technicalData && data.technicalData.priceData) {
        startingPrice = data.technicalData.priceData.all?.formattedValue || "N/A";
        classId = data.classId;
        bodytypeId = data.bodytypeId;
      }

      let monthlyPrice = "N/A";

      // If we have classId and bodytypeId, we can search the "Available Stock" filter
      // to extract the monthly leasing price from a real available car configuration
      if (classId && bodytypeId) {
        try {
          process.stdout.write(`   [${i + 1}/${MODELS.length}] ${model.name} : Fetching stock... `);

          const mId = mapModelId(classId);
          const bType = mapBodyType(bodytypeId);

          if (mId && bType) {
            const query = `query GetSearchResults($language: String, $limit: Int!, $profileId: String!, $sortingType: String!, $contextType: ContextType!, $page: Int!, $vehicleCategory: String!, $modelIdentifier: [VehicleClass!], $bodyType: [BodyType!]) { search( language: $language limit: $limit profileId: $profileId sortingType: $sortingType contextType: $contextType page: $page vehicleCategory: $vehicleCategory modelIdentifier: $modelIdentifier bodyType: $bodyType ) { facets { monthlyRate { ... on RangeFacet { values { min } } } } } }`;

            const variables = {
              "limit": 1,
              "sortingType": "price-asc",
              "contextType": "B2C",
              "page": 0,
              "language": "nl",
              "profileId": "BE-NEW_VEHICLES",
              "vehicleCategory": "PASSENGER-CARS",
              "modelIdentifier": [mId],
              "bodyType": [bType]
            };

            const res = await fetch("https://eu.api.oneweb.mercedes-benz.com/commerce/onesearch/graphql", {
              method: "POST",
              headers: {
                "content-type": "application/json",
                "x-api-key": "d1dcd3a9-25fd-4896-b041-4d35cfdbb482",
                "user-agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36",
              },
              body: JSON.stringify({ query: query, variables: variables })
            });

            if (res.status === 200) {
              const data = await res.json();
              if (data.errors) {
                console.log("\nGraphQL Error:", JSON.stringify(data.errors));
              }
              const rate = data?.data?.search?.facets?.monthlyRate?.values?.min;
              if (rate) {
                monthlyPrice = `Vanaf € ${String(rate.toFixed(2)).replace(".", ",")} / maand`;
              } else {
                console.log(`\nMissing rate for ${mId} ${bType}! Payload:`, JSON.stringify(data).substring(0, 300));
              }
            } else {
              console.log("\nHTTP Error:", res.status, await res.text());
            }
          }
          console.log(monthlyPrice);

        } catch (err) {
          console.log(`Failed. (${err.message.substring(0, 25)})`);
        }
      } else {
        console.log(`   [${i + 1}/${MODELS.length}] ${model.name} : Skipped (No metadata)`);
      }

      // 3. Fetch Balloon Financing via FCIS API
      let balloonFinancing = null;
      if (startingPrice !== "N/A") {
        const priceNum = parseFloat(startingPrice.replace(/[^\d,]/g, "").replace(",", "."));
        if (priceNum > 0) {
          process.stdout.write(`   [${i + 1}/${MODELS.length}] ${model.name} : Balloon financing... `);
          balloonFinancing = await fetchBalloonFinancing(context, priceNum, model.url);
          if (balloonFinancing) {
            console.log(`${balloonFinancing.monthlyPayment}/maand @ ${balloonFinancing.interestRate}`);
          } else {
            console.log("N/A");
          }
        }
      }

      results.push({
        model: model.name,
        category: model.category,
        startingPrice,
        monthlyPrice,
        url: model.url,
        balloonFinancing: balloonFinancing || {
          monthlyPayment: "N/A",
          interestRate: "N/A",
          apr: "N/A",
          downPayment: "N/A",
          duration: "N/A",
          lastInstallment: "N/A",
          balloonPayment: "N/A",
          totalCost: "N/A",
          creditAmount: "N/A",
          financingProduct: "N/A"
        },
      });
    }

    // ── Save results ────────────────────────────────────────
    const outDir = path.resolve(__dirname);
    const jsonPath = path.join(outDir, "results.json");
    const csvPath = path.join(outDir, "results.csv");

    try {
      fs.writeFileSync(jsonPath, JSON.stringify(results, null, 2), "utf-8");
      console.log(`\n✅ Saved ${results.length} models to results.json`);
    } catch (e) {
      console.error(`\n❌ Failed to save results.json: ${e.message}`);
    }

    try {
      const csvHeader = "Model,Category,Starting Price,Monthly Lease Price,Balloon Monthly Payment,Balloon Interest Rate,Balloon APR,Balloon Down Payment,Balloon Duration,Balloon Last Installment,Balloon Final Payment,Balloon Total Cost,Balloon Credit Amount,URL";
      const csvRows = results.map(
        (m) => `"${m.model}","${m.category}","${m.startingPrice}","${m.monthlyPrice}","${m.balloonFinancing?.monthlyPayment || 'N/A'}","${m.balloonFinancing?.interestRate || 'N/A'}","${m.balloonFinancing?.apr || 'N/A'}","${m.balloonFinancing?.downPayment || 'N/A'}","${m.balloonFinancing?.duration || 'N/A'}","${m.balloonFinancing?.lastInstallment || 'N/A'}","${m.balloonFinancing?.balloonPayment || 'N/A'}","${m.balloonFinancing?.totalCost || 'N/A'}","${m.balloonFinancing?.creditAmount || 'N/A'}","${m.url}"`
      );
      fs.writeFileSync(csvPath, "\uFEFF" + [csvHeader, ...csvRows].join("\n"), "utf-8");
      console.log(`✅ Saved ${results.length} models to results.csv`);
    } catch (e) {
      console.error(`❌ Failed to save results.csv: ${e.message} (Is it open in Excel?)`);
    }

    console.log("\n" + "━".repeat(80));
    console.table(
      results.map((m) => ({
        Model: m.model,
        "Starting Price": m.startingPrice,
        "Balloon/mo": m.balloonFinancing?.monthlyPayment || "N/A",
        "Interest": m.balloonFinancing?.interestRate || "N/A",
        "Down Payment": m.balloonFinancing?.downPayment || "N/A",
        "Duration": m.balloonFinancing?.duration || "N/A",
        "Last Installment": m.balloonFinancing?.lastInstallment || "N/A",
      }))
    );

  } catch (err) {
    console.error("❌ Fatal error:", err.message);
  } finally {
    await browser.close();
    console.log("\nBrowser closed.");
  }
}

scrape().catch(console.error);
