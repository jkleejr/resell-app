import type { PriceResult } from "./schema.js";

// Raw sold-comps numbers from a data provider, before we label confidence.
interface SoldComps {
  low: number;
  median: number;
  high: number;
  sampleSize: number;
}

// The broaden-and-retry pricing ladder (PRD "Price model — Layer 1"):
//   1. sold comps on the specific query   (>=5 results)  -> exact
//   2. sold comps on a broadened query    (any results)  -> comparable
//   3. the vision model's own estimate    (no data)      -> estimate
// Each rung is labeled by provenance so a wide range never masquerades as a
// precise quote.
export async function priceItem(
  searchQuery: string,
  fallback: { low: number; high: number },
): Promise<PriceResult> {
  const query = searchQuery.trim();

  // Rung 1 — specific query
  if (query) {
    const specific = await fetchSoldComps(query);
    if (specific && specific.sampleSize >= 5) {
      return { ...specific, confidence: "exact", source: "sold_comps" };
    }

    // Rung 2 — broadened query (drop brand/model, keep item type + traits)
    const broad = broadenQuery(query);
    if (broad && broad !== query) {
      const comparable = await fetchSoldComps(broad);
      if (comparable && comparable.sampleSize >= 1) {
        return { ...comparable, confidence: "comparable", source: "sold_comps" };
      }
    }
  }

  // Rung 3 — model estimate fallback
  return estimateFrom(fallback);
}

function estimateFrom(fallback: { low: number; high: number }): PriceResult {
  let low = Number.isFinite(fallback.low) ? Math.max(0, Math.round(fallback.low)) : 0;
  let high = Number.isFinite(fallback.high) ? Math.round(fallback.high) : 0;
  if (high < low) high = low;
  const median = Math.round((low + high) / 2);
  return { low, median, high, sampleSize: 0, confidence: "estimate", source: "model_estimate" };
}

// Strip leading brand/model tokens (heuristically: capitalised words at the
// start) so "West Elm mid century dining chair walnut" broadens to
// "mid century dining chair walnut". Imperfect and accepted (PRD).
function broadenQuery(query: string): string {
  const words = query.split(/\s+/);
  let i = 0;
  while (i < words.length - 2 && /^[A-Z0-9]/.test(words[i] ?? "")) i++;
  return words.slice(i).join(" ");
}

// --- Sold-comps provider -------------------------------------------------
// Returns sold-price comps for a query, or null when unavailable (no provider
// key configured, request failed, or no results). Returning null lets the
// ladder fall through to the next rung — so the app works on the estimate rung
// until RAPIDAPI_KEY is set, then upgrades to real sold data with no code change.
async function fetchSoldComps(query: string): Promise<SoldComps | null> {
  const key = process.env.RAPIDAPI_KEY;
  if (!key) return null;

  try {
    // RapidAPI "ebay-average-selling-price" actor. Field names are parsed
    // defensively in parseComps() — calibrate once tested against a live key.
    const res = await fetch(
      "https://ebay-average-selling-price.p.rapidapi.com/findCompletedItems",
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-rapidapi-key": key,
          "x-rapidapi-host": "ebay-average-selling-price.p.rapidapi.com",
        },
        body: JSON.stringify({
          keywords: query,
          max_search_results: "120",
          remove_outliers: true,
          site_id: "0",
        }),
        signal: AbortSignal.timeout(8000),
      },
    );
    if (!res.ok) {
      console.error(`[price] sold-comps provider returned ${res.status}`);
      return null;
    }
    return parseComps(await res.json());
  } catch (err) {
    console.error("[price] sold-comps request failed:", err);
    return null;
  }
}

// Defensive parse — accepts the common field-name variants the actor returns.
function parseComps(raw: unknown): SoldComps | null {
  const r = (raw ?? {}) as Record<string, unknown>;

  const sampleSize = num(r.results ?? r.total_results ?? r.count);
  if (!sampleSize || sampleSize < 1) return null;

  const median = num(r.median_price ?? r.average_price ?? r.avg_price);
  const low = num(r.min_price ?? r.minimum_price) || median;
  const high = num(r.max_price ?? r.maximum_price) || median;
  if (!median) return null;

  return {
    low: Math.round(low),
    median: Math.round(median),
    high: Math.round(high),
    sampleSize: Math.round(sampleSize),
  };
}

function num(value: unknown): number {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string") {
    const n = Number.parseFloat(value.replace(/[^0-9.]/g, ""));
    return Number.isFinite(n) ? n : 0;
  }
  return 0;
}
