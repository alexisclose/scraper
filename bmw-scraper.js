// BMW Belgium scraper — Financial Renting (60 mo / 20% downpayment / 15.000 km)
// for every model on configure.bmw.be
//
// Strategy:
//   1. Load each short configurator URL (https://configure.bmw.be/nl_BE/configure/<RANGE>/<MODEL>)
//   2. The page automatically POSTs /operations/default-calculation, which returns BOTH
//      finance offers in data[]:
//        - data[i].info.customerType === "PRIVATE"  → BMW Select (default UI shows this)
//        - data[i].info.customerType === "BUSINESS" → BMW Financial Renting (what we want)
//   3. The Financial Renting product's defaults are already term=60, downPaymentPercent=0.20.
//   4. Parse parameterValues + parameterMapping for the BUSINESS offer and emit results.
//
// All currency values for BUSINESS offers are net (excl. BTW); we also emit gross.

const { chromium } = require("playwright-extra");
const stealth = require("puppeteer-extra-plugin-stealth")();
chromium.use(stealth);
const fs = require("fs");
const path = require("path");

const MODELS = JSON.parse(
  fs.readFileSync(path.join(__dirname, "bmw-models-list.json"), "utf8")
);
// Map of "RANGE/MODEL" → human model name, built by bmw-discover.js by parsing
// www.bmw.be/nl/all-models.html. Avoids the brittle hand-maintained mapping.
const MODEL_NAMES = (() => {
  try {
    return JSON.parse(
      fs.readFileSync(path.join(__dirname, "bmw-model-names.json"), "utf8")
    );
  } catch {
    return {};
  }
})();

function fmtEUR(n) {
  if (n == null || isNaN(n)) return "N/A";
  return "€ " + n.toLocaleString("nl-BE", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function pv(params, key) {
  const item = params.find((p) => p.key === key);
  if (!item) return null;
  const v = item.value.find((x) => x.key === "value");
  return v ? v.value : null;
}

async function scrapeModel(ctx, url, idx, total) {
  const page = await ctx.newPage();
  let captured = null;
  let calcUrl = null;

  page.on("response", async (resp) => {
    const u = resp.url();
    if (
      u.includes("operations/default-calculation") &&
      (resp.headers()["content-type"] || "").includes("json")
    ) {
      try {
        const body = await resp.text();
        const j = JSON.parse(body);
        if (j && Array.isArray(j.data) && j.data.length) {
          captured = j;
          calcUrl = u;
        }
      } catch {}
    }
  });

  try {
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: 45000 });
    // Pop cookie banners (they intercept clicks but not network — still nice for hydration)
    await page
      .evaluate(() => {
        for (const el of document.querySelectorAll("*")) {
          if (el.shadowRoot) {
            const btn = el.shadowRoot.querySelector("button, [role=button]");
            if (btn && /accept|aanvaard|akkoord|toestaan|allow/i.test(btn.innerText || "")) {
              btn.click();
              break;
            }
          }
        }
      })
      .catch(() => {});

    // Wait up to ~25 s for the calculation response
    for (let i = 0; i < 25 && !captured; i++) await page.waitForTimeout(1000);
  } catch {}
  await page.close().catch(() => {});

  if (!captured) {
    console.log(`  [${idx + 1}/${total}] ${url}  ✗ no calc captured`);
    return { url, error: "no calculation" };
  }

  // Pick the BUSINESS / Financial Renting offer
  const fr = captured.data.find(
    (d) =>
      d?.info?.customerType === "BUSINESS" ||
      /renting/i.test(d?.info?.productName || "") ||
      d?.info?.productType === "LEASE"
  );
  const priv = captured.data.find((d) => d?.info?.customerType === "PRIVATE");

  function shape(offer) {
    if (!offer) return null;
    const m = offer.parameterMapping || {};
    const p = offer.parameterValues || [];
    const totalNet = parseFloat(pv(p, "vehiclePrices/totalVehiclePrice/salesPrice/netAmount"));
    const totalGross = parseFloat(pv(p, "vehiclePrices/totalVehiclePrice/salesPrice/grossAmount"));
    const monthlyNet = parseFloat(pv(p, "totalInstallment/netAmount") ?? m.totalInstallment ?? m.payment);
    const monthlyGross = parseFloat(pv(p, "totalInstallment/grossAmount") ?? pv(p, "installment/grossAmount"));
    const dpNet = parseFloat(pv(p, "downPaymentAmount/netAmount") ?? m.downpayment);
    const dpGross = parseFloat(pv(p, "downPaymentAmount/grossAmount"));
    const dpPct = parseFloat(pv(p, "downPaymentPercent"));
    const term = parseInt(pv(p, "term") ?? m.term, 10);
    const km = parseInt(pv(p, "annualMileage") ?? m.contractualMileage, 10);
    const ir = parseFloat(pv(p, "interestEffective"));
    const rvNet = parseFloat(pv(p, "residualValueAmount/netAmount"));
    const rvPct = parseFloat(pv(p, "residualValuePercent"));
    const sumNet = parseFloat(pv(p, "sumOfAllPayments/netAmount") ?? m.sumOfAllTotalPayments);
    const sumGross = parseFloat(pv(p, "sumOfAllPayments/grossAmount"));
    return {
      productName: offer.info?.productName,
      productId: offer.info?.productId,
      customerType: offer.info?.customerType,
      productType: offer.info?.productType,
      vehiclePriceNet: totalNet, vehiclePriceGross: totalGross,
      monthlyNet, monthlyGross,
      downPaymentNet: dpNet, downPaymentGross: dpGross, downPaymentPct: dpPct,
      termMonths: term, annualMileage: km,
      interestEffective: ir,
      residualValueNet: rvNet, residualValuePct: rvPct,
      sumOfAllPaymentsNet: sumNet, sumOfAllPaymentsGross: sumGross,
    };
  }

  const frS = shape(fr);
  const privS = shape(priv);
  console.log(
    `  [${idx + 1}/${total}] ${url}  → ${
      frS
        ? fmtEUR(frS.monthlyNet) +
          "/m net (" +
          frS.termMonths +
          "mo, " +
          Math.round((frS.downPaymentPct || 0) * 100) +
          "% dp)"
        : "no FR offer"
    }`
  );

  return { url, calcUrl, financialRenting: frS, bmwSelect: privS };
}

async function main() {
  console.log("BMW Belgium — Financial Renting Scraper");
  console.log("=".repeat(70));
  console.log(`Models to scrape: ${MODELS.length}`);
  console.log("=".repeat(70));

  const browser = await chromium.launch({ headless: true });
  const ctx = await browser.newContext({
    locale: "nl-BE",
    userAgent:
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/122.0.0.0 Safari/537.36",
    viewport: { width: 1400, height: 900 },
  });

  const CONC = 4; // be polite
  const results = [];
  for (let i = 0; i < MODELS.length; i += CONC) {
    const batch = MODELS.slice(i, i + CONC);
    const out = await Promise.all(
      batch.map((u, k) => scrapeModel(ctx, u, i + k, MODELS.length))
    );
    results.push(...out);
  }
  await browser.close();

  for (const r of results) {
    const m = r.url.match(/configure\/([A-Z0-9]+)\/([A-Z0-9]+)/);
    if (m) {
      r.modelRange = m[1];
      r.modelCode = m[2];
      r.modelName = MODEL_NAMES[m[1] + "/" + m[2]] || null;
    }
  }

  fs.writeFileSync(
    path.join(__dirname, "bmw-results.json"),
    JSON.stringify(results, null, 2)
  );

  const header = [
    "Model Range", "Model Name", "Model Code", "URL", "FR Product",
    "Vehicle Price (net)", "Vehicle Price (gross)",
    "Monthly (net)", "Monthly (gross)",
    "Down Payment (net)", "Down Payment (gross)", "Down Payment %",
    "Term (months)", "Annual km", "Interest %",
    "Residual Value (net)", "Residual Value %",
    "Total Cost (net)",
  ];
  const cell = (v) =>
    `"${v == null || v === "" ? "" : String(v).replace(/"/g, '""')}"`;
  const rows = results.map((r) => {
    const f = r.financialRenting || {};
    return [
      r.modelRange, MODEL_NAMES[r.modelRange + "/" + r.modelCode] || "", r.modelCode, r.url,
      f.productName || "",
      f.vehiclePriceNet?.toFixed(2) || "", f.vehiclePriceGross?.toFixed(2) || "",
      f.monthlyNet?.toFixed(2) || "", f.monthlyGross?.toFixed(2) || "",
      f.downPaymentNet?.toFixed(2) || "", f.downPaymentGross?.toFixed(2) || "",
      f.downPaymentPct != null ? (f.downPaymentPct * 100).toFixed(1) + "%" : "",
      f.termMonths || "", f.annualMileage || "",
      f.interestEffective != null ? (f.interestEffective * 100).toFixed(2) + "%" : "",
      f.residualValueNet?.toFixed(2) || "",
      f.residualValuePct != null ? (f.residualValuePct * 100).toFixed(1) + "%" : "",
      f.sumOfAllPaymentsNet?.toFixed(2) || "",
    ].map(cell).join(",");
  });
  // If the CSV is open in Excel it'll be locked → fall back to a timestamped file
  const csvBody =
    "﻿" + [header.map((h) => `"${h}"`).join(","), ...rows].join("\n");
  let csvPath = path.join(__dirname, "bmw-results.csv");
  try {
    fs.writeFileSync(csvPath, csvBody, "utf8");
  } catch (e) {
    if (e.code === "EBUSY" || e.code === "EPERM") {
      const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
      csvPath = path.join(__dirname, `bmw-results-${stamp}.csv`);
      fs.writeFileSync(csvPath, csvBody, "utf8");
      console.log(`(bmw-results.csv was locked — wrote ${path.basename(csvPath)} instead)`);
    } else {
      throw e;
    }
  }

  const ok = results.filter((r) => r.financialRenting);
  console.log(`\n✅ Saved ${results.length} models → bmw-results.json / bmw-results.csv`);
  console.log(`   ${ok.length} with FR offer, ${results.length - ok.length} missing`);
  console.log("\nFirst 15:");
  console.table(
    ok.slice(0, 15).map((r) => ({
      Range: r.modelRange,
      Label: MODEL_NAMES[r.modelRange + "/" + r.modelCode] || "",
      Code: r.modelCode,
      "FR €/mo (net)": fmtEUR(r.financialRenting.monthlyNet),
      Term: r.financialRenting.termMonths,
      DP: Math.round((r.financialRenting.downPaymentPct || 0) * 100) + "%",
      "km/yr": r.financialRenting.annualMileage,
    }))
  );
}

main().catch((e) => {
  console.error("Fatal:", e);
  process.exit(1);
});
