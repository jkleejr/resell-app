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

// Marketplaces the model may recommend. MUST match the platform names in
// mobile/pricing.ts exactly — the client highlights the row by name.
export const PLATFORM_NAMES = [
  "Facebook Marketplace",
  "OfferUp",
  "Vinted",
  "Depop",
  "Mercari",
  "eBay",
  "Poshmark",
] as const;

// How quickly the item is likely to sell on the recommended platform.
export const EXPECTED_SPEED = ["fast", "moderate", "slow"] as const;

export type Category = (typeof CATEGORIES)[number];
export type Condition = (typeof CONDITIONS)[number];
export type Specificity = (typeof SPECIFICITY)[number];
export type PlatformName = (typeof PLATFORM_NAMES)[number];
export type ExpectedSpeed = (typeof EXPECTED_SPEED)[number];

export interface AnalyzeResult {
  title: string;
  category: Category;
  /** Brand name, or "" when not confidently identifiable. */
  brand: string;
  condition: Condition;
  keywords: string[];
  searchQuery: string;
  estimatedValueUSD: { low: number; high: number };
  specificity: Specificity;
  /** Ready-to-post marketplace description, generated in the same vision call. */
  listingDescription: string;
  /** Best marketplace for THIS item to actually sell (model's judgment). */
  recommendedPlatform: PlatformName;
  /** One-sentence, item-specific reason for the recommendation. */
  recommendationReason: string;
  /** Rough how-fast-it-sells signal on the recommended platform. */
  expectedSpeed: ExpectedSpeed;
}

// JSON Schema passed to the model. Structured outputs require
// additionalProperties:false and all keys listed in `required`.
// (No min/max or string-length constraints — unsupported by structured outputs.)
export const ANALYZE_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    title: { type: "string" },
    category: { type: "string", enum: [...CATEGORIES] },
    brand: { type: "string" },
    condition: { type: "string", enum: [...CONDITIONS] },
    keywords: { type: "array", items: { type: "string" } },
    searchQuery: { type: "string" },
    estimatedValueUSD: {
      type: "object",
      additionalProperties: false,
      properties: {
        low: { type: "number" },
        high: { type: "number" },
      },
      required: ["low", "high"],
    },
    specificity: { type: "string", enum: [...SPECIFICITY] },
    listingDescription: { type: "string" },
    recommendedPlatform: { type: "string", enum: [...PLATFORM_NAMES] },
    recommendationReason: { type: "string" },
    expectedSpeed: { type: "string", enum: [...EXPECTED_SPEED] },
  },
  required: [
    "title",
    "category",
    "brand",
    "condition",
    "keywords",
    "searchQuery",
    "estimatedValueUSD",
    "specificity",
    "listingDescription",
    "recommendedPlatform",
    "recommendationReason",
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

// Which rung of the pricing ladder produced the number (provenance).
// exact      = sold comps on the specific query (sampleSize >= 5)
// comparable = sold comps on a broadened query
// estimate   = vision model's own estimate, no sales data found
export const PRICE_CONFIDENCE = ["exact", "comparable", "estimate"] as const;
export type PriceConfidence = (typeof PRICE_CONFIDENCE)[number];

export interface PriceResult {
  low: number;
  median: number;
  high: number;
  sampleSize: number;
  confidence: PriceConfidence;
  /** "sold_comps" when backed by real data, "model_estimate" on the fallback rung. */
  source: "sold_comps" | "model_estimate";
}

export interface PriceRequest {
  searchQuery: string;
  fallbackEstimate: { low: number; high: number };
}
