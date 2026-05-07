// Combine bmw-results.json + mercedes-results.json into a single .xlsx
// with one sheet per brand. Same column shape on both sheets so they're
// directly comparable.

const fs = require("fs");
const path = require("path");
const XLSX = require("xlsx");

const BMW_NAMES = (() => {
  try { return JSON.parse(fs.readFileSync("bmw-model-names.json", "utf8")); }
  catch { return {}; }
})();

const HEADER = [
  "Brand",
  "Model",
  "Series / Range",
  "Variant Code",
  "Vehicle Price (gross)",
  "Vehicle Price (net)",
  "Monthly (net)",
  "Monthly (gross)",
  "Down Payment (net)",
  "Down Payment (gross)",
  "Down Payment %",
  "Term (months)",
  "Annual km",
  "Interest %",
  "Residual Value (net)",
  "Residual Value %",
  "Total Cost (net)",
  "FR Product",
  "URL",
];

const fmt2 = (n) => (n == null || isNaN(n) ? null : Math.round(n * 100) / 100);
const pct1 = (n) => (n == null || isNaN(n) ? null : Math.round(n * 1000) / 10);

function bmwRow(r) {
  const f = r.financialRenting || {};
  return {
    Brand: "BMW",
    Model: BMW_NAMES[r.modelRange + "/" + r.modelCode] || r.modelName || "",
    "Series / Range": r.modelRange,
    "Variant Code": r.modelCode,
    "Vehicle Price (gross)": fmt2(f.vehiclePriceGross),
    "Vehicle Price (net)": fmt2(f.vehiclePriceNet),
    "Monthly (net)": fmt2(f.monthlyNet),
    "Monthly (gross)": fmt2(f.monthlyGross),
    "Down Payment (net)": fmt2(f.downPaymentNet),
    "Down Payment (gross)": fmt2(f.downPaymentGross),
    "Down Payment %": pct1(f.downPaymentPct),
    "Term (months)": f.termMonths || null,
    "Annual km": f.annualMileage || null,
    "Interest %": pct1(f.interestEffective),
    "Residual Value (net)": fmt2(f.residualValueNet),
    "Residual Value %": pct1(f.residualValuePct),
    "Total Cost (net)": fmt2(f.sumOfAllPaymentsNet),
    "FR Product": f.productName || "",
    URL: r.url || "",
  };
}

function teslaRow(r) {
  const f = r.financialRenting || {};
  return {
    Brand: "Tesla",
    Model: r.modelName || r.slug || "",
    "Series / Range": "Model 3",
    "Variant Code": r.slug || "",
    "Vehicle Price (gross)": fmt2(f.vehiclePriceGross),
    "Vehicle Price (net)": fmt2(f.vehiclePriceNet),
    "Monthly (net)": fmt2(f.monthlyNet),
    "Monthly (gross)": fmt2(f.monthlyGross),
    "Down Payment (net)": fmt2(f.downPaymentNet),
    "Down Payment (gross)": fmt2(f.downPaymentGross),
    "Down Payment %": pct1(f.downPaymentPct),
    "Term (months)": f.termMonths || null,
    "Annual km": f.annualMileage || null,
    "Interest %": pct1(f.interestEffective),
    "Residual Value (net)": fmt2(f.residualValueNet),
    "Residual Value %": pct1(f.residualValuePct),
    "Total Cost (net)": fmt2(f.sumOfAllPaymentsNet),
    "FR Product": f.productName || "",
    URL: r.url || "",
  };
}

function vwRow(r) {
  const f = r.financialRenting || {};
  return {
    Brand: "Volkswagen",
    Model: r.modelName || r.slug || "",
    "Series / Range": "",
    "Variant Code": r.slug || "",
    "Vehicle Price (gross)": fmt2(f.vehiclePriceGross),
    "Vehicle Price (net)": fmt2(f.vehiclePriceNet),
    "Monthly (net)": fmt2(f.monthlyNet),
    "Monthly (gross)": fmt2(f.monthlyGross),
    "Down Payment (net)": fmt2(f.downPaymentNet),
    "Down Payment (gross)": fmt2(f.downPaymentGross),
    "Down Payment %": pct1(f.downPaymentPct),
    "Term (months)": f.termMonths || null,
    "Annual km": f.annualMileage || null,
    "Interest %": pct1(f.interestEffective),
    "Residual Value (net)": fmt2(f.residualValueNet),
    "Residual Value %": pct1(f.residualValuePct),
    "Total Cost (net)": fmt2(f.sumOfAllPaymentsNet),
    "FR Product": f.productName || "",
    URL: r.url || "",
  };
}

function mbRow(r) {
  const f = r.financialRenting || {};
  return {
    Brand: "Mercedes",
    Model: r.displayName || r.trimName || r.name || "",
    "Series / Range": r.modelSeries || "",
    "Variant Code": r.baumuster || "",
    "Vehicle Price (gross)": fmt2(f.vehiclePriceGross),
    "Vehicle Price (net)": fmt2(f.vehiclePriceNet),
    "Monthly (net)": fmt2(f.monthlyNet),
    "Monthly (gross)": fmt2(f.monthlyGross),
    "Down Payment (net)": fmt2(f.downPaymentNet),
    "Down Payment (gross)": fmt2(f.downPaymentGross),
    "Down Payment %": pct1(f.downPaymentPct),
    "Term (months)": f.termMonths || null,
    "Annual km": f.annualMileage, // null for MB — engine doesn't expose it
    "Interest %": pct1(f.interestEffective),
    "Residual Value (net)": fmt2(f.residualValueNet),
    "Residual Value %": pct1(f.residualValuePct),
    "Total Cost (net)": fmt2(f.sumOfAllPaymentsNet),
    "FR Product": f.productName || "",
    URL: "",
  };
}

function makeSheet(rows) {
  const ws = XLSX.utils.json_to_sheet(rows, { header: HEADER });
  // Auto-size columns roughly
  ws["!cols"] = HEADER.map((h) => {
    const max = Math.max(
      h.length,
      ...rows.map((r) => String(r[h] ?? "").length)
    );
    return { wch: Math.min(max + 2, 50) };
  });
  return ws;
}

const bmw = JSON.parse(fs.readFileSync("bmw-results.json", "utf8"));
const mb = JSON.parse(fs.readFileSync("mercedes-results.json", "utf8"));
const vw = (() => {
  try { return JSON.parse(fs.readFileSync("vw-results.json", "utf8")); }
  catch { return []; }
})();
const tesla = (() => {
  try { return JSON.parse(fs.readFileSync("tesla-results.json", "utf8")); }
  catch { return []; }
})();

const bmwRows = bmw
  .filter((r) => r.financialRenting)
  .map(bmwRow)
  .sort((a, b) => a.Model.localeCompare(b.Model));
const mbRows = mb
  .filter((r) => r.financialRenting)
  .map(mbRow)
  .sort((a, b) => a.Model.localeCompare(b.Model));
const vwRows = vw
  .filter((r) => r.financialRenting?.monthlyNet)
  .map(vwRow)
  .sort((a, b) => a.Model.localeCompare(b.Model));
const teslaRows = tesla
  .filter((r) => r.financialRenting?.vehiclePriceGross || r.financialRenting?.monthlyNet)
  .map(teslaRow)
  .sort((a, b) => a.Model.localeCompare(b.Model));

const wb = XLSX.utils.book_new();
XLSX.utils.book_append_sheet(wb, makeSheet(bmwRows), "BMW");
XLSX.utils.book_append_sheet(wb, makeSheet(mbRows), "Mercedes");
if (vwRows.length) XLSX.utils.book_append_sheet(wb, makeSheet(vwRows), "Volkswagen");
if (teslaRows.length) XLSX.utils.book_append_sheet(wb, makeSheet(teslaRows), "Tesla");

const out = path.join(__dirname, "financial-renting.xlsx");
let target = out;
try {
  XLSX.writeFile(wb, target);
} catch (e) {
  if (e.code === "EBUSY" || e.code === "EPERM") {
    const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
    target = path.join(__dirname, `financial-renting-${stamp}.xlsx`);
    XLSX.writeFile(wb, target);
    console.log(`(${path.basename(out)} was locked — wrote ${path.basename(target)} instead)`);
  } else throw e;
}
console.log(
  `✅ Wrote ${path.basename(target)} — BMW: ${bmwRows.length} · Mercedes: ${mbRows.length} · Volkswagen: ${vwRows.length} · Tesla: ${teslaRows.length}`
);
