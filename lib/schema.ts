// The /api/analyze data contract — see PRD "Data contracts".
// This schema is also handed to the model via structured outputs so the
// response is guaranteed to match the shape below.

export const CATEGORIES = [
  "furniture",
  "electronics",
  "clothing",
  "shoes",
  "jewelry",
  "accessory",
  "collectible",
  "kitchenware",
  "home_decor",
  "tool",
  "sporting_goods",
  "toy",
  "book_media",
  "other",
] as const;

export const CONDITIONS = ["new", "like_new", "good", "fair", "poor"] as const;

export const SPECIFICITY = ["exact", "generic"] as const;

// What KIND of value we're estimating. The app was built around "resale", but
// not everything photographed has a secondhand market to look up: an original
// painting, a handmade piece, anything one-of-a-kind is sold by its maker for
// the FIRST time, so pricing it below retail is answering the wrong question
// (there is no retail — the seller is the primary market).
export const VALUATION_BASIS = ["resale", "original"] as const;

// The model's own read on whether looking the item up would materially change
// its number. A Levi's 501 is "high" (a deep, stable market it already knows);
// a hand-thrown mug or a niche collectible is "low".
//
// This once gated the web-search pass, but no longer spends money — see
// shouldVerify() in lib/handler.ts for why the gate narrowed to originals. It
// is still emitted and logged: it costs two tokens, and it is the only record
// of which scans the model itself considered a guess, which is worth having
// when the time comes to check prices against what things actually sold for.
export const PRICE_CONFIDENCE = ["high", "low"] as const;
// Whether the listings a price search found were for this exact item, or only
// for comparable ones. Decides the wording of the note under the price.
export const LISTING_MATCH = ["exact", "similar"] as const;
// How much the price check's search turned up: no usable prices, a few that
// help, or enough to stand behind. Only "enough" earns the green tick; "a_few"
// still moves the range, under a plainer note.
export const VERIFY_EVIDENCE = ["none", "a_few", "enough"] as const;

// Where the price we return actually came from. Set by the SERVER, never by the
// model: "verified" only after lib/verify.ts successfully refined the range.
export const PRICE_BASIS = ["estimate", "verified"] as const;

// How well an original piece is executed, judged from the photo.
//
// The market for handmade work is not one band, it is TIERS — a search for
// "shark painting price" comes back with prints at $3-35, decorative canvases
// at $45-150, handmade work at $400-1,700, and gallery pieces above that. The
// whole valuation problem is picking the right tier, and the only evidence for
// that is what the piece looks like.
//
// This has to be judged in the vision call, because the verification pass that
// searches for those tiers is text-only and never sees the photo. So the model
// grades the work here, and the searched tiers are matched against that grade
// there. "not_applicable" for anything that isn't an original.
export const CRAFT_LEVEL = [
  "not_applicable",
  "basic",
  "competent",
  "accomplished",
  "professional",
] as const;

// Marketplaces the app knows the fees of. MUST match the platform names in
// mobile/pricing.ts exactly — the client highlights the row by name. Each scan
// names which of these the seller uses (see handler.ts); the model recommends
// from those, or — when the seller allows it — any other marketplace.
export const PLATFORM_NAMES = [
  "Facebook Marketplace",
  "eBay",
  "Etsy",
  "Poshmark",
  "Mercari",
  "OfferUp",
  "Depop",
  "Vinted",
  "StockX",
  "The RealReal",
  "Reverb",
] as const;

// What a scan that names no marketplaces may recommend: the list 1.0.x builds
// shipped with. They have no row for anything newer, so they must never get it.
export const LEGACY_PLATFORMS: readonly PlatformName[] = [
  "Facebook Marketplace",
  "OfferUp",
  "Vinted",
  "Depop",
  "Mercari",
  "eBay",
  "Poshmark",
];

// How quickly the item is likely to sell on the recommended platform.
export const EXPECTED_SPEED = ["fast", "moderate", "slow"] as const;

export type Category = (typeof CATEGORIES)[number];
export type Condition = (typeof CONDITIONS)[number];
export type Specificity = (typeof SPECIFICITY)[number];
export type PlatformName = (typeof PLATFORM_NAMES)[number];
export type ExpectedSpeed = (typeof EXPECTED_SPEED)[number];
export type ValuationBasis = (typeof VALUATION_BASIS)[number];
export type PriceConfidence = (typeof PRICE_CONFIDENCE)[number];
export type PriceBasis = (typeof PRICE_BASIS)[number];
export type CraftLevel = (typeof CRAFT_LEVEL)[number];

export interface AnalyzeResult {
  title: string;
  /** The language the item's own text was translated from to write the title,
   *  in English ("Japanese"). "" when nothing needed translating. */
  translatedFrom: string;
  category: Category;
  /** Brand name, or "" when not confidently identifiable. */
  brand: string;
  condition: Condition;
  keywords: string[];
  searchQuery: string;
  /** Declared BEFORE the price so the model commits to how well it knows the
   *  item before it commits to a number. */
  specificity: Specificity;
  /** Also before the price: "resale" discounts from retail, "original" does not. */
  valuationBasis: ValuationBasis;
  /** Also before the price: the model's own read on whether it's guessing. */
  priceConfidence: PriceConfidence;
  /** Execution quality of an original, judged from the photo. Picks the market
   *  tier the piece belongs in. "not_applicable" for resale items. */
  craftLevel: CraftLevel;
  estimatedValueUSD: { low: number; high: number };
  /** Ready-to-post marketplace description, generated in the same vision call. */
  listingDescription: string;
  /** Best marketplace for THIS item to actually sell (model's judgment). One of
   *  the seller's marketplaces, or another site when they allow it. */
  recommendedPlatform: string;
  /** One-sentence, item-specific reason for the recommendation. */
  recommendationReason: string;
  /** The seller's marketplaces worth listing THIS item on, best first, the
   *  recommendation always leading. At most 7. The app's Where to sell shows
   *  exactly these. */
  relevantPlatforms: string[];
  /** Rough how-fast-it-sells signal on the recommended platform. */
  expectedSpeed: ExpectedSpeed;

  // --- Server-set, NOT model-set. Deliberately absent from ANALYZE_SCHEMA
  // (which is additionalProperties:false) and filled in by the handler after
  // the optional verification pass. Older app builds ignore unknown keys, so
  // adding them here is safe for 1.0.0-1.0.2 installs already in the wild.
  /** "verified" only when a web-search pass actually refined the range. */
  priceBasis: PriceBasis;
  /** One short line on what the verification found. "" when not verified. */
  priceNote: string;
}

// --- /api/analyze verification pass (lib/verify.ts) -----------------------

// The second, optional, TEXT-ONLY call. It never re-sends the photo — the item
// is already identified, so the input is ~40 tokens of text instead of ~1,050
// tokens of image processed a second time. That's most of what keeps this cheap.
export interface VerifiedPrice {
  low: number;
  high: number;
  /** Short, user-facing provenance line, e.g. "Based on Etsy listings". */
  note: string;
  /** "enough" is shown as verified; "a_few" moves the price without the tick. */
  strength: "enough" | "a_few";
}

/**
 * What the verification pass actually did — not just what it produced.
 *
 * `price` being null is not one situation, it is two, and they owe the seller
 * different things. A search that ran and came back with nothing usable is
 * worth a line under the price, because it explains the extra ten seconds they
 * just waited. A search that never ran — timed out, threw, paused, or was never
 * issued — explains nothing, and saying "couldn't find listings" there is the
 * app claiming an outcome it never reached.
 */
export interface VerifyOutcome {
  /** The refined range, or null when nothing usable came back. */
  price: VerifiedPrice | null;
  /** True only when a search ran AND returned a verdict we could read. */
  searched: boolean;
  /** What the call cost, tokens plus the search. Unset if it never returned. */
  costUSD?: number;
}

export const VERIFY_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    // Reasoning first: what the search actually turned up, in prose, before any
    // number is generated. Same ordering principle as specificity above.
    findings: { type: "string" },
    // Right after findings, so it is judged from what the search showed.
    match: { type: "string", enum: [...LISTING_MATCH] },
    // "none" tells us to DISCARD the result and keep the model's own estimate —
    // a bad comp is worse than an honest guess.
    evidence: { type: "string", enum: [...VERIFY_EVIDENCE] },
    rangeUSD: {
      type: "object",
      additionalProperties: false,
      properties: {
        low: { type: "number" },
        high: { type: "number" },
      },
      required: ["low", "high"],
    },
    note: { type: "string" },
    // The one marketplace most of the prices came from, or "". The app words
    // the "a few listings" note itself, so this is a name, not a sentence.
    source: { type: "string" },
  },
  required: ["findings", "match", "evidence", "rangeUSD", "note", "source"],
} as const;

// JSON Schema passed to the model. Structured outputs require
// additionalProperties:false and all keys listed in `required`.
// Key ORDER matters: the model generates fields in declaration order, so
// `specificity` sits above `estimatedValueUSD` — it admits how well it knows
// the item before every price token is generated.
// (No min/max or string-length constraints — unsupported by structured outputs.)
export const ANALYZE_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    title: { type: "string" },
    translatedFrom: { type: "string" },
    category: { type: "string", enum: [...CATEGORIES] },
    brand: { type: "string" },
    condition: { type: "string", enum: [...CONDITIONS] },
    keywords: { type: "array", items: { type: "string" } },
    searchQuery: { type: "string" },
    specificity: { type: "string", enum: [...SPECIFICITY] },
    valuationBasis: { type: "string", enum: [...VALUATION_BASIS] },
    priceConfidence: { type: "string", enum: [...PRICE_CONFIDENCE] },
    craftLevel: { type: "string", enum: [...CRAFT_LEVEL] },
    estimatedValueUSD: {
      type: "object",
      additionalProperties: false,
      properties: {
        low: { type: "number" },
        high: { type: "number" },
      },
      required: ["low", "high"],
    },
    listingDescription: { type: "string" },
    // Not an enum: "or any other marketplace" can't be one. The server checks
    // it against the seller's list instead (analyze.ts, pickPlatform).
    recommendedPlatform: { type: "string" },
    recommendationReason: { type: "string" },
    relevantPlatforms: { type: "array", items: { type: "string" } },
    expectedSpeed: { type: "string", enum: [...EXPECTED_SPEED] },
  },
  required: [
    "title",
    "translatedFrom",
    "category",
    "brand",
    "condition",
    "keywords",
    "searchQuery",
    "specificity",
    "valuationBasis",
    "priceConfidence",
    "craftLevel",
    "estimatedValueUSD",
    "listingDescription",
    "recommendedPlatform",
    "recommendationReason",
    "relevantPlatforms",
    "expectedSpeed",
  ],
} as const;

const ALLOWED_MEDIA_TYPES = [
  "image/jpeg",
  "image/png",
  "image/webp",
  "image/gif",
] as const;

export type MediaType = (typeof ALLOWED_MEDIA_TYPES)[number];

export function isValidMediaType(value: string): value is MediaType {
  return (ALLOWED_MEDIA_TYPES as readonly string[]).includes(value);
}

// --- /api/price contract -------------------------------------------------

export interface PriceResult {
  low: number;
  median: number;
  high: number;
}

export interface PriceRequest {
  fallbackEstimate: { low: number; high: number };
}
