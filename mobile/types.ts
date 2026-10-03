// Mirrors the backend /api/analyze contract (lib/schema.ts).
export type AnalyzeResult = {
  title: string;
  /** The language the title was translated from ("Japanese"), or "". Missing
   *  from older backends and from scans saved before it existed. */
  translatedFrom?: string;
  category: string;
  brand: string;
  condition: string;
  keywords: string[];
  searchQuery: string;
  estimatedValueUSD: { low: number; high: number };
  specificity: "exact" | "generic";
  listingDescription: string;
  recommendedPlatform: string;
  recommendationReason: string;
  expectedSpeed: "fast" | "moderate" | "slow";
  // The marketplaces worth listing this item on, best first. Missing from
  // older backends and from scans saved before it existed.
  relevantPlatforms?: string[];
  // Added after 1.0.2 shipped. Optional so a build running against an older
  // backend deploy just falls back to the resale wording.
  valuationBasis?: "resale" | "original";
  priceBasis?: "estimate" | "verified";
  priceNote?: string;
  /** The model's own read on whether it knows this market well. */
  priceConfidence?: "high" | "low";
};
