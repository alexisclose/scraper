// Parses a Belgian-formatted Euro amount into a JS Number.
//
// Belgium uses comma as decimal separator and dot as thousands separator
// (e.g. "€ 49.723,14"). Returns null for empty or unparseable input rather
// than throwing — most callers want to fall through to a regex fallback.

// U+00A0 non-breaking space — Tesla and VW both use it as the thousands gap.
// Expressed via the JS escape so source stays plain ASCII.
const NBSP_RE = new RegExp('\u00A0', 'g');

export function parseEur(input) {
  if (input === null || input === undefined) return null;
  const s = String(input)
    .replace(/&nbsp;/g, ' ')
    .replace(NBSP_RE, ' ')
    .replace(/[€\s]/g, '')
    .trim();
  if (!s) return null;
  // Strip thousands-separator dots (a dot followed by exactly 3 digits and a
  // non-digit / end-of-string), then convert decimal comma to dot.
  const num = s.replace(/\.(?=\d{3}(\D|$))/g, '').replace(',', '.');
  const n = Number.parseFloat(num);
  return Number.isFinite(n) ? n : null;
}

// Symmetric formatter — used in CLI progress output so the user sees the same
// "€ 49.723,14" shape they'd see on the brand website.
export function formatEur(n, { decimals = 2 } = {}) {
  if (n === null || n === undefined || !Number.isFinite(n)) return '–';
  return new Intl.NumberFormat('nl-BE', {
    style: 'currency',
    currency: 'EUR',
    minimumFractionDigits: decimals,
    maximumFractionDigits: decimals,
  }).format(n);
}
