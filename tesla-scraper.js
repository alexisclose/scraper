// Tesla Belgium scraper — Model 3 finance/lease offers
//
// Why this looks different from vw-scraper:
//   Tesla's www.tesla.com is behind Akamai with aggressive bot detection.
//   Plain HTTP GETs return 403 and even headless playwright (stealth +
//   persistent profile) is blocked. So we try, in order:
//
//     1. CDP attach to a Chrome the user already has open with
//        --remote-debugging-port=9222 (most reliable — uses a real human
//        session that has already passed Akamai).
//     2. A locally-saved HTML file at tesla-m3-saved.html. The user can
//        open https://www.tesla.com/nl_be/model3/design in their normal
//        browser, "Save Page As → Webpage, complete" into this folder,
//        and re-run the scraper.
//     3. As a last resort, headful playwright stealth — usually fails on
//        Tesla but is left in place for completeness.
//
// Once we have the rendered HTML / DOM, parsing follows the same shape as
// vw-scraper: find each Model 3 trim, its catalog price (incl BTW — Tesla
// shows gross by default), and the monthly lease/finance figure when shown.
//
// Output: tesla-results.json — same shape as bmw / mercedes / vw.

const { chromium } = require("patchright");
const fs = require("fs");
const path = require("path");
const { spawn, execSync } = require("child_process");
const net = require("net");

const URL_M3 = "https://www.tesla.com/nl_be/model3/design";
const SAVED_HTML = path.join(__dirname, "tesla-m3-saved.html");
const CDP_PORT = parseInt(process.env.TESLA_CDP_PORT || "9223", 10);
const CHROME_PROFILE = path.join(__dirname, "tesla-chrome-profile");

// Cross-platform Chrome / Chromium-based browser detection.
// We prefer Chrome itself (most reliable for Akamai), then fall back to
// Edge (Chromium-based) and Chromium / Brave. The user can override with
// the TESLA_CHROME env var.
function findChromeExecutable() {
  if (process.env.TESLA_CHROME) return process.env.TESLA_CHROME;
  const candidates = [];
  if (process.platform === "win32") {
    const programFiles = process.env["ProgramFiles"] || "C:\\Program Files";
    const programFilesX86 = process.env["ProgramFiles(x86)"] || "C:\\Program Files (x86)";
    const localAppData = process.env.LOCALAPPDATA || "";
    candidates.push(
      path.join(programFiles, "Google", "Chrome", "Application", "chrome.exe"),
      path.join(programFilesX86, "Google", "Chrome", "Application", "chrome.exe"),
      path.join(localAppData, "Google", "Chrome", "Application", "chrome.exe"),
      path.join(programFiles, "Google", "Chrome Beta", "Application", "chrome.exe"),
      // Edge as a Chromium fallback
      path.join(programFilesX86, "Microsoft", "Edge", "Application", "msedge.exe"),
      path.join(programFiles, "Microsoft", "Edge", "Application", "msedge.exe"),
      // Brave
      path.join(programFiles, "BraveSoftware", "Brave-Browser", "Application", "brave.exe"),
      path.join(programFilesX86, "BraveSoftware", "Brave-Browser", "Application", "brave.exe")
    );
  } else if (process.platform === "darwin") {
    candidates.push(
      "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
      "/Applications/Google Chrome Beta.app/Contents/MacOS/Google Chrome Beta",
      "/Applications/Chromium.app/Contents/MacOS/Chromium",
      "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
      "/Applications/Brave Browser.app/Contents/MacOS/Brave Browser"
    );
  } else {
    // Linux & friends
    candidates.push(
      "/usr/bin/google-chrome",
      "/usr/bin/google-chrome-stable",
      "/usr/bin/chromium",
      "/usr/bin/chromium-browser",
      "/snap/bin/chromium",
      "/usr/bin/microsoft-edge",
      "/usr/bin/brave-browser"
    );
  }
  for (const p of candidates) {
    try {
      if (fs.existsSync(p)) return p;
    } catch {}
  }
  return null;
}

const CHROME_EXE = findChromeExecutable();

// Same lease IRR helper as the other scrapers
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

// Tesla writes "€&nbsp;42.970" or "€ 499/mo" — strip currency / dots / commas
function parseEur(s) {
  if (!s) return null;
  const cleaned = s.replace(/&nbsp;/g, " ").replace(/[€\s]/g, "");
  const num = cleaned.replace(/\.(?=\d{3}(\D|$))/g, "").replace(",", ".");
  const v = parseFloat(num);
  return isNaN(v) ? null : v;
}

function isPortOpen(port, host = "127.0.0.1", timeout = 800) {
  return new Promise((res) => {
    const sock = new net.Socket();
    let done = false;
    const finish = (ok) => {
      if (done) return;
      done = true;
      try { sock.destroy(); } catch {}
      res(ok);
    };
    sock.setTimeout(timeout);
    sock.once("connect", () => finish(true));
    sock.once("error", () => finish(false));
    sock.once("timeout", () => finish(false));
    sock.connect(port, host);
  });
}

async function ensureChromeWithCDP() {
  // Already up? Reuse it.
  if (await isPortOpen(CDP_PORT)) {
    console.log(`  CDP port ${CDP_PORT} already open — reusing.`);
    return;
  }
  if (!CHROME_EXE || !fs.existsSync(CHROME_EXE)) {
    console.log(
      `  No Chrome/Chromium-based browser found in standard paths.\n` +
        `  Install Google Chrome, or set TESLA_CHROME=<path-to-browser-exe>.`
    );
    return;
  }
  console.log(`  Using browser: ${CHROME_EXE}`);
  // Spawn Chrome detached with a dedicated profile + remote-debugging port.
  // The dedicated profile means it doesn't conflict with the user's main
  // Chrome being open, and persists across runs so cookies/Akamai trust
  // accumulate naturally.
  console.log(`  Launching Chrome with --remote-debugging-port=${CDP_PORT}`);
  if (!fs.existsSync(CHROME_PROFILE)) fs.mkdirSync(CHROME_PROFILE, { recursive: true });
  const child = spawn(
    CHROME_EXE,
    [
      `--remote-debugging-port=${CDP_PORT}`,
      `--user-data-dir=${CHROME_PROFILE}`,
      "--no-first-run",
      "--no-default-browser-check",
      "--disable-blink-features=AutomationControlled",
      "--lang=nl-BE",
      URL_M3,
    ],
    { detached: true, stdio: "ignore", windowsHide: false }
  );
  child.unref();
  // Wait up to 30s for the port to come up
  for (let i = 0; i < 60; i++) {
    if (await isPortOpen(CDP_PORT)) {
      console.log(`  CDP port ${CDP_PORT} is up.`);
      // Give Chrome a few extra seconds to render + pass Akamai
      await new Promise((r) => setTimeout(r, 6000));
      return;
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  console.log(`  Chrome spawned but CDP port ${CDP_PORT} never opened.`);
}

// Switch the on-page payment-type dropdown to BUSINESS → Financiële Renting,
// then read each Model 3 trim's cash + monthly directly from its trim card.
async function configureAndCollect(page) {
  // ─── Phase A: read cash prices from the trim selector while still on
  // the default "Privé: Contant" view. The trim cards show "<name> + € XX.XXX"
  // here. Once we switch to Financiële Renting the layout changes and prices
  // shown become the downpayment / monthly instead of the cash price.

  // Scroll once so the selector cards render
  await page.evaluate(async () => {
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    for (let y = 0; y < document.body.scrollHeight; y += 400) {
      window.scrollTo(0, y);
      await sleep(120);
    }
    window.scrollTo(0, 0);
  });
  await page.waitForTimeout(1200);

  const cashByName = await page.evaluate(() => {
    const TRIM_PATTERNS = [
      { key: "Long Range AWD", re: /long range (all-?wheel drive|awd|dual motor)/i },
      { key: "Long Range RWD", re: /long range (achterwielaandrijving|rear-?wheel)/i },
      { key: "Performance", re: /\bperformance\b/i },
      { key: "Achterwielaandrijving (RWD)", re: /achterwielaandrijving|rear-?wheel/i },
    ];
    const out = {};
    const els = document.querySelectorAll("*");
    const best = new Map();
    for (const el of els) {
      const t = (el.innerText || "").trim();
      if (!t || t.length > 800) continue;
      if (!/€\s*[\d.]{4,}/.test(t)) continue;
      for (const { key, re } of TRIM_PATTERNS) {
        if (re.test(t)) {
          const area =
            (el.offsetWidth || 0) * (el.offsetHeight || 0) ||
            Number.MAX_SAFE_INTEGER;
          const cur = best.get(key);
          if (!cur || area < cur.area) best.set(key, { area, text: t });
          break;
        }
      }
    }
    for (const [name, { text }] of best) {
      // Cash price = the LARGEST € figure in the card (filters out optional
      // accessory amounts).
      const all = [...text.matchAll(/€\s*([\d.]{4,})/g)].map((m) => parseFloat(m[1].replace(/\./g, "")));
      if (all.length) out[name] = Math.max(...all);
    }
    return out;
  });
  console.log("  cash prices:", cashByName);

  // ─── Phase B: switch payment type to BUSINESS Financiële Renting via the
  // TDS listbox widget. Currently-selected chip text is in `.tds-chip-text`.
  const dropdownStatus = await page.evaluate(async () => {
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    const chip = document.querySelector(".tds-chip-text");
    if (!chip) return { ok: false, reason: "no .tds-chip-text on page" };
    const startLabel = chip.innerText.trim();
    // Walk up to a clickable ancestor and click it
    let trigger = chip;
    for (let i = 0; i < 6 && trigger.parentElement; i++) {
      trigger = trigger.parentElement;
      if (trigger.matches("button, [role='combobox'], [role='button'], .tds-chip"))
        break;
    }
    trigger.click();
    await sleep(700);
    // Find the BUSINESS Financiële Renting option
    const target = [...document.querySelectorAll("[data-tds-label], [role='option']")]
      .find((o) =>
        /Zakelijk.*Financi[eë]le Renting.*Lage Afkoopwaarde/i.test(
          o.getAttribute("data-tds-label") || o.innerText || ""
        )
      );
    if (!target) return { ok: false, reason: "renting option not in DOM", startLabel };
    target.click();
    await sleep(2500);
    const newChip = document.querySelector(".tds-chip-text");
    return { ok: true, startLabel, endLabel: newChip ? newChip.innerText.trim() : null };
  });
  console.log("  dropdown:", dropdownStatus);
  await page.waitForTimeout(2500);

  // Debug: dump every "€ X..." occurrence with surrounding context after
  // switching to renting, so we can see how Tesla labels the monthly figure.
  const moneyContexts = await page.evaluate(() => {
    const t = document.body.innerText;
    const out = [];
    const re = /€\s*[\d.,]+/g;
    let m;
    while ((m = re.exec(t))) {
      const ctx = t.slice(Math.max(0, m.index - 40), m.index + 80).replace(/\s+/g, " ");
      out.push(ctx);
    }
    return out.slice(0, 25);
  });
  fs.writeFileSync(
    path.join(__dirname, "tesla-m3-rentingdump.txt"),
    moneyContexts.join("\n")
  );

  // ─── Phase C: under Financiële Renting the trim selector lists all four
  // trims with "<trim name> € XXX /mnd" inline. Capture every monthly in
  // one pass, then click each trim once to grab its specific downpayment
  // and residual value from the active panel.

  const monthlyByName = await page.evaluate(() => {
    const t = document.body.innerText;
    const map = {};
    // Look for "<trim name> ... € X /mnd" segments
    const patterns = [
      { key: "Long Range AWD", re: /long range all-?wheel drive[^€]{0,40}€\s*([\d.,]+)\s*\/\s*mnd/i },
      { key: "Long Range RWD", re: /long range achterwielaandrijving[^€]{0,40}€\s*([\d.,]+)\s*\/\s*mnd/i },
      { key: "Performance", re: /performance[^€]{0,40}€\s*([\d.,]+)\s*\/\s*mnd/i },
      // Plain achterwielaandrijving — match only when NOT preceded by "long range"
      { key: "Achterwielaandrijving (RWD)", re: /(?<!long range )achterwielaandrijving[^€]{0,40}€\s*([\d.,]+)\s*\/\s*mnd/i },
    ];
    for (const { key, re } of patterns) {
      const m = t.match(re);
      if (m) map[key] = m[1];
    }
    return map;
  });
  console.log("  monthlies:", monthlyByName);

  const trims = [];
  for (const trimName of Object.keys(cashByName)) {
    // Click the trim selector card so the active detail panel updates with
    // this trim's specific downpayment and residual.
    const clicked = await page.evaluate((tn) => {
      const norm = tn.replace(/\s*\(.*?\)\s*/g, "").trim();
      const reByKey = {
        "Long Range AWD": /long range (all-?wheel drive|awd|dual motor)/i,
        "Long Range RWD": /long range (achterwielaandrijving|rear-?wheel)/i,
        Performance: /\bperformance\b/i,
        Achterwielaandrijving: /(?<!long range )(achterwielaandrijving|rear-?wheel)/i,
      };
      const re = reByKey[norm] || reByKey.Achterwielaandrijving;
      const els = [
        ...document.querySelectorAll("[role='radio'], [role='option'], button, label, li"),
      ]
        .map((el) => ({ el, t: (el.innerText || "").trim() }))
        .filter(({ t }) => t && t.length < 400 && re.test(t) && /€\s*[\d.]/.test(t));
      if (!els.length) return false;
      els.sort(
        (a, b) =>
          (a.el.offsetWidth * a.el.offsetHeight || 1e9) -
          (b.el.offsetWidth * b.el.offsetHeight || 1e9)
      );
      els[0].el.scrollIntoView({ block: "center" });
      els[0].el.click();
      return true;
    }, trimName);
    if (!clicked) {
      console.log(`  ✗ couldn't click trim card for ${trimName}`);
    }
    await page.waitForTimeout(2200);

    const panel = await page.evaluate(() => {
      const t = document.body.innerText;
      // Active panel format:
      //   "*€ 6.800 aanbetaling, 60 maanden, X kilometer, 0% rente,
      //    geschatte restwaarde € 6.114, € 36.990 Aanschafprijs"
      const dp = t.match(/€\s*([\d.,]+)\s*aanbetaling/i);
      const term = t.match(/(\d{2,3})\s*maanden/i);
      const km = t.match(/([\d.,]+)\s*kilometer/i);
      const rv = t.match(/geschatte restwaarde[^€]{0,20}€\s*(\d[\d.]*\d|\d)/i);
      const rate = t.match(/(\d+(?:[.,]\d+)?)\s*%\s*rente/i);
      return {
        dp: dp ? dp[1] : null,
        term: term ? term[1] : null,
        km: km ? km[1] : null,
        rvAmount: rv ? rv[1] : null,
        zeroPctRente: rate ? rate[1].replace(",", ".") : null,
      };
    });

    trims.push({
      name: trimName,
      cash: cashByName[trimName] ? String(cashByName[trimName]) : null,
      monthly: monthlyByName[trimName] || null,
      ...panel,
    });
  }

  for (const t of trims) {
    console.log(
      `  ${t.name.padEnd(35)}  cash=€${t.cash ?? "?"}  mo=€${t.monthly ?? "?"}/mnd  ` +
        `dp=€${t.dp ?? "?"}  term=${t.term ?? "?"}  res=€${t.rvAmount ?? "?"}`
    );
  }
  return trims;
}

async function tryCDP() {
  await ensureChromeWithCDP();
  try {
    const browser = await chromium.connectOverCDP(`http://127.0.0.1:${CDP_PORT}`, {
      timeout: 6000,
    });
    const ctx = browser.contexts()[0] || (await browser.newContext());
    let page =
      ctx.pages().find((p) => /tesla\.com/i.test(p.url())) ||
      ctx.pages()[0] ||
      (await ctx.newPage());
    console.log(`✓ Attached to Chrome on :${CDP_PORT}`);
    // Always force-reload so we don't reuse a stale state from a prior run
    await page.goto(URL_M3, { waitUntil: "domcontentloaded", timeout: 60000 });
    await page
      .waitForFunction(() => /€\s*[\d.]{3,}/.test(document.body.innerText), {
        timeout: 30000,
      })
      .catch(() => {});
    await page.waitForTimeout(4000);

    // Drive the on-page configurator: switch to Business / Financiële Renting
    // and read each trim's monthly price.
    const driven = await configureAndCollect(page).catch((e) => {
      console.log("  configurator interaction failed:", e.message);
      return null;
    });

    const html = await page.content();
    const text = await page.evaluate(() => document.body.innerText);
    return { html, text, drivenTrims: driven, source: "cdp" };
  } catch (e) {
    console.log(`  CDP attach (port ${CDP_PORT}) failed: ${e.message.split("\n")[0]}`);
    return null;
  }
}

function trySavedHtml() {
  if (!fs.existsSync(SAVED_HTML)) return null;
  const html = fs.readFileSync(SAVED_HTML, "utf8");
  if (html.length < 5000) return null;
  // Strip tags for the text view
  const text = html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&euro;/g, "€")
    .replace(/&#x20AC;/gi, "€")
    .replace(/\s+/g, " ");
  console.log(`✓ Using saved HTML (${html.length} bytes)`);
  return { html, text, source: "saved" };
}

async function tryPlaywright() {
  console.log("→ falling back to patchright headful (often blocked)…");
  const userDataDir = path.join(__dirname, "tesla-profile3");
  const ctx = await chromium.launchPersistentContext(userDataDir, {
    headless: false,
    channel: "chrome",
    locale: "nl-BE",
    viewport: { width: 1500, height: 900 },
  });
  const page = ctx.pages()[0] || (await ctx.newPage());
  await page.goto(URL_M3, { waitUntil: "domcontentloaded", timeout: 60000 });
  await page
    .waitForFunction(() => /€\s*[\d.]{3,}/.test(document.body.innerText), {
      timeout: 25000,
    })
    .catch(() => {});
  await page.waitForTimeout(4000);
  const html = await page.content();
  const text = await page.evaluate(() => document.body.innerText);
  await ctx.close();
  return { html, text, source: "playwright" };
}

// Parse Tesla Model 3 trim cards from rendered HTML.
//
// Tesla's modern configurator renders one card per trim with:
//   <div ... class="...trim-selector...">
//     <h3>Achterwielaandrijving</h3>     ← trim name
//     ...
//     €&nbsp;42.970                       ← cash price (gross)
//     ...
//     vanaf €&nbsp;499/maand              ← optional monthly
//   </div>
function parseTrims(html, text) {
  const trims = [];

  // 1. Section-by-section parse: split HTML on trim headings.
  //    Tesla repeats the same trim heading inside expanded "details" panels,
  //    so we dedupe by cashGross (each Model 3 trim has a unique price) and
  //    normalize the displayed name.
  const blockRe =
    /<(?:h2|h3|h4)[^>]*>\s*([A-Za-zÀ-ÿ][^<]{2,80}?)\s*<\/(?:h2|h3|h4)>([\s\S]{0,1500})/g;
  const byPrice = new Map();
  const normName = (n) => {
    const s = n.replace(/\s+/g, " ").trim();
    if (/long range all-?wheel drive/i.test(s)) return "Long Range AWD";
    if (/long range/i.test(s) && /achterwiel/i.test(s)) return "Long Range RWD";
    if (/performance/i.test(s)) return "Performance";
    if (/achterwielaandrijving/i.test(s)) return "Achterwielaandrijving (RWD)";
    return s;
  };
  let m;
  while ((m = blockRe.exec(html))) {
    const name = m[1].replace(/\s+/g, " ").trim();
    if (
      !/(achterwielaandrijving|long range|performance|standard range|dual motor)/i.test(
        name
      )
    )
      continue;
    const block = m[2];
    const cashMatch = block.match(/€\s*([\d.]{4,})(?!\s*<[^>]*>\s*\/)/);
    const monthlyMatch =
      block.match(/€\s*([\d.,]+)[^<]{0,20}<[^>]*>\s*\/\s*(?:maand|mo)/i) ||
      block.match(/€\s*([\d.,]+)\s*\/\s*(?:maand|mo)/i) ||
      block.match(/vanaf\s*€\s*([\d.,]+)\s*per\s*maand/i);
    const cash = cashMatch ? parseEur(cashMatch[1]) : null;
    const monthly = monthlyMatch ? parseEur(monthlyMatch[1]) : null;
    if (cash && cash > 25000 && cash < 200000) {
      const key = cash;
      if (!byPrice.has(key)) {
        byPrice.set(key, {
          name: normName(name),
          cashGross: cash,
          monthlyGross: monthly,
        });
      } else if (monthly && byPrice.get(key).monthlyGross == null) {
        byPrice.get(key).monthlyGross = monthly;
      }
    }
  }
  for (const v of byPrice.values()) trims.push(v);
  trims.sort((a, b) => a.cashGross - b.cashGross);

  // 2. Fallback: scan plain text
  if (!trims.length) {
    const lines = text.split(/\s{2,}|\n+/).map((l) => l.trim()).filter(Boolean);
    for (let i = 0; i < lines.length; i++) {
      if (
        /^(achterwielaandrijving|long range|performance|standard range)\b/i.test(
          lines[i]
        )
      ) {
        const window = lines.slice(i, i + 6).join(" | ");
        const cash = window.match(/€\s*([\d.]{4,})(?!\s*\/)/);
        const monthly = window.match(/€\s*([\d.,]+)\s*\/\s*(?:maand|mo)/i);
        if (cash) {
          trims.push({
            name: lines[i],
            cashGross: parseEur(cash[1]),
            monthlyGross: monthly ? parseEur(monthly[1]) : null,
          });
        }
      }
    }
  }
  return trims;
}

function buildResult(variant) {
  const grossToNet = (g) => (g != null ? Math.round((g / 1.21) * 100) / 100 : null);
  const catalogGross = variant.cashGross ?? null;
  const catalogNet = variant.cashNet ?? grossToNet(catalogGross);
  const monthlyNet = variant.monthlyNet ?? grossToNet(variant.monthlyGross);
  const monthlyGross =
    variant.monthlyGross ??
    (monthlyNet != null ? Math.round(monthlyNet * 1.21 * 100) / 100 : null);
  const term = variant.termMonths ?? null;
  const dpNet = variant.downPaymentNet ?? grossToNet(variant.downPaymentGross);
  const dpGross =
    variant.downPaymentGross ??
    (dpNet != null ? Math.round(dpNet * 1.21 * 100) / 100 : null);
  const rvNet = variant.residualValueNet ?? null;
  const rvPct = variant.residualValuePct ?? (catalogNet && rvNet ? rvNet / catalogNet : null);
  const financed =
    catalogNet != null && dpNet != null ? catalogNet - dpNet : null;
  const ir =
    financed && rvNet != null && monthlyNet && term
      ? impliedAnnualRate(financed, rvNet, monthlyNet, term)
      : null;
  const totalNet =
    monthlyNet != null && term && dpNet != null
      ? monthlyNet * term + dpNet
      : null;

  return {
    url: URL_M3,
    slug: "model3",
    modelName: "Tesla Model 3" + (variant.name ? " " + variant.name : ""),
    financialRenting: {
      productName: "Tesla Financial Services — Lease",
      productId: "TESLA_LEASE",
      customerType: "BUSINESS",
      productType: "LEASE",
      vehiclePriceNet: catalogNet,
      vehiclePriceGross: catalogGross,
      monthlyNet,
      monthlyGross,
      downPaymentNet: dpNet,
      downPaymentGross: dpGross,
      downPaymentPct:
        catalogNet && dpNet != null ? dpNet / catalogNet : null,
      termMonths: term,
      annualMileage: variant.annualMileage ?? null,
      contractMileage: variant.contractMileage ?? null,
      interestEffective: ir,
      residualValueNet: rvNet,
      residualValuePct: rvPct,
      sumOfAllPaymentsNet: totalNet,
      sumOfAllPaymentsGross: null,
    },
  };
}

async function main() {
  console.log("Tesla Belgium — Model 3 Scraper");
  console.log("=".repeat(70));

  let captured =
    trySavedHtml() || (await tryCDP()) || (await tryPlaywright());

  fs.writeFileSync(path.join(__dirname, "tesla-m3.html"), captured.html);
  fs.writeFileSync(path.join(__dirname, "tesla-m3.txt"), captured.text);

  if (/Access Denied/i.test(captured.html) && captured.source !== "saved") {
    console.log("");
    console.log("⚠️  Tesla blocked the request (Akamai). To proceed, do ONE of:");
    console.log("    a) Open Chrome with --remote-debugging-port=9222, log into");
    console.log(`       Tesla, navigate to ${URL_M3}, then re-run this script.`);
    console.log("    b) Save the rendered configurator page as HTML to:");
    console.log(`       ${SAVED_HTML}`);
    console.log("       and re-run.");
    fs.writeFileSync(path.join(__dirname, "tesla-results.json"), "[]");
    return;
  }

  // Prefer the live configurator readings (per-trim monthly), fall back to
  // static HTML parsing if the interaction step couldn't run.
  let trims = [];
  if (captured.drivenTrims?.length) {
    // Tesla's renting view shows the cash price as INCL BTW (gross) but the
    // monthly / downpayment / residual numbers all as EXCL BTW (net) — there
    // is an explicit "Alle bedragen zijn exclusief BTW" disclaimer next to
    // them. We store them in the same convention the other brands use.
    trims = captured.drivenTrims.map((d) => {
      const cashGross = parseEur(d.cash);
      const monthlyNet = parseEur(d.monthly);
      const dpNet = parseEur(d.dp);
      const rvNet = parseEur(d.rvAmount);
      return {
        name: d.name,
        cashGross,
        cashNet: cashGross != null ? Math.round((cashGross / 1.21) * 100) / 100 : null,
        monthlyNet,
        monthlyGross: monthlyNet != null ? Math.round(monthlyNet * 1.21 * 100) / 100 : null,
        downPaymentNet: dpNet,
        downPaymentGross: dpNet != null ? Math.round(dpNet * 1.21 * 100) / 100 : null,
        residualValueNet: rvNet,
        residualValuePct:
          rvNet != null && cashGross
            ? rvNet / (cashGross / 1.21)
            : null,
        termMonths: d.term ? parseInt(d.term, 10) : null,
        contractMileage: d.km
          ? parseInt(String(d.km).replace(/[.,]/g, ""), 10)
          : null,
      };
    });
  } else {
    trims = parseTrims(captured.html, captured.text);
  }

  if (!trims.length) {
    console.log("⚠️  Loaded the page but found no trims. Check tesla-m3.html.");
  }

  const results = trims.map(buildResult);
  console.log(`\nExtracted ${results.length} Model 3 trim(s) from ${captured.source}:`);
  for (const r of results) {
    const f = r.financialRenting;
    console.log(
      `  ${r.modelName.padEnd(48)}  cash=€${f.vehiclePriceGross}  ` +
        `mo=${f.monthlyGross != null ? "€" + f.monthlyGross : "?"}`
    );
  }

  fs.writeFileSync(
    path.join(__dirname, "tesla-results.json"),
    JSON.stringify(results, null, 2)
  );
  console.log(`\n✅ Saved tesla-results.json (${results.length} entries)`);
}

main().catch((e) => {
  console.error("Fatal:", e);
  process.exit(1);
});
