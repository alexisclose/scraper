// Belgian VAT (BTW) conversions. The default rate is 21% but every helper
// accepts an override so we can re-use the same code for Luxembourg (17%) or
// any future jurisdiction.

export const DEFAULT_VAT_RATE = 0.21;

const round2 = (n) => Math.round(n * 100) / 100;

export function netToGross(net, vatRate = DEFAULT_VAT_RATE) {
  if (net === null || net === undefined || !Number.isFinite(net)) return null;
  return round2(net * (1 + vatRate));
}

export function grossToNet(gross, vatRate = DEFAULT_VAT_RATE) {
  if (gross === null || gross === undefined || !Number.isFinite(gross)) return null;
  return round2(gross / (1 + vatRate));
}

// Given a known value on one side of the BTW divide, fill in the other side.
// Useful for brand parsers that might receive either form.
export function pairWithBtw({ net, gross, vatRate = DEFAULT_VAT_RATE }) {
  if (net != null && gross != null) return { net: round2(net), gross: round2(gross) };
  if (net != null) return { net: round2(net), gross: netToGross(net, vatRate) };
  if (gross != null) return { net: grossToNet(gross, vatRate), gross: round2(gross) };
  return { net: null, gross: null };
}
