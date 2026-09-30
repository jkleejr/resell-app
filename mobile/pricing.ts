// Client-side Layer 3 (fee math) + routing.
// Pure logic — no secrets, no network. Mirrors the PRD marketplace constant.

// The model's resale estimate, normalised for display.
export type PriceResult = {
  low: number;
  median: number;
  high: number;
};

// Whole dollars, low <= high, with a midpoint to anchor the fee comparison.
export function toPrice(estimate: { low: number; high: number }): PriceResult {
  const low = Number.isFinite(estimate.low) ? Math.max(0, Math.round(estimate.low)) : 0;
  let high = Number.isFinite(estimate.high) ? Math.round(estimate.high) : 0;
  if (high < low) high = low;

  return { low, median: Math.round((low + high) / 2), high };
}

type Shipping = "local" | "prepaid";

type Platform = {
  name: string;
  feePct: number;
  flatFee: number;
  /** The least the marketplace takes on a sale, if it has a floor. */
  minFee?: number;
  shipping: Shipping;
};

// Hard-coded public fee structures (2026). Revisit occasionally. The order is
// the order Settings lists them in. Names MUST match PLATFORM_NAMES in
// lib/schema.ts — the backend holds the model's pick to these spellings.
//
// Etsy (US): $0.20 listing + 6.5% transaction + 3% + $0.25 payment processing.
// StockX: 9% transaction at seller level 1 + 3% processing, $5 minimum.
const PLATFORMS: Platform[] = [
  { name: "Facebook Marketplace", feePct: 0.0, flatFee: 0, shipping: "local" },
  { name: "OfferUp", feePct: 0.0, flatFee: 0, shipping: "local" },
  { name: "Vinted", feePct: 0.0, flatFee: 0, shipping: "prepaid" },
  { name: "Depop", feePct: 0.0, flatFee: 0, shipping: "prepaid" },
  { name: "Mercari", feePct: 0.1, flatFee: 0, shipping: "prepaid" },
  { name: "eBay", feePct: 0.13, flatFee: 0.35, shipping: "prepaid" },
  { name: "Poshmark", feePct: 0.2, flatFee: 0, shipping: "prepaid" },
  { name: "Etsy", feePct: 0.095, flatFee: 0.45, shipping: "prepaid" },
  { name: "StockX", feePct: 0.12, flatFee: 0, minFee: 5, shipping: "prepaid" },
];

/** Every marketplace the app knows the fees of, in display order. */
export const MARKETPLACE_NAMES: string[] = PLATFORMS.map((p) => p.name);

const SHIPPING_LABEL: Record<Shipping, string> = {
  local: "Local",
  prepaid: "Ship",
};

export type ComparisonRow = {
  name: string;
  net: number;
  feeNote: string;
  /** No known fee to take off: nothing is shown in red. */
  feeFree: boolean;
  /** Empty for a marketplace the app has no details for. */
  shipping: string;
  recommended: boolean;
};

// net = anchor - max(anchor * feePct + flatFee, minFee), floored at 0.
function netPayout(anchor: number, p: Platform): number {
  const fee = Math.max(anchor * p.feePct + p.flatFee, p.minFee ?? 0);
  return Math.max(0, Math.round(anchor - fee));
}

// "9.5% + $0.45", "12% (min $5)", "No seller fee".
function feeNote(p: Platform): string {
  if (p.feePct === 0 && p.flatFee === 0) return "No seller fee";
  const pct = `${Number((p.feePct * 100).toFixed(1))}%`;
  const flat = p.flatFee ? ` + $${p.flatFee.toFixed(2)}` : "";
  const min = p.minFee ? ` (min $${p.minFee})` : "";
  return pct + flat + min;
}

/** The fee and shipping line for a marketplace, as Settings shows it. */
export function marketplaceDetails(
  name: string,
): { feeNote: string; feeFree: boolean; shipping: string } | null {
  const p = PLATFORMS.find((x) => x.name === name);
  return p
    ? {
        feeNote: feeNote(p),
        feeFree: p.feePct === 0 && p.flatFee === 0,
        shipping: SHIPPING_LABEL[p.shipping],
      }
    : null;
}

// How quickly the item is likely to sell on the recommended platform.
export function speedLabel(speed: "fast" | "moderate" | "slow"): string {
  switch (speed) {
    case "fast":
      return "Likely to sell fast.";
    case "moderate":
      return "Usually sells within a couple of weeks.";
    case "slow":
      return "May take a month or more.";
  }
}

// Build the Where to sell table for one item.
//
// With `relevant` — the marketplaces the backend judged worth listing THIS item
// on, best first — the table is exactly those, in that order, less any the
// seller has since turned off. The recommended one always stays: it leads the
// list, and a past scan may recommend one they no longer use.
//
// Without it (an older backend, or a scan saved before it existed), every
// marketplace the seller uses is listed, recommended first, then by payout.
//
// A marketplace the app has no fee table for (an "other" site) gets a row that
// says so, with the full price in place of a payout.
export function buildComparison(
  anchor: number,
  recommendedName: string,
  enabled: readonly string[],
  relevant?: readonly string[],
): ComparisonRow[] {
  const row = (name: string): ComparisonRow => {
    const p = PLATFORMS.find((x) => x.name === name);
    return p
      ? {
          name,
          net: netPayout(anchor, p),
          feeNote: feeNote(p),
          feeFree: p.feePct === 0 && p.flatFee === 0,
          shipping: SHIPPING_LABEL[p.shipping],
          recommended: name === recommendedName,
        }
      : {
          name,
          net: Math.max(0, Math.round(anchor)),
          feeNote: "Fees vary",
          feeFree: true,
          shipping: "",
          recommended: name === recommendedName,
        };
  };
  // Listed marketplaces are shown only while turned on; "other" sites only
  // ever reach the list when the seller allowed them.
  const shown = (name: string) =>
    name === recommendedName ||
    enabled.includes(name) ||
    !PLATFORMS.some((p) => p.name === name);

  if (relevant && relevant.length > 0) {
    const names = [recommendedName, ...relevant].filter(
      (n, i, all) => n && all.indexOf(n) === i && shown(n),
    );
    return names.map(row);
  }

  const names = PLATFORMS.map((p) => p.name).filter(shown);
  if (recommendedName && !names.includes(recommendedName)) {
    names.push(recommendedName);
  }
  return names.map(row).sort((a, b) => {
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
  Etsy: "https://www.etsy.com/your/shops/me/listing-editor/create",
  StockX: "https://stockx.com/sell",
};

export function marketplaceUrl(name: string): string {
  return (
    MARKETPLACE_URLS[name] ??
    `https://www.google.com/search?q=${encodeURIComponent(`sell on ${name}`)}`
  );
}
