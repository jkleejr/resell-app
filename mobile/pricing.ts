// Client-side Layer 3 (fee math) + routing + provenance labels.
// Pure logic — no secrets, no network. Mirrors the PRD marketplace constant.

export type PriceConfidence = "exact" | "comparable" | "estimate";

export type PriceResult = {
  low: number;
  median: number;
  high: number;
  sampleSize: number;
  confidence: PriceConfidence;
  source: "sold_comps" | "model_estimate";
};

type Shipping = "local" | "prepaid" | "you_ship";
type Speed = "fast_local" | "days" | "days_weeks";

type Platform = {
  name: string;
  feePct: number;
  flatFee: number;
  shipping: Shipping;
  speed: Speed;
};

// Hard-coded public fee structures (2026). Revisit occasionally.
const PLATFORMS: Platform[] = [
  { name: "Facebook Marketplace", feePct: 0.0, flatFee: 0, shipping: "local", speed: "fast_local" },
  { name: "OfferUp", feePct: 0.0, flatFee: 0, shipping: "local", speed: "fast_local" },
  { name: "Vinted", feePct: 0.0, flatFee: 0, shipping: "prepaid", speed: "days" },
  { name: "Depop", feePct: 0.0, flatFee: 0, shipping: "prepaid", speed: "days" },
  { name: "Mercari", feePct: 0.1, flatFee: 0, shipping: "you_ship", speed: "days" },
  { name: "eBay", feePct: 0.13, flatFee: 0.35, shipping: "you_ship", speed: "days_weeks" },
  { name: "Poshmark", feePct: 0.2, flatFee: 0, shipping: "prepaid", speed: "days" },
];

const SHIPPING_LABEL: Record<Shipping, string> = {
  local: "Local pickup",
  prepaid: "Prepaid label",
  you_ship: "You ship",
};

const SPEED_LABEL: Record<Speed, string> = {
  fast_local: "Fast · local",
  days: "Days",
  days_weeks: "Days–weeks",
};

export type ComparisonRow = {
  name: string;
  net: number;
  feeNote: string;
  shipping: string;
  speed: string;
  recommended: boolean;
};

// net = anchor * (1 - feePct) - flatFee, floored at 0.
function netPayout(anchor: number, p: Platform): number {
  return Math.max(0, Math.round(anchor * (1 - p.feePct) - p.flatFee));
}

function feeNote(p: Platform): string {
  if (p.feePct === 0 && p.flatFee === 0) return "No seller fee";
  const pct = `${Math.round(p.feePct * 100)}%`;
  return p.flatFee ? `${pct} + $${p.flatFee}` : pct;
}

// How quickly the item is likely to sell on the recommended platform.
export function speedLabel(speed: "fast" | "moderate" | "slow"): string {
  switch (speed) {
    case "fast":
      return "Likely to sell fast — often within days";
    case "moderate":
      return "Usually sells within a couple of weeks";
    case "slow":
      return "May take a month or more — niche demand";
  }
}

// Build the comparison table, highlighting the recommended platform (chosen by
// the model for THIS item), sorted recommended-first then by net payout.
export function buildComparison(
  anchor: number,
  recommendedName: string,
): ComparisonRow[] {
  return PLATFORMS.map((p) => ({
    name: p.name,
    net: netPayout(anchor, p),
    feeNote: feeNote(p),
    shipping: SHIPPING_LABEL[p.shipping],
    speed: SPEED_LABEL[p.speed],
    recommended: p.name === recommendedName,
  })).sort((a, b) => {
    // Recommended first, then by net payout descending.
    if (a.recommended !== b.recommended) return a.recommended ? -1 : 1;
    return b.net - a.net;
  });
}

// Where the "List on …" button sends the user — each marketplace's sell page.
// (v1 hands off via deep link; no auto-posting, per the PRD.)
const MARKETPLACE_URLS: Record<string, string> = {
  "Facebook Marketplace": "https://www.facebook.com/marketplace/create/item",
  OfferUp: "https://offerup.com/post",
  Vinted: "https://www.vinted.com/items/new",
  Depop: "https://www.depop.com/sell/",
  Mercari: "https://www.mercari.com/sell/",
  eBay: "https://www.ebay.com/sl/sell",
  Poshmark: "https://poshmark.com/create-listing",
};

export function marketplaceUrl(name: string): string {
  return (
    MARKETPLACE_URLS[name] ??
    `https://www.google.com/search?q=${encodeURIComponent(`sell on ${name}`)}`
  );
}

// Honest confidence label tied to which ladder rung produced the price.
export function provenanceLabel(price: PriceResult): string {
  switch (price.confidence) {
    case "exact":
      return `Based on ${price.sampleSize} sold listings of this exact item`;
    case "comparable":
      return "Based on similar items (no exact match found)";
    case "estimate":
      return "Rough estimate — not based on sold listings";
  }
}
