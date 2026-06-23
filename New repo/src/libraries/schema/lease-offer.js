// LeaseOffer — the canonical shape every brand adapter must produce.
//
// The schema is the single source of truth for what `data/raw/<brand>-*.json`
// looks like AND what columns the Excel report contains. If a brand parser
// can't fill in a field, leave it as null — never coerce to 0 or "" because
// that hides missing data downstream.
import { z } from 'zod';

// "Money fields" come in pairs: one excl. BTW, one incl. BTW. Brands disagree
// on which they show by default (BMW: net; Tesla: mixed; VW: gross), but the
// schema is symmetric so adapters can hand either side and let the BTW helper
// fill in the other.
const moneyPair = (key) =>
  z
    .object({
      [`${key}Net`]: z.number().nullable(),
      [`${key}Gross`]: z.number().nullable(),
    })
    .partial();

export const financialRentingSchema = z.object({
  productName: z.string(),
  productId: z.string(),
  customerType: z.enum(['BUSINESS', 'PRIVATE']).default('BUSINESS'),
  productType: z.enum(['LEASE', 'LOAN', 'CASH']).default('LEASE'),

  // Vehicle catalog price
  vehiclePriceNet: z.number().nullable(),
  vehiclePriceGross: z.number().nullable(),

  // Monthly payment
  monthlyNet: z.number().nullable(),
  monthlyGross: z.number().nullable(),

  // Initial downpayment (a.k.a. first increased rent)
  downPaymentNet: z.number().nullable(),
  downPaymentGross: z.number().nullable(),
  downPaymentPct: z.number().nullable(),

  // Term & mileage
  termMonths: z.number().int().positive().nullable(),
  annualMileage: z.number().int().positive().nullable(),
  contractMileage: z.number().int().positive().nullable(),

  // Solver-derived
  interestEffective: z.number().nullable(),

  // Residual / purchase option
  residualValueNet: z.number().nullable(),
  residualValuePct: z.number().nullable(),

  // Totals
  sumOfAllPaymentsNet: z.number().nullable(),
  sumOfAllPaymentsGross: z.number().nullable(),
});

export const leaseOfferSchema = z.object({
  // Identity — different shape per brand but always present
  brand: z.enum(['bmw', 'mercedes', 'tesla', 'vw', 'audi']),
  url: z.string().url().nullable(),
  slug: z.string().nullable(),
  modelName: z.string(),
  modelRange: z.string().nullable().optional(), // BMW "i7", Tesla "Model 3"
  modelCode: z.string().nullable().optional(), // BMW "23BV", Mercedes baumuster
  bonusMalus: z.number().nullable().optional(),

  scrapedAt: z.string().datetime(),
  financialRenting: financialRentingSchema,
});

export const leaseOfferArraySchema = z.array(leaseOfferSchema);

// Validate a single offer — throws a Zod error if invalid. Adapters call this
// at the boundary so a regression in upstream HTML never silently produces
// garbage downstream.
export function validateOffer(raw) {
  return leaseOfferSchema.parse(raw);
}

export { moneyPair };
