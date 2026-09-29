// Mirrors the backend /api/analyze contract (lib/schema.ts).
export type AnalyzeResult = {
  title: string;
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
  // Added after 1.0.2 shipped. Optional so a build running against an older
  // backend deploy just falls back to the resale wording.
  valuationBasis?: "resale" | "original";
  priceBasis?: "estimate" | "verified";
  priceNote?: string;
  /** The model's own read on whether it knows this market well. */
  priceConfidence?: "high" | "low";
};
