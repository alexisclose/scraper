// Mercedes-Benz Belgium I/O. Three endpoints:
//   1. VMOS summary — public model catalogue with `bm4` (4-digit baumuster).
//   2. OWCC entry  — turns a 7-digit baumuster into a human "trim name".
//   3. FCIS calc   — the actual finance/lease price calculator.
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { httpJson, httpFetch } from '../../libraries/http/fetch.js';
import { ParseError, FetchError } from '../../libraries/error-handling/AppError.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const KNOWN_SUFFIX_BY_SERIES = JSON.parse(
  readFileSync(join(__dirname, 'data', 'known-suffixes.json'), 'utf8'),
);
const CLASS_CODE_FALLBACKS = JSON.parse(
  readFileSync(join(__dirname, 'data', 'class-code-fallbacks.json'), 'utf8'),
);

const HEADERS = {
  'Content-Type': 'application/json',
  Origin: 'https://www.mercedes-benz.be',
  Referer: 'https://www.mercedes-benz.be/',
};

const VMOS_URL =
  'https://api.oneweb.mercedes-benz.com/vmos-api/v1/data/BE/nl/OWF/live/summary';
const FCIS_URL =
  'https://api.oneweb.mercedes-benz.com/fcis-calculation-api/v1/calculation/CC/BE/nl';

function rawSeries(modelSeries) {
  if (!modelSeries) return null;
  return modelSeries.split(/[|-]/)[0];
}

export function buildBaumuster(bm4, modelSeries) {
  if (!bm4) return null;
  const suffix = KNOWN_SUFFIX_BY_SERIES[rawSeries(modelSeries)] || '111';
  return bm4 + suffix;
}

export async function fetchModels() {
  const j = await httpJson(VMOS_URL, { headers: HEADERS });
  const out = [];
  for (const [k, v] of Object.entries(j.vehiclesData || {})) {
    if (k.startsWith('all.')) continue;
    if (!v.bm4 || !v.technicalData?.priceData?.all?.value) continue;
    out.push({
      vmosKey: k,
      name: v.name,
      classId: v.classId,
      bodytypeId: v.bodytypeId,
      modelSeries: v.modelSeries,
      bm4: v.bm4,
      priceGross: v.technicalData.priceData.all.value,
      baumuster: buildBaumuster(v.bm4, v.modelSeries),
    });
  }
  // Disambiguate identical short names (e.g. two "CLA" entries)
  const counts = {};
  out.forEach((m) => {
    counts[m.name] = (counts[m.name] || 0) + 1;
  });
  for (const m of out) {
    m.displayName =
      counts[m.name] > 1 && m.modelSeries
        ? `${m.name} (${m.modelSeries.split('|')[0]})`
        : m.name;
  }
  return out;
}

const dataVersionCache = { v: null };
async function getDataVersion() {
  if (dataVersionCache.v) return dataVersionCache.v;
  const j = await httpJson(
    'https://api.oneweb.mercedes-benz.com/owcc-backend/api/v3/nl_BE/CCci/version',
    { headers: HEADERS },
  ).catch(() => null);
  dataVersionCache.v = j?.dataVersion || null;
  return dataVersionCache.v;
}

// Loose consistency check — the entry endpoint will happily return the wrong
// trim if our baumuster collides with a different model's. Reject obviously
// inconsistent answers (EQT/T-Class share a bm4, etc.).
export function trimMatchesModel(trim, model) {
  if (!trim) return false;
  const t = trim.toLowerCase();
  const cls = (model.classId || '').toLowerCase().replace('-class', '');
  const fam = (model.name || '').toLowerCase();
  if (fam && t.includes(fam.split(' ')[0])) return true;
  if (cls.startsWith('eq')) return /\beq[a-z0-9]/i.test(trim);
  if ((model.modelSeries || '').includes('maybach')) return /maybach/i.test(trim);
  const letter = cls.charAt(0);
  if (letter && /^[a-z]$/.test(letter)) {
    return new RegExp(`\\b${letter}[\\s-]?\\w*\\d`, 'i').test(trim);
  }
  return true;
}

export async function tryFetchTrimName(baumuster, _modelSeries) {
  const dv = await getDataVersion();
  if (!dv) return null;
  for (const code of CLASS_CODE_FALLBACKS) {
    try {
      const j = await httpJson(
        `https://api.oneweb.mercedes-benz.com/owcc-backend/api/v3/nl_BE/${code}/${dv}/entry?modelIds=${baumuster}`,
        { headers: HEADERS, retries: 0 },
      );
      const pc = j.preConfigs?.find((p) => p.preConfigId === 'BASIC') || j.preConfigs?.[0];
      const name =
        pc?.motorizationName ||
        pc?.tags?.find((t) => /motoriz/i.test(t.id || ''))?.value;
      if (name) return name;
    } catch {
      /* try next class code */
    }
  }
  return null;
}

// Two-step FCIS dance: init() to get an engineId + carPriceNet, then real
// calc() with our forced 60-month/20%-down inputs.
export async function fcisRenting({ carPriceGross, baumuster }) {
  const initBody = {
    vehicle: {
      condition: { condition: 'new' },
      prices: [
        { id: 'baseListPrice', currency: 'EUR', rawValue: carPriceGross },
        { id: 'grossListPrice', currency: 'EUR', rawValue: carPriceGross },
      ],
      vehicleConfiguration: {
        division: 'pc',
        brand: 'mercedes-benz',
        baumuster,
        equipments: [],
      },
      technicalData: [],
      alternativeConfiguration: [],
    },
    input: [
      { id: 'customerType', value: 'business' },
      { id: 'fundingProduct', value: 'Renting' },
    ],
  };
  let initRes;
  try {
    initRes = await httpFetch(FCIS_URL, {
      method: 'POST',
      headers: HEADERS,
      body: JSON.stringify(initBody),
    });
  } catch (e) {
    throw new FetchError(`FCIS init failed: ${e.message}`, { code: 'FCIS_INIT', cause: e });
  }
  const init = await initRes.json();
  const engineId = JSON.parse(init.opaque || '{}')?._engineId;
  if (!engineId) throw new ParseError('FCIS init returned no engineId', { code: 'FCIS_NO_ID' });
  const get = (id) => init.input?.items?.find((i) => i.id === id)?.value?.value;
  const carPriceNet = parseFloat(get('carPriceNet'));
  if (!carPriceNet) throw new ParseError('FCIS init returned no carPriceNet');
  const actualProduct = get('fundingProduct') || 'Renting';
  const dpNet = (carPriceNet * 0.2).toFixed(2);

  const calcBody = {
    vehicle: initBody.vehicle,
    input: [
      { id: 'customerType', value: 'business' },
      { id: 'fundingProduct', value: actualProduct },
      { id: 'firstPayment', value: dpNet },
      { id: 'duration', value: '60' },
    ],
    opaque: JSON.stringify({
      _engineId: engineId,
      customerType: 'business',
      fundingProduct: actualProduct,
      firstPayment: dpNet,
      duration: '60',
    }),
  };
  const calcRes = await httpFetch(FCIS_URL, {
    method: 'POST',
    headers: HEADERS,
    body: JSON.stringify(calcBody),
  });
  return { calculation: await calcRes.json(), actualProduct };
}
