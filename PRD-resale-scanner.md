# PRD — Resale Scanner (working title: *Flip*)

> Hand-off doc for Claude Code. Build one milestone at a time, in order. Do not scaffold later milestones early. The contracts in this doc are the source of truth — keep all code consistent with them.

## One-liner

Take a photo of something you want to sell. The app identifies it — even if you don't know what it is — tells you what it's worth, shows where to sell it and what you'd actually pocket at each platform, and hands you copy-paste listing text.

---

## Problem

Selling used stuff has three frictions: you don't always know *what the item is*, you don't know what it's *worth*, and you don't know which marketplace *nets you the most money fastest*. This app collapses photo → "what it is, what it's worth, where to sell it" into a few seconds.

## Who it's for

Built first for the developer's own reselling; shipped to App Store and Google Play for anyone clearing out furniture, electronics, clothes, and household goods.

---

## Goals (v1)

- Photo → identified item → fair price → marketplace comparison (where to sell + what you net) → copy-paste listing text, in one flow.
- One codebase, both stores (iOS + Android).
- Cheap to run, safe to ship publicly (no exposed keys, no unbounded cost).

## Non-goals (v1 — explicitly out of scope; keep these firm)

- **No auto-posting to marketplaces.** Most marketplaces (Facebook Marketplace, OfferUp, Craigslist) have no public listing API. v1 hands off via deep link + copied text. Do not automate listing.
- **No multi-marketplace price API — because none exists.** Only eBay exposes real *sold* prices via API. Tools that look like multi-platform price sources (Vendoo, Nifty, List Perfectly, Crosslist) are *crosslisters* — they log in as the user and automate the UI; they are NOT price data sources. Do NOT go hunting for an API that returns sold prices across Poshmark/Mercari/Facebook/etc. It does not exist. Cross-platform price signal comes ONLY from the indexed-listing search described below, and it is *asking* prices, not sold.
- **No user accounts or login.** v1 is single-user and local. No auth, no user database.
- **No payments, shipping, or in-app transactions.** The app routes the user out to a marketplace; it never handles money or fulfillment.
- **No in-app paywall yet.** Ship with a backend usage cap (see Cost). Monetization is a fast-follow.

v1 exists to validate that the core scan feels good. Nothing else.

---

## The core loop

1. **Capture** — user takes/picks a photo of one item.
2. **Identify** — vision model returns a name, category, condition, search query, value estimate, and a confidence flag (`specificity`). If it can't name the item, the pricing ladder broadens automatically; deep identification of obscure items via reverse image search is M5.
3. **Price** — pricing fallback ladder produces a fair-value anchor with a confidence label (see Price model).
4. **Compare & route** — show a marketplace comparison: per-platform net payout (fee math on the anchor) + recommended platform with a reason. Cross-platform current-listing prices (asking) are added in M5. Generate copy-paste listing text + deep link.

---

## Price model — three layers (read this carefully; it's the heart of the app)

The single most important distinction in this project: **sold prices vs. asking prices.**
- **Sold prices** = what buyers actually paid. The gold standard for "fair value." Only eBay exposes these via API.
- **Asking prices** = what sellers hope to get. Weak basis for fair value (unsold listings tell you nothing), but useful as breadth signal ("what's listed across platforms right now").

The app keeps these in separate layers and never blends them into one fake number:

### Layer 1 — Fair-value anchor (v1, M3)

> **Superseded (Aug 2026).** The sold-comps ladder below was built but never
> switched on: no `RAPIDAPI_KEY` was ever configured, so the comps lookup
> returned `null` before issuing a request and 100% of scans landed on the
> ESTIMATE rung. Rather than ship a "no sales data found" caption describing a
> lookup that never happened, the ladder and its provenance labels were removed —
> the model's `estimatedValueUSD` *is* the price now, presented plainly as an
> estimate. The rest of this section is kept as the design record for whoever
> revisits real comps; the implementation is in git history.

eBay sold comps. The one trustworthy "what it's worth" number. Produced by the **pricing fallback ladder**:

```
1. Vision model returns {searchQuery, specificity, estimatedValueUSD}.

2. Query sold comps with the specific searchQuery.
   ├─ sampleSize >= 5  -> EXACT  (tight range, high confidence)
   └─ too few results  -> step 3

3. Broaden: strip brand/model, keep item type + key traits. Re-query.
   ├─ results found  -> COMPARABLE  (wider range, medium confidence)
   └─ still nothing  -> step 4

4. Fall back to estimatedValueUSD  -> ESTIMATE  (widest, low confidence)
```

The result MUST be labeled by which rung produced it (provenance). Same number slot, honest confidence:
- EXACT → "Based on N sold listings of this exact item"
- COMPARABLE → "Based on similar items (no exact match found)"
- ESTIMATE → "Rough estimate — no sales data found"

Without the label, a wide comparable range looks like a precise quote and erodes trust the first time it's wrong.

### Layer 2 — Cross-platform breadth (v2, M5)
ONE image-search call (SerpAPI Google Lens, fed the photo) returns current listings across whatever platforms Google has indexed (Mercari, Poshmark, eBay, Grailed...), with prices + source sites. Labeled clearly as **asking prices, current listings** — fuzzy, skewed toward retail/new. This is the honest version of "search the other platforms." It is NOT the fair-value number.

This same Lens call does double duty as the M5 identification rung (see Identification ladder). One integration, two jobs.

### Layer 3 — Per-platform net (v1, M3)
Fee math on the anchor. Stable public fee structures, hard-coded. `net = anchor * (1 - feePct) - flatFee`. This is what turns one price into "what you'd actually pocket on each platform" — which is the question a seller actually has.

---

## Identification ladder (ID the item even when the user doesn't know it)

Escalation ladder, cheapest rung first. A *text* search can't do this — identifying from a photo needs an *image* search primitive.

1. **Vision model guess (v1, M1).** Returns name + `specificity: "exact" | "generic"`. For logo'd or distinctive items this often nails it.
2. **Reverse image search (v2, M5).** Triggered only when rung 1 is `generic`. SerpAPI Google Lens (or eBay Browse Search-by-Image) returns visually-matching products with titles. (Same Lens call also feeds Layer 2 breadth pricing.)
3. **Model confirms (v2, M5).** Photo + candidate titles → model picks best match and why.

v1 ships rung 1 only. Do NOT integrate image search before M1 returns JSON.

---

## Key decisions (already made — don't relitigate)

**Framework: Expo / React Native.** One codebase ships to both stores. No iOS-only dependency in this app, so native Swift would mean building twice for zero benefit. Apple Developer account is required regardless — it's the store membership, not a framework.

**Architecture: thin backend on Vercel.** The app must never hold API keys (extractable from shipped bundles; stranger usage would bill the dev's accounts unboundedly). All paid calls (vision, pricing, image search) go through Vercel functions that hold the secrets. The app only talks to our own endpoints.

**Pricing data: third-party sold-comps API.** eBay closed official sold-listings access to independent devs (Finding API rate-limits even first calls; Marketplace Insights is partner-only). v1 uses a third-party sold-comps endpoint (e.g. a RapidAPI `ebay-average-selling-price` actor), with the model's estimate as fallback. Imperfect and accepted — there is no clean official source.

---

## Architecture

```
[Expo app]
   |  photo (downscaled, base64)
   v
[Vercel: POST /api/analyze]  --> vision model --> {title, category, condition, keywords, searchQuery, specificity, estimatedValueUSD}
   |
   |  (M5) if specificity == "generic": POST /api/identify --> Lens image search --> candidate names + cross-platform asking prices --> model confirms
   |
   |  searchQuery
   v
[Vercel: POST /api/price]    --> sold-comps API (with broaden-and-retry ladder) --> {low, median, high, sampleSize, confidence}
   |
   v
[Expo app: result screen]
   --> Layer 3: marketplace comparison (client-side fee math on anchor) + recommended platform + reason
   --> (M5) Layer 2: cross-platform current listings (asking prices) from Lens
   --> listing text + deep link
```

Routing + comparison table + provenance labeling run **client-side** — pure logic, no secrets, no AI, no network.

---

## Tech stack

- **Client:** Expo (React Native), TypeScript. `expo-camera` / `expo-image-picker` capture, `expo-image-manipulator` downscaling.
- **Backend:** Vercel serverless functions, TypeScript.
- **Vision:** Anthropic API (`claude-sonnet-4-6`), image + structured-JSON prompt.
- **Pricing:** third-party sold-comps API (pick provider at M3).
- **Image search (M5):** SerpAPI Google Lens (preferred — does ID + cross-platform pricing in one call) or eBay Browse Search-by-Image.
- **Env:** secrets in Vercel env vars only. Never in the app.

---

## Data contracts

### `POST /api/analyze`
Request: `{ "image": "<base64 jpeg, no data: prefix>", "mediaType": "image/jpeg" }`
Response:
```json
{
  "title": "West Elm Mid-Century Dining Chair, Walnut",
  "category": "furniture",
  "brand": "West Elm",
  "condition": "good",
  "keywords": ["mid century", "dining chair", "walnut", "west elm"],
  "searchQuery": "West Elm mid century dining chair walnut",
  "specificity": "exact",
  "estimatedValueUSD": { "low": 60, "high": 120 }
}
```
`category` ∈ `furniture, electronics, clothing, shoes, collectible, kitchenware, home_decor, tool, sporting_goods, toy, book_media, other`.
`condition` ∈ `new, like_new, good, fair, poor`. `specificity` ∈ `exact, generic`.

### `POST /api/price`
Request: `{ "searchQuery": "...", "fallbackEstimate": { "low": 60, "high": 120 } }`
Implements the broaden-and-retry ladder. Response:
```json
{ "low": 45, "median": 85, "high": 130, "sampleSize": 24, "confidence": "exact", "source": "sold_comps" }
```
`confidence` ∈ `exact` (sampleSize ≥ 5 on specific query) | `comparable` (broadened query) | `estimate` (model fallback, no sales data). The client renders the matching provenance label.

### `POST /api/identify` (M5)
Request: `{ "image": "<base64>", "mediaType": "image/jpeg" }`
Response:
```json
{
  "candidates": [{ "name": "...", "sourceUrl": "...", "askingPriceUSD": 95 }],
  "best": "West Elm Mid-Century Dining Chair, Walnut",
  "specificity": "exact"
}
```
Client replaces `title`/`searchQuery` with `best` when found; `candidates[].askingPriceUSD` feeds the Layer 2 cross-platform breadth display (labeled asking prices).

### Marketplace comparison constant (client-side, Layer 3)
```ts
// Hard-coded public fee structures (2026). anchor = median (or estimate). Revisit occasionally.
// net = anchor * (1 - feePct) - flatFee
const PLATFORMS = [
  { name: "Facebook Marketplace", feePct: 0.00, flatFee: 0, shipping: "local",   speed: "fast_local" }, // 0% local, 5% if shipped
  { name: "OfferUp",              feePct: 0.00, flatFee: 0, shipping: "local",   speed: "fast_local" }, // fee only if shipped
  { name: "Vinted",               feePct: 0.00, flatFee: 0, shipping: "prepaid", speed: "days" },       // 0% seller fee
  { name: "Depop",                feePct: 0.00, flatFee: 0, shipping: "prepaid", speed: "days" },       // 0% US/UK, ~3.3% processing
  { name: "Mercari",              feePct: 0.10, flatFee: 0, shipping: "you_ship", speed: "days" },      // ~10%
  { name: "eBay",                 feePct: 0.13, flatFee: 0.35, shipping: "you_ship", speed: "days_weeks" }, // ~13% + insertion
  { name: "Poshmark",             feePct: 0.20, flatFee: 0, shipping: "prepaid", speed: "days" },       // 20% (flat $2.95 under $15)
];
```

---

## Routing ruleset (client-side — picks the highlighted row in the comparison)
| Category | Recommended | Reason shown |
|---|---|---|
| furniture, home_decor (bulky) | FB Marketplace / OfferUp | Local pickup, no shipping |
| electronics, collectible, book_media | eBay | Shipping-friendly, model-searched |
| clothing, shoes | Poshmark / Depop / Mercari | Built for fashion resale |
| tool, sporting_goods, kitchenware, toy | FB Marketplace (>$40) / OfferUp | Local, quick turnover |
| other | eBay | Widest buyer base |

If anchor price < ~$20, bias local/free-to-list regardless of category (shipping eats the margin). Recommendation = highlighted row + one-line "why" + deep link.

---

## Milestones (build in order)

### M1 — Backend: `/api/analyze`
Single Vercel function: photo in, structured JSON out (contract above), including `specificity`.
**Done when:** curl-ing three test photos (brand-name, generic, blurry) returns valid JSON with sensible values, and the blurry case degrades gracefully instead of inventing a brand.

### M2 — App core loop
Expo app: camera/picker → downscale → `POST /api/analyze` → result screen showing title, category, condition.
**Done when:** on a real device, a photo returns and renders in a few seconds, reliably, with client-side downscaling keeping requests under Vercel's ~4.5 MB body limit.

### M3 — Pricing ladder + comparison + routing
Add `/api/price` with the broaden-and-retry ladder returning `confidence`. Add the client-side fee-math comparison table (Layer 3) and routing ruleset. Render the provenance label on the price.
**Done when:** the result screen shows a fair-value anchor with an honest confidence label, plus a comparison table of platforms with net payouts/fees/shipping/speed, and the best-fit platform highlighted with a reason.

### M4 — Hand-off + ship
Copy-paste listing text (title + description) with a Copy button. Deep link to the chosen marketplace. Backend free-scan cap. Polish, write store listings, submit to both stores.
**Done when:** the full loop works end to end, the cap is enforced, both submissions are in.

### M5 — Image search: identification + cross-platform breadth (post-launch)
Add `/api/identify` (SerpAPI Lens). One call delivers BOTH: (a) reverse-image identification when M1 returned `generic`, and (b) Layer 2 cross-platform current-listing asking prices for the result screen. Trigger only on the `generic` path.
**Done when:** photographing an item the model couldn't name returns a specific product name often enough to be worth the call, and the result screen shows cross-platform current listings clearly labeled as asking prices.

---

## Cost & safety
- Each scan = 1 vision call + (at most) 1 pricing call; M5 adds 1 Lens call only on the `generic` path. Cheap per scan, unbounded across strangers.
- M4 adds a per-device/day free-scan cap enforced on the backend so a spike can't produce a surprise bill.
- No personal data stored. Photos are sent for analysis, not retained server-side.

---

## Open decisions (defer, don't block on)
- Sold-comps provider → pick at M3 by trying one and checking quality.
- Image-search provider (SerpAPI Lens vs eBay) → pick at M5. Lens preferred (ID + breadth in one call).
- App name + icon → needed by M4.
- Free-scan cap number → set at M4 from observed per-scan cost.

---

## How to build this
Execute one milestone at a time. Do NOT scaffold M2–M5 while building M1. The make-or-break question — does identification feel magic or mushy — is answered entirely by M1 + M2 on real items. The price model's three layers map cleanly to milestones: Layer 1 anchor + Layer 3 fee-math net are M3 (cheap, no new vendors); Layer 2 cross-platform breadth is M5 (one Lens call). Do not try to query each marketplace's sold data independently — that data isn't accessible. Get the curl returning good JSON first; everything else snaps onto the contracts above.
