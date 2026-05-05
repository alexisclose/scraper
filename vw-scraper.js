// Volkswagen Belgium scraper — Financial Renting offers
//
// Strategy:
//   1. Load the professional-offers list page once (it's an SPA so we use
//      Playwright just for link discovery) and collect every
//      /app/offers/nl/professional/<model> URL.
//   2. Fetch each model URL with plain HTTP — the legal-mention block is in
//      the static HTML so no browser needed.
//   3. Parse:
//        - trim name (e.g. "Volkswagen ID.7 Pro 77 kWh 210 kW (286 ch)")
//        - catalog price excl. BTW
//        - monthly excl. BTW (already shown in the header)
//        - term (months), kilometres, first increased rent, residual % from
//          the legal-mention paragraph.
//   4. Compute the gross figures (× 1.21) and the implied annual interest
//      rate from the cashflows, same convention as the Mercedes scraper.
//
// Output: vw-results.json — same shape as bmw-results / mercedes-results.

const fs = require("fs");
const path = require("path");

const LIST_URL = "https://www.volkswagen.be/app/offers/nl/professionals?active=556";
const HDR = {
  "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/122.0.0.0 Safari/537.36",
  "Accept-Language": "nl-BE,nl;q=0.9",
};

// Same lease IRR helper as the Mercedes scraper
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
  return (lo + hi) / 2;
}

// VW writes prices as "€ 49.723,14" or "€ 435" (excl BTW). Strip currency,
// thousand-separator dots, decimal-comma → JS Number.
function parseEur(s) {
  if (!s) return null;
  const m = s.replace(/&nbsp;/g, " ").replace(/[€\s]/g, "");
  const num = m.replace(/\.(?=\d{3}(\D|$))/g, "").replace(",", ".");
  const v = parseFloat(num);
  return isNaN(v) ? null : v;
}

// VW's offers landing page is an SPA that hides most models behind dynamic
// "active=…" filters. Instead of driving the SPA, we probe a static list of
// candidate slugs (built from the navigation flyout + manual additions) over
// pure HTTP — anything that returns HTTP 200 is a real offer.
const CANDIDATE_SLUGS = [
  // Original 8 (active=556 showed these)
  "amarok", "california", "id7", "id7-pro-business-premium", "id7-business-sport",
  "caddy", "id3purebusiness", "id3-business",
  // Discovered by candidate-slug probe
  "tiguan", "tiguan-business",
  "passat", "passat-business",
  "polo-business",
  "t-roc", "t-cross",
  "taigo",
  "id-buzz",
  "multivan",
  "id4-pro",
  "id5-pro", "id5-business",
];

async function discoverModelLinks() {
  const cachePath = path.join(__dirname, "vw-model-links.json");
  if (process.env.VW_NO_CACHE !== "1" && fs.existsSync(cachePath)) {
    try {
      const cached = JSON.parse(fs.readFileSync(cachePath, "utf8"));
      if (Array.isArray(cached) && cached.length) return cached;
    } catch {}
  }
  // Probe each candidate over plain HTTP. Concurrency 10.
  const ok = [];
  const queue = [...CANDIDATE_SLUGS];
  async function worker() {
    while (queue.length) {
      const slug = queue.shift();
      const url = `https://www.volkswagen.be/app/offers/nl/professional/${slug}`;
      try {
        const r = await fetch(url, { method: "HEAD", headers: HDR, redirect: "follow" });
        if (r.ok) ok.push(url);
      } catch {}
    }
  }
  await Promise.all(Array.from({ length: 10 }, () => worker()));
  ok.sort();
  fs.writeFileSync(cachePath, JSON.stringify(ok, null, 2));
  return ok;
}

async function scrapeModel(url) {
  const res = await fetch(url, { headers: HDR });
  if (!res.ok) return { url, error: "HTTP " + res.status };
  const html = await res.text();

  // 1. Header price (Financiële Renting vanaf  €&nbsp;435&nbsp;/&nbsp;maand)
  const headerRe =
    /Financi[eë]le Renting vanaf[\s\S]{0,400}?<span class="price_currency">&euro;<\/span>&nbsp;([\d.,]+)\s*&nbsp;\/&nbsp;<span class="price_period">maand/i;
  const headerMatch = html.match(headerRe);
  const monthlyNet = headerMatch ? parseEur(headerMatch[1]) : null;

  // 2. Detailed conditions are inside <div id="legal-mention-monthly" uk-modal>
  //    on most pages. Some pages (Commercial Vehicles like California / Caddy)
  //    only show the headline price + catalog price and have no renting
  //    detail block. We still extract whatever's there.
  function extractModal(idAttr) {
    const tag = `<div id="${idAttr}" uk-modal>`;
    const start = html.indexOf(tag);
    if (start < 0) return "";
    let depth = 0,
      end = start;
    const tagRe = /<\/?div\b[^>]*>/gi;
    tagRe.lastIndex = start;
    let m;
    while ((m = tagRe.exec(html))) {
      if (m[0].startsWith("</")) {
        depth--;
        if (depth === 0) {
          end = m.index + m[0].length;
          break;
        }
      } else depth++;
    }
    return html
      .slice(start, end)
      .replace(/<[^>]+>/g, " ")
      .replace(/&nbsp;/g, " ")
      .replace(/&amp;/g, "&")
      .replace(/&euro;/g, "€")
      .replace(/&#039;/g, "'")
      .replace(/\s+/g, " ")
      .trim();
  }
  let legalText = extractModal("legal-mention-monthly");
  if (!legalText) {
    // Fallback: scan all legal-mention-* modals and pick the first that
    // mentions Financiële Renting + catalog price.
    const ids = [...new Set([...html.matchAll(/<div\s+id="(legal-mention-[^"]+)"\s+uk-modal/gi)].map((m) => m[1]))];
    for (const id of ids) {
      const t = extractModal(id);
      if (/Financi[eë]le Renting/i.test(t) && /Aanbevolen catalogusprijs/i.test(t)) {
        legalText = t;
        break;
      }
    }
  }

  // Trim/spec line: starts with "Volkswagen " and ends at the next clause.
  // The dot inside "ID.7" must not end the match.
  let trimName = null;
  const titleMatch = legalText.match(
    /Volkswagen[\s\S]+?(?=\s*(?:Aanbevolen catalogusprijs|Huurprijs|excl\. BTW|Offerte))/i
  );
  if (titleMatch) trimName = titleMatch[0].replace(/[.\s]+$/, "").trim();
  // VW's spec sometimes drops the model word (Amarok appears as "Volkswagen
  // STYLE Double Cabine …"). Reduce the URL slug to its core model token
  // (letters then digits, e.g. "id3purebusiness" → "id3", "amarok" → "amarok")
  // and prepend it to the trim only if that token isn't already present.
  const slugFirst = (url.match(/professional\/([^/?]+)/)?.[1] || "").split("-")[0];
  const slugCore = (slugFirst.match(/^[a-z]+\d*/) || [""])[0];
  const normTrim = trimName?.toLowerCase().replace(/[^a-z0-9]/g, "") || "";
  if (trimName && slugCore && !normTrim.includes(slugCore)) {
    const word = slugCore.toUpperCase().replace(/^([A-Z]+)(\d*)$/, (_, a, b) =>
      a.length <= 2 ? a + b : a.charAt(0) + a.slice(1).toLowerCase() + b
    );
    trimName = trimName.replace(/^Volkswagen/i, "Volkswagen " + word);
  }

  // Catalog price excl BTW — first try the legal text, then the visible
  // page block "Aanbevolen catalogusprijs €&nbsp;51.043 excl. BTW"
  let catalogNet = null;
  const cat = legalText.match(
    /catalogusprijs\s*excl\.?\s*BTW[:\s]*€?\s*([\d.,]+)/i
  );
  if (cat) catalogNet = parseEur(cat[1]);
  if (catalogNet == null) {
    const visible = html.match(
      /Aanbevolen catalogusprijs[\s\S]{0,400}?<span class="price_currency">&euro;<\/span>&nbsp;([\d.,]+)/i
    );
    if (visible) catalogNet = parseEur(visible[1]);
  }
  // Trim name fallback for pages without a legal-mention text
  if (!trimName) {
    const slug = url.match(/professional\/([^/?]+)/)?.[1] || "";
    trimName =
      "Volkswagen " +
      slug
        .replace(/-/g, " ")
        .replace(/\b\w/g, (c) => c.toUpperCase());
  }

  // Term (months) and contract km
  let term = null;
  const tm = legalText.match(/(\d{2,3})\s*maand/i);
  if (tm) term = parseInt(tm[1], 10);
  let km = null;
  const kmm = legalText.match(/([\d.,]+)\s*kilometer/i);
  if (kmm) km = parseInt(kmm[1].replace(/[.,]/g, ""), 10);

  // First increased rent (= downpayment, excl BTW)
  let dpNet = null;
  const dp = legalText.match(
    /eerste\s+verhoogde\s+huurprijs[\s\S]{0,80}?€\s*([\d.,]+)/i
  );
  if (dp) dpNet = parseEur(dp[1]);

  // Residual / purchase option %
  let rvPct = null;
  const rv = legalText.match(
    /aankoopoptie\s+van\s+(\d+(?:[.,]\d+)?)\s*%/i
  );
  if (rv) rvPct = parseFloat(rv[1].replace(",", ".")) / 100;

  // Bonus-malus mention (informational)
  let bonusMalus = null;
  const bm = legalText.match(/bonus[- ]?malus[\s\S]{0,30}?(\d+)/i);
  if (bm) bonusMalus = parseInt(bm[1], 10);

  if (!monthlyNet && !catalogNet && !legalText) {
    return { url, error: "no offer block on page" };
  }

  // Derived figures
  const monthlyGross = monthlyNet != null ? Math.round(monthlyNet * 1.21 * 100) / 100 : null;
  const catalogGross = catalogNet != null ? Math.round(catalogNet * 1.21 * 100) / 100 : null;
  const dpGross = dpNet != null ? Math.round(dpNet * 1.21 * 100) / 100 : null;
  const rvNet = catalogNet != null && rvPct != null ? Math.round(catalogNet * rvPct * 100) / 100 : null;
  const dpPct = catalogNet && dpNet != null ? dpNet / catalogNet : null;
  const financed = catalogNet != null && dpNet != null ? catalogNet - dpNet : null;
  const ir =
    financed && rvNet != null && monthlyNet && term
      ? impliedAnnualRate(financed, rvNet, monthlyNet, term)
      : null;
  const totalNet =
    monthlyNet != null && term && dpNet != null ? monthlyNet * term + dpNet : null;
  const totalGross =
    monthlyGross != null && term && dpGross != null ? monthlyGross * term + dpGross : null;

  const slug = url.match(/professional\/([^/?]+)/)?.[1] || "";
  return {
    url,
    slug,
    modelName: trimName || slug,
    bonusMalus,
    financialRenting: {
      productName: "Volkswagen Financial Services — Financiële Renting",
      productId: "VW_FIN_RENTING",
      customerType: "BUSINESS",
      productType: "LEASE",
      vehiclePriceNet: catalogNet,
      vehiclePriceGross: catalogGross,
      monthlyNet,
      monthlyGross,
      downPaymentNet: dpNet,
      downPaymentGross: dpGross,
      downPaymentPct: dpPct,
      termMonths: term,
      annualMileage: km && term ? Math.round((km / term) * 12) : null, // km → km/yr
      contractMileage: km,
      interestEffective: ir,
      residualValueNet: rvNet,
      residualValuePct: rvPct,
      sumOfAllPaymentsNet: totalNet,
      sumOfAllPaymentsGross: totalGross,
    },
  };
}

async function main() {
  console.log("Volkswagen Belgium — Financial Renting Scraper");
  console.log("=".repeat(70));

  console.log("Discovering model links…");
  const links = await discoverModelLinks();
  console.log(`  ${links.length} models.`);

  const results = [];
  await Promise.all(
    links.map(async (url, i) => {
      try {
        const out = await scrapeModel(url);
        const f = out.financialRenting;
        console.log(
          `  [${(i + 1).toString().padStart(2)}/${links.length}] ${(out.modelName || out.slug).padEnd(60)}` +
            `  ${
              f && f.monthlyNet
                ? "€ " + f.monthlyNet.toFixed(2) + "/m net  dp=" + (f.downPaymentPct ? Math.round(f.downPaymentPct * 100) + "%" : "?") +
                  "  res=" + (f.residualValuePct ? Math.round(f.residualValuePct * 100) + "%" : "?") +
                  "  " + (f.termMonths || "?") + "mo"
                : "FAIL: " + (out.error || "no data")
            }`
        );
        results.push(out);
      } catch (e) {
        console.log("  ERR", url, e.message);
        results.push({ url, error: e.message });
      }
    })
  );
  results.sort(
    (a, b) => links.indexOf(a.url) - links.indexOf(b.url)
  );

  fs.writeFileSync(
    path.join(__dirname, "vw-results.json"),
    JSON.stringify(results, null, 2)
  );
  const ok = results.filter((r) => r.financialRenting?.monthlyNet);
  console.log(`\n✅ Saved ${results.length} models → vw-results.json`);
  console.log(`   ${ok.length} with monthly, ${results.length - ok.length} missing`);
  console.log("\nAll:");
  console.table(
    results.map((r) => ({
      Model: r.modelName,
      "€/mo (net)": r.financialRenting?.monthlyNet?.toFixed(2),
      Term: r.financialRenting?.termMonths,
      "DP %": r.financialRenting?.downPaymentPct
        ? Math.round(r.financialRenting.downPaymentPct * 100) + "%"
        : "?",
      "Res %": r.financialRenting?.residualValuePct
        ? Math.round(r.financialRenting.residualValuePct * 100) + "%"
        : "?",
      "Implied i%": r.financialRenting?.interestEffective != null
        ? (r.financialRenting.interestEffective * 100).toFixed(2) + "%"
        : "?",
    }))
  );
}

main().catch((e) => {
  console.error("Fatal:", e);
  process.exit(1);
});
