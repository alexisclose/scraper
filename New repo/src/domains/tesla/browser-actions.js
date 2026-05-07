// All `page.evaluate` blocks for the Tesla configurator live here so they're
// individually unit-testable against a JSDOM fixture (test/domains/tesla.test.js).
//
// Naming: each exported function takes a Playwright Page and returns plain
// JSON — no brand-specific logic leaks back into the orchestrator.

/* global document, window */

const TRIM_PATTERNS = [
  { key: 'Long Range AWD', re: /long range (all-?wheel drive|awd|dual motor)/i },
  { key: 'Long Range RWD', re: /long range (achterwielaandrijving|rear-?wheel)/i },
  { key: 'Performance', re: /\bperformance\b/i },
  { key: 'Achterwielaandrijving (RWD)', re: /(?<!long range )(achterwielaandrijving|rear-?wheel)/i },
];

// Phase A: read each trim's gross cash price from the default "Privé: Contant"
// view, before we switch the payment-type dropdown.
export async function readCashPrices(page) {
  // Lazy-rendered sections: scroll once
  await page.evaluate(async () => {
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    for (let y = 0; y < document.body.scrollHeight; y += 400) {
      window.scrollTo(0, y);
      await sleep(120);
    }
    window.scrollTo(0, 0);
  });
  await page.waitForTimeout(1200);

  return page.evaluate((patterns) => {
    const compiled = patterns.map((p) => ({ key: p.key, re: new RegExp(p.reSource, 'i') }));
    const best = new Map();
    for (const el of document.querySelectorAll('*')) {
      const t = (el.innerText || '').trim();
      if (!t || t.length > 800) continue;
      if (!/€\s*[\d.]{4,}/.test(t)) continue;
      for (const { key, re } of compiled) {
        if (re.test(t)) {
          const area = (el.offsetWidth || 0) * (el.offsetHeight || 0) || Number.MAX_SAFE_INTEGER;
          const cur = best.get(key);
          if (!cur || area < cur.area) best.set(key, { area, text: t });
          break;
        }
      }
    }
    const out = {};
    for (const [name, { text }] of best) {
      const all = [...text.matchAll(/€\s*([\d.]{4,})/g)].map((m) =>
        parseFloat(m[1].replace(/\./g, '')),
      );
      if (all.length) out[name] = Math.max(...all);
    }
    return out;
  }, TRIM_PATTERNS.map((p) => ({ key: p.key, reSource: p.re.source })));
}

// Phase B: programmatically expand Tesla's TDS listbox dropdown and pick the
// "Zakelijk → Financiële Renting (Lage Afkoopwaarde)" option.
export async function selectBusinessFinancialRenting(page) {
  const result = await page.evaluate(async () => {
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    const chip = document.querySelector('.tds-chip-text');
    if (!chip) return { ok: false, reason: 'chip-text-missing' };
    const startLabel = chip.innerText.trim();
    let trigger = chip;
    for (let i = 0; i < 6 && trigger.parentElement; i += 1) {
      trigger = trigger.parentElement;
      if (trigger.matches("button, [role='combobox'], [role='button'], .tds-chip")) break;
    }
    trigger.click();
    await sleep(700);
    const target = [...document.querySelectorAll("[data-tds-label], [role='option']")].find((o) =>
      /Zakelijk.*Financi[eë]le Renting.*Lage Afkoopwaarde/i.test(
        o.getAttribute('data-tds-label') || o.innerText || '',
      ),
    );
    if (!target) return { ok: false, reason: 'option-not-found', startLabel };
    target.click();
    await sleep(2500);
    const newChip = document.querySelector('.tds-chip-text');
    return { ok: true, startLabel, endLabel: newChip ? newChip.innerText.trim() : null };
  });
  await page.waitForTimeout(2500);
  return result;
}

// Phase C, sub-step 1: read the "<trim> € XYZ /mnd" listing that's now visible
// on the trim selector under Renting. All four monthlies in one call.
export async function readMonthliesByTrim(page) {
  return page.evaluate(() => {
    const text = document.body.innerText;
    const map = {};
    const patterns = [
      [/long range all-?wheel drive[^€]{0,40}€\s*([\d.,]+)\s*\/\s*mnd/i, 'Long Range AWD'],
      [
        /long range achterwielaandrijving[^€]{0,40}€\s*([\d.,]+)\s*\/\s*mnd/i,
        'Long Range RWD',
      ],
      [/performance[^€]{0,40}€\s*([\d.,]+)\s*\/\s*mnd/i, 'Performance'],
      [
        /(?<!long range )achterwielaandrijving[^€]{0,40}€\s*([\d.,]+)\s*\/\s*mnd/i,
        'Achterwielaandrijving (RWD)',
      ],
    ];
    for (const [re, key] of patterns) {
      const m = text.match(re);
      if (m) map[key] = m[1];
    }
    return map;
  });
}

// Phase C, sub-step 2: click a trim card; once active, read its specific
// downpayment / term / km / residual from the legal-mention panel.
export async function selectTrimAndReadPanel(page, trimKey) {
  await page.evaluate((tn) => {
    const norm = tn.replace(/\s*\(.*?\)\s*/g, '').trim();
    const reByKey = {
      'Long Range AWD': /long range (all-?wheel drive|awd|dual motor)/i,
      'Long Range RWD': /long range (achterwielaandrijving|rear-?wheel)/i,
      Performance: /\bperformance\b/i,
      Achterwielaandrijving: /(?<!long range )(achterwielaandrijving|rear-?wheel)/i,
    };
    const re = reByKey[norm] || reByKey.Achterwielaandrijving;
    const els = [
      ...document.querySelectorAll("[role='radio'], [role='option'], button, label, li"),
    ]
      .map((el) => ({ el, t: (el.innerText || '').trim() }))
      .filter(({ t }) => t && t.length < 400 && re.test(t) && /€\s*[\d.]/.test(t));
    if (!els.length) return false;
    els.sort(
      (a, b) =>
        (a.el.offsetWidth * a.el.offsetHeight || 1e9) -
        (b.el.offsetWidth * b.el.offsetHeight || 1e9),
    );
    els[0].el.scrollIntoView({ block: 'center' });
    els[0].el.click();
    return true;
  }, trimKey);
  await page.waitForTimeout(2200);

  return page.evaluate(() => {
    const t = document.body.innerText;
    const dp = t.match(/€\s*([\d.,]+)\s*aanbetaling/i);
    const term = t.match(/(\d{2,3})\s*maanden/i);
    const km = t.match(/([\d.,]+)\s*kilometer/i);
    const rv = t.match(/geschatte restwaarde[^€]{0,20}€\s*(\d[\d.]*\d|\d)/i);
    return {
      dp: dp ? dp[1] : null,
      term: term ? term[1] : null,
      km: km ? km[1] : null,
      rv: rv ? rv[1] : null,
    };
  });
}

export const TESLA_TRIM_KEYS = TRIM_PATTERNS.map((p) => p.key);
