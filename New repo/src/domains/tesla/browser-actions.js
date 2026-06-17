// All `page.evaluate` blocks for the Tesla configurator live here so they're
// individually unit-testable against a JSDOM fixture (test/domains/tesla.test.js).
//
// Naming: each exported function takes a Playwright Page and returns plain
// JSON — no brand-specific logic leaks back into the orchestrator.
//
// IMPORTANT: nothing here hardcodes a model. The trim patterns and localized
// Dutch labels are passed in by the orchestrator (from candidate-models.json
// and configs/brands/tesla.json) so the exact same code reads Model 3, Y, S, X
// and any future model. This is what makes the scraper multi-model.

/* global document, window */

// Phase A: read each trim's gross cash price from the default "Privé: Contant"
// view, before we switch the payment-type dropdown.
//
// `trimPatterns` is `[{ key, re }]` where `re` is a *string* regex source for
// the model currently loaded (so e.g. Model 3 never sees Model S patterns).
export async function readCashPrices(page, trimPatterns) {
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
    const compiled = patterns.map((p) => ({ key: p.key, re: new RegExp(p.re, 'i') }));
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
  }, trimPatterns);
}

// Debug helper: dump every "trim-like" card (short text + a €price) found on
// the page, regardless of whether it matched a known pattern. Read-only — used
// only for logging so maintainers can spot a renamed/added trim that the
// per-model pattern list doesn't yet cover. Never feeds the schema.
export async function dumpTrimCards(page) {
  return page.evaluate(() => {
    const seen = new Set();
    const cards = [];
    for (const el of document.querySelectorAll(
      "[role='radio'], [role='option'], button, label, li",
    )) {
      const t = (el.innerText || '').replace(/\s+/g, ' ').trim();
      if (!t || t.length > 160) continue;
      if (!/€\s*[\d.]{3,}/.test(t)) continue;
      if (seen.has(t)) continue;
      seen.add(t);
      cards.push(t);
    }
    return cards.slice(0, 40);
  });
}

// Phase B: programmatically expand Tesla's TDS listbox dropdown and pick the
// "Zakelijk → Financiële Renting (Lage Afkoopwaarde)" option. The option text
// to match is supplied as a string regex source from config (`labels`) so the
// Dutch label lives in one place.
export async function selectBusinessFinancialRenting(page, optionReSource) {
  const result = await page.evaluate(async (reSource) => {
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    const optionRe = new RegExp(reSource, 'i');
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
      optionRe.test(o.getAttribute('data-tds-label') || o.innerText || ''),
    );
    if (!target) return { ok: false, reason: 'option-not-found', startLabel };
    target.click();
    await sleep(2500);
    const newChip = document.querySelector('.tds-chip-text');
    return { ok: true, startLabel, endLabel: newChip ? newChip.innerText.trim() : null };
  }, optionReSource);
  await page.waitForTimeout(2500);
  return result;
}

// Phase C, sub-step 1: read the "<trim> € XYZ /mnd" listing that's now visible
// on the trim selector under Renting. All trims for the current model in one
// call. Derives the per-trim monthly regex from the same `re` used for cash.
export async function readMonthliesByTrim(page, trimPatterns, monthlySuffix) {
  return page.evaluate(
    ({ patterns, suffix }) => {
      const text = document.body.innerText;
      const map = {};
      for (const { key, re } of patterns) {
        // The trim `re` may itself contain capturing groups (e.g. "long range
        // (awd|dual motor)"), so the price uses a *named* group to stay
        // index-independent.
        const monthlyRe = new RegExp(`${re}[^€]{0,40}€\\s*(?<price>[\\d.,]+)\\s*${suffix}`, 'i');
        const m = text.match(monthlyRe);
        if (m && m.groups && m.groups.price) map[key] = m.groups.price;
      }
      return map;
    },
    { patterns: trimPatterns, suffix: monthlySuffix },
  );
}

// Phase C, sub-step 2: click a trim card; once active, read its specific
// downpayment / term / km / residual from the legal-mention panel. The trim's
// own regex (`trimRe`) and the panel field regexes (`labels`) are passed in so
// the function stays model-agnostic.
export async function selectTrimAndReadPanel(page, trimRe, labels) {
  await page.evaluate((reSource) => {
    const re = new RegExp(reSource, 'i');
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
  }, trimRe);
  await page.waitForTimeout(2200);

  return page.evaluate((lbl) => {
    const t = document.body.innerText;
    const grab = (src) => {
      if (!src) return null;
      const m = t.match(new RegExp(src, 'i'));
      return m ? m[1] : null;
    };
    return {
      dp: grab(lbl.downPayment),
      term: grab(lbl.term),
      km: grab(lbl.mileage),
      rv: grab(lbl.residual),
    };
  }, labels);
}
