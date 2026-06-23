// StickerPrice — the canonical shape the sticker-price scraper produces.
//
// Unlike the LeaseOffer schema (which models a fully-resolved finance
// calculation), a StickerPrice record is an *observation*: "on this page, in
// this asset, we saw this advertised amount". One page typically yields many
// records — a hero image with "vanaf € 39.990", a banner video frame with
// "€ 399/maand", a bit of visible HTML text, etc. Downstream consumers decide
// how to reconcile them; the scraper's job is faithful capture, not judgement.
import { z } from 'zod';

// A single price token extracted from a chunk of text (HTML, OCR'd image, or
// OCR'd video frame). `kind` is a best-effort classification from the words
// surrounding the amount; `unit` follows from it.
export const priceSchema = z.object({
  amount: z.number().positive(),
  currency: z.literal('EUR').default('EUR'),
  // monthly  → "/maand", "p.m.", "/mois"
  // cash     → an outright/catalog price ("vanaf € 39.990")
  // discount → a saving ("voordeel tot € 5.000", "korting")
  // deposit  → an up-front amount ("voorschot", "acompte")
  // unknown  → a euro amount we couldn't contextualise
  kind: z.enum(['monthly', 'cash', 'discount', 'deposit', 'unknown']).default('unknown'),
  unit: z.enum(['per_month', 'total']).default('total'),
  raw: z.string(), // the exact substring matched, e.g. "€ 399"
  context: z.string().nullable().optional(), // a short window of surrounding text
});

export const stickerPriceSchema = z.object({
  brand: z.string(), // free-form: this scraper is brand-agnostic
  pageUrl: z.string().url(),
  pageTitle: z.string().nullable().optional(),

  // Where the amount came from. This is the whole point of the scraper —
  // distinguishing a price baked into a JPEG/MP4 from one in the DOM.
  source: z.enum(['html', 'image', 'video']),
  assetUrl: z.string().nullable(), // null for source:'html'
  assetType: z.string().nullable().optional(), // mime, e.g. "image/png"

  scrapedAt: z.string().datetime(),

  // OCR provenance (null for source:'html'). Confidence is Tesseract's 0–100.
  ocrText: z.string().nullable().optional(),
  ocrConfidence: z.number().nullable().optional(),
  frameTimestampSec: z.number().nullable().optional(), // for source:'video'

  // alt text, nearby heading, or other locating hint
  context: z.string().nullable().optional(),

  prices: z.array(priceSchema),
});

export const stickerPriceArraySchema = z.array(stickerPriceSchema);

export function validateStickerPrice(raw) {
  return stickerPriceSchema.parse(raw);
}
