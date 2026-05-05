// Mercedes-Benz Belgium scraper — Financial Renting (60 mo / 20% downpayment)
//
// Speed strategy (mirrors the BMW scraper's "one HTTP per model" model):
//   1. Fetch the public VMOS summary endpoint ONCE — it returns every
//      configurable Mercedes variant with its `bm4` (4-digit baumuster prefix)
//      + name + starting price.
//   2. For each variant, build a 7-digit baumuster = `bm4 + suffix`. We seed
//      the suffix table with the known-good values captured earlier (one
//      Playwright pass — already done; cached here in code). Anything missing
//      falls back to "111", a common entry-level engine code that the FCIS
//      engine accepts for pricing.
//   3. Call FCIS calculation API with customerType=business, fundingProduct=Renting,
//      duration=60, firstPayment=20% × carPriceNet. Pure HTTP — no browser.
//   4. Compute the implied effective annual interest rate from the cashflows
//      (FCIS Renting doesn't return a rate field — same as BMW we publish it).
//
// Output: mercedes-results.json in the same shape as bmw-results.json.

const fs = require("fs");
const path = require("path");

const VMOS_URL =
  "https://api.oneweb.mercedes-benz.com/vmos-api/v1/data/BE/nl/OWF/live/summary";
const FCIS_URL =
  "https://api.oneweb.mercedes-benz.com/fcis-calculation-api/v1/calculation/CC/BE/nl";
const HDR = {
  "Content-Type": "application/json",
  "User-Agent":
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/122.0.0.0 Safari/537.36",
  Origin: "https://www.mercedes-benz.be",
  Referer: "https://www.mercedes-benz.be/",
};

// Known baumuster suffixes per `<modelSeries>` (captured earlier from real
// /fcis-calculation-api/SPA/.../<bm>_BES-… requests). Used to build a real
// 7-digit baumuster from a 4-digit bm4. For series we haven't seen yet we
// fall back to "111".
const KNOWN_SUFFIX_BY_SERIES = {
  C178: "421",       // CLA saloon → 1783421
  X178: "421",       // CLA Shooting Brake (assumed similar to C178)
  W206: "411",       // C-Class saloon → 2060411
  S206: "111",       // C-Class break (entry trim)
  W214: "031",       // E-Class saloon (E220d) — common entry
  S214: "031",       // E-Class break (entry)
  W223: "031",       // S-Class
  V223: "031",       // S-Class long
  "V295": "111",     // EQE saloon → 2951111
  "X294": "111",     // EQE SUV → 2946211 captured, but use 111 as starter
  "V297": "131",     // EQS saloon → 2971131 captured
  "X296": "231",     // EQS SUV → 2966231 captured
  "Z296": "551",     // Maybach EQS SUV → 2969551 captured
  "H243": "021",     // EQA → 2437021
  "H247": "841",     // GLA → 2477841
  "X244": "101",     // GLB → 2446101 captured (note: classic GLB)
  "X248": "131",     // GLB electric → fallback
  "W247": "111",     // B-Class
  "X254": "021",     // GLC SUV → 2546021
  "C254": "021",     // GLC Coupé → 2543021
  "X540": "321",     // GLC electric → 5406321
  "C167": "111",     // GLE Coupé
  "V167": "111",     // GLE
  "X167": "111",     // GLS
  "C236": "111",     // CLE Coupé
  "A236": "111",     // CLE Cabrio
  "C192": "111",     // AMG GT
  "R232": "111",     // AMG SL
  "Z232": "111",     // Maybach SL
  "W465": "111",     // G-Class
  "N465": "011",     // G-Class electric → 4656011
  "C174": "111",     // CLA Coupé old
  "X174": "111",     // CLA Shooting Brake old
  "W177": "111",     // A-Class
  "E420": "111",     // EQT
  "V420": "111",     // T-Class
  "R447": "1313",    // Marco Polo → 44781313 (8-digit!)
  "V447": "1113",    // V-Klasse → 44781113 (8-digit!)
  "E447": "111",     // EQV
  "Z223": "111",     // Maybach S-Class
};

function fmtEUR(n) {
  if (n == null || isNaN(n)) return "N/A";
  return "€ " + n.toLocaleString("nl-BE", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

// Standard amortising-lease implied APR
function impliedAnnualRate(financed, residual, monthly, term) {
  if (!financed || !monthly || !term) return null;
  const f = (rate) => {
    const m = rate / 12;
    if (Math.abs(m) < 1e-12) return monthly - (financed - residual) / term;
    return (
      monthly -
      (financed - residual / Math.pow(1 + m, term)) * (m / (1 - Math.pow(1 + m, -term)))
    );
  };
  let lo = 0,
    hi = 1.0;
  if (f(lo) < 0) return 0;
  if (f(hi) > 0) return null;
  for (let i = 0; i < 80; i++) {
    const mid = (lo + hi) / 2;
    if (f(mid) > 0) lo = mid;
    else hi = mid;
  }
  const r = (lo + hi) / 2;
  return Number.isFinite(r) && r >= 0 && r < 1 ? r : null;
}

// Strip series suffix qualifiers like "-fl", "-fl2", "|maybach", "|all-terrain"
function rawSeries(modelSeries) {
  if (!modelSeries) return null;
  return modelSeries.split(/[|\-]/)[0];
}

function buildBaumuster(bm4, modelSeries) {
  if (!bm4) return null;
  const suffix = KNOWN_SUFFIX_BY_SERIES[rawSeries(modelSeries)] || "111";
  return bm4 + suffix;
}

async function fetchModels() {
  const res = await fetch(VMOS_URL, { headers: HDR });
  if (!res.ok) throw new Error("VMOS fetch HTTP " + res.status);
  const j = await res.json();
  const out = [];
  for (const [k, v] of Object.entries(j.vehiclesData || {})) {
    if (k.startsWith("all.")) continue;
    if (!v.bm4 || !v.technicalData?.priceData?.all?.value) continue;
    out.push({
      vmosKey: k,
      name: v.name,
      classId: v.classId,
      bodytypeId: v.bodytypeId,
      modelSeries: v.modelSeries,
      bm4: v.bm4,
      priceGross: v.technicalData.priceData.all.value,
      priceFormatted: v.technicalData.priceData.all.formattedValue,
      baumuster: buildBaumuster(v.bm4, v.modelSeries),
    });
  }

  // Disambiguate identical short names (e.g. two "CLA" entries for C174 + C178)
  // by appending the model series. Unique names are left alone.
  const counts = {};
  out.forEach((m) => (counts[m.name] = (counts[m.name] || 0) + 1));
  for (const m of out) {
    m.displayName =
      counts[m.name] > 1 && m.modelSeries
        ? `${m.name} (${m.modelSeries.split("|")[0]})`
        : m.name;
  }
  return out;
}

// The configurator's `entry` endpoint returns the trim name (e.g. "CLA 200
// electric") for any baumuster you pass. The class-code in the URL barely
// matters: CCci/Ccii/Esci/Gelci all happily resolve a baumuster from any
// class — except a handful return HTTP 500. So we just try a small list of
// generic codes in order until one works.
const TRIM_DATAVERSION_CACHE = { v: null };
async function getDataVersion() {
  if (TRIM_DATAVERSION_CACHE.v) return TRIM_DATAVERSION_CACHE.v;
  const v = await fetch(
    "https://api.oneweb.mercedes-benz.com/owcc-backend/api/v3/nl_BE/CCci/version",
    { headers: HDR }
  );
  if (!v.ok) return null;
  const { dataVersion } = await v.json();
  TRIM_DATAVERSION_CACHE.v = dataVersion;
  return dataVersion;
}

const CLASS_CODE_FALLBACKS = [
  "CCci", "Ccii", "Ecii", "EQEcii", "EQSsci", "GLCci", "GLEci", "Gelci",
  "Tci", "Vci", "AMGGTci", "MarcoPoloci",
];

// Loose consistency check: does the trim name plausibly belong to this model?
// E.g. EQV should have "EQV" in its trim, T-Class shouldn't get a "V 220 d"
// label because of a baumuster collision.
function trimMatchesModel(trim, m) {
  const t = trim.toLowerCase();
  const cls = (m.classId || "").toLowerCase().replace("-class", "");
  const fam = (m.name || "").toLowerCase();
  // Direct model-family substring is a strong match
  if (fam && t.includes(fam.split(" ")[0])) return true;
  // EQ classes — require the EQ prefix
  if (cls.startsWith("eq")) return /\beq[a-z0-9]/i.test(trim);
  // Maybach
  if ((m.modelSeries || "").includes("maybach")) return /maybach/i.test(trim);
  // Class-letter prefix (e.g. C-class → "C 200", "C-Klasse" / "C 220 d")
  const letter = cls.charAt(0);
  if (letter && /^[a-z]$/.test(letter))
    return new RegExp("\\b" + letter + "[\\s-]?\\w*\\d", "i").test(trim);
  return true; // permissive default for AMG/Marco Polo/etc.
}

async function tryFetchTrimName(baumuster, modelSeries) {
  const dv = await getDataVersion();
  if (!dv) return null;
  for (const code of CLASS_CODE_FALLBACKS) {
    try {
      const r = await fetch(
        `https://api.oneweb.mercedes-benz.com/owcc-backend/api/v3/nl_BE/${code}/${dv}/entry?modelIds=${baumuster}`,
        { headers: HDR }
      );
      if (!r.ok) continue;
      const j = await r.json();
      const pc =
        j.preConfigs?.find((p) => p.preConfigId === "BASIC") ||
        j.preConfigs?.[0];
      const name =
        pc?.motorizationName ||
        pc?.tags?.find((t) => /motoriz/i.test(t.id || ""))?.value;
      if (name) return name;
    } catch {}
  }
  return null;
}

async function fcisRenting(carPriceGross, baumuster) {
  // 1. Init: ask for "Renting" — the engine will silently drop to "Financial
  //    Leasing" for any baumuster where Renting isn't offered. We read which
  //    product the engine actually picked and use that on the real calc, so
  //    our firstPayment override is honoured (otherwise it gets thrown away).
  const initRes = await fetch(FCIS_URL, {
    method: "POST",
    headers: HDR,
    body: JSON.stringify({
      vehicle: {
        condition: { condition: "new" },
        prices: [
          { id: "baseListPrice", currency: "EUR", rawValue: carPriceGross },
          { id: "grossListPrice", currency: "EUR", rawValue: carPriceGross },
        ],
        vehicleConfiguration: {
          division: "pc",
          brand: "mercedes-benz",
          baumuster,
          equipments: [],
        },
        technicalData: [],
        alternativeConfiguration: [],
      },
      input: [
        { id: "customerType", value: "business" },
        { id: "fundingProduct", value: "Renting" },
      ],
    }),
  });
  if (!initRes.ok) return { error: "init HTTP " + initRes.status };
  const init = await initRes.json();
  const engineId = JSON.parse(init.opaque || "{}")?._engineId;
  if (!engineId) return { error: "no engineId" };
  const get = (id) => init.input?.items?.find((i) => i.id === id)?.value?.value;
  const carPriceNet = parseFloat(get("carPriceNet"));
  if (!carPriceNet) return { error: "no carPriceNet" };

  // The product the engine actually selected. May be "Renting" or
  // "Financial Leasing" depending on what's offered for this baumuster.
  const actualProduct = get("fundingProduct") || "Renting";

  // Force 20% downpayment regardless of product. Residual is left at the
  // engine's default (the configurator's "standard" for that product).
  const dpNet = (carPriceNet * 0.20).toFixed(2);

  // 2. Real calculation – note we now send the product the engine selected
  const payload = {
    vehicle: {
      condition: { condition: "new" },
      prices: [
        { id: "baseListPrice", currency: "EUR", rawValue: carPriceGross },
        { id: "grossListPrice", currency: "EUR", rawValue: carPriceGross },
      ],
      vehicleConfiguration: {
        division: "pc",
        brand: "mercedes-benz",
        baumuster,
        equipments: [],
      },
      technicalData: [],
      alternativeConfiguration: [],
    },
    input: [
      { id: "customerType", value: "business" },
      { id: "fundingProduct", value: actualProduct },
      { id: "firstPayment", value: dpNet },
      { id: "duration", value: "60" },
    ],
    opaque: JSON.stringify({
      _engineId: engineId,
      customerType: "business",
      fundingProduct: actualProduct,
      firstPayment: dpNet,
      duration: "60",
    }),
  };
  const res = await fetch(FCIS_URL, {
    method: "POST",
    headers: HDR,
    body: JSON.stringify(payload),
  });
  if (!res.ok) return { error: "calc HTTP " + res.status };
  const j = await res.json();
  const full = j.output?.containers?.find((c) => c.id === "fullSummary");
  if (!full) return { error: "no fullSummary" };

  const item = (id) => full.items.find((i) => i.id === id);
  const num = (id) => parseFloat(item(id)?.businessValue || "0");

  const monthlyNet = num("pmtNet");
  const monthlyGross = parseFloat(
    j.output?.rate?.replace(/[^\d,]/g, "").replace(",", ".") || "0"
  );
  const dpNetVal = num("dpNet");
  const carNet = num("carPriceNetOutput");
  // Residual field name differs by product: rvNet for Renting, rvLeasing for FL
  const rvNet = num("rvNet") || num("rvLeasing");
  const financed = num("invoicingPrice");
  const term = parseInt(item("numberInstallments")?.businessValue || "60", 10);
  const ir = monthlyNet && financed ? impliedAnnualRate(financed, rvNet, monthlyNet, term) : null;
  const productLabel = item("fpName")?.value || actualProduct;

  return {
    productName: productLabel,
    productId: j.output?.financingProduct?.id || actualProduct,
    customerType: "BUSINESS",
    productType: "LEASE",
    vehiclePriceNet: carNet,
    vehiclePriceGross: Math.round(carNet * 1.21 * 100) / 100,
    monthlyNet,
    monthlyGross,
    downPaymentNet: dpNetVal,
    downPaymentGross: Math.round(dpNetVal * 1.21 * 100) / 100,
    downPaymentPct: carNet ? dpNetVal / carNet : null,
    termMonths: term,
    annualMileage: null, // not exposed by FCIS for either product
    interestEffective: ir,
    residualValueNet: rvNet,
    residualValuePct: carNet ? rvNet / carNet : null,
    sumOfAllPaymentsNet: monthlyNet * term + dpNetVal,
    sumOfAllPaymentsGross: monthlyGross * term + Math.round(dpNetVal * 1.21 * 100) / 100,
  };
}

async function main() {
  console.log("Mercedes-Benz Belgium — Financial Renting Scraper (HTTP-only)");
  console.log("=".repeat(70));

  console.log("Fetching VMOS summary…");
  const models = await fetchModels();
  console.log(`Got ${models.length} variants.`);

  const CONC = 10;
  const results = [];
  let i = 0;
  async function worker() {
    while (i < models.length) {
      const idx = i++;
      const m = models[idx];
      const t0 = Date.now();
      // Run pricing + name discovery in parallel
      const [renting, trimNameRaw] = await Promise.all([
        fcisRenting(m.priceGross, m.baumuster).catch((e) => ({ error: e.message })),
        tryFetchTrimName(m.baumuster, m.modelSeries),
      ]);
      const ok = renting && !renting.error;
      // Sanity-check the returned trim name: the configurator entry endpoint
      // is loose and will return *some* preConfig even if our baumuster
      // collides with another model (e.g. EQT vs T-Class share bm4=4208).
      // Reject the trim name unless it looks consistent with our model.
      const trimName = trimNameRaw && trimMatchesModel(trimNameRaw, m) ? trimNameRaw : null;
      if (trimName) m.trimName = trimName;
      const finalName = trimName || m.displayName || m.name;
      m.displayName = finalName;
      console.log(
        `  [${(idx + 1).toString().padStart(2)}/${models.length}] ${finalName.padEnd(40)}` +
          ` bm=${m.baumuster.padEnd(9)} ${(Date.now() - t0)
            .toString()
            .padStart(4)}ms  ${
            ok
              ? fmtEUR(renting.monthlyNet) +
                "/m net  dp=" +
                Math.round((renting.downPaymentPct || 0) * 100) +
                "%  res=" +
                Math.round((renting.residualValuePct || 0) * 100) +
                "%  " +
                (renting.productName || "")
              : "ERR " + (renting?.error || "")
          }`
      );
      results.push({
        ...m,
        financialRenting: ok ? renting : null,
        rentingError: ok ? null : renting?.error,
      });
    }
  }
  const t0 = Date.now();
  await Promise.all(Array.from({ length: CONC }, () => worker()));
  console.log(`\nElapsed: ${((Date.now() - t0) / 1000).toFixed(1)} s`);

  // Sort back to original VMOS order
  results.sort(
    (a, b) =>
      models.findIndex((m) => m.vmosKey === a.vmosKey) -
      models.findIndex((m) => m.vmosKey === b.vmosKey)
  );

  fs.writeFileSync(
    path.join(__dirname, "mercedes-results.json"),
    JSON.stringify(results, null, 2)
  );
  const ok = results.filter((r) => r.financialRenting);
  console.log(`✅ Saved ${results.length} models → mercedes-results.json`);
  console.log(`   ${ok.length} with Renting offer, ${results.length - ok.length} without`);

  console.log("\nFirst 15:");
  console.table(
    ok.slice(0, 15).map((r) => ({
      Name: r.name,
      Series: r.modelSeries,
      Baumuster: r.baumuster,
      "€/mo (net)": r.financialRenting.monthlyNet.toFixed(2),
      "Implied i%": ((r.financialRenting.interestEffective || 0) * 100).toFixed(2) + "%",
      "Term": r.financialRenting.termMonths,
    }))
  );
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
