import type { PriceResult } from "./schema.js";

// The displayed price is the vision model's own resale estimate, normalised.
//
// This was once a three-rung ladder: eBay sold comps on the specific query, then
// on a broadened one, then the model's estimate as a fallback. The comps
// provider was never wired up — no RAPIDAPI_KEY was ever set, so the lookup
// returned null before making a request and every scan the app has ever served
// came from the fallback rung. Rather than keep dead code and a "no sales data"
// label describing a lookup that never happened, the ladder is gone and the
// estimate is simply the price. Git history has the comps implementation if it's
// ever worth revisiting.
export function priceItem(estimate: { low: number; high: number }): PriceResult {
  const low = Number.isFinite(estimate.low) ? Math.max(0, Math.round(estimate.low)) : 0;
  let high = Number.isFinite(estimate.high) ? Math.round(estimate.high) : 0;
  if (high < low) high = low;

  return { low, median: Math.round((low + high) / 2), high };
}
