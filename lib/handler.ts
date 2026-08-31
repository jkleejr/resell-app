import { createHash } from "node:crypto";
import { analyzeImage, type ImageInput } from "./analyze.js";
import { priceItem } from "./price.js";
import { isValidMediaType, type AnalyzeResult } from "./schema.js";
import {
  cacheVerification,
  checkAndRecordScan,
  claimSearchBudget,
  getCachedVerification,
  getTotalScans,
} from "./usage.js";
import { verifyPrice } from "./verify.js";

export interface HandlerResponse {
  status: number;
  body: Record<string, unknown>;
}

// Transport-supplied request context (headers the Vercel function and dev
// server extract and pass in), kept separate from the JSON body.
export interface RequestContext {
  deviceId?: string;
}

// Core request logic, transport-agnostic so the Vercel function and the local
// dev server share exactly one implementation.
// Up to this many photos per scan — bounds payload size and per-scan cost while
// still letting the user add an overall shot plus a logo/label close-up.
const MAX_IMAGES = 4;

export async function handleAnalyzeRequest(
  body: unknown,
  ctx: RequestContext = {},
): Promise<HandlerResponse> {
  const input = (body ?? {}) as Record<string, unknown>;

  // New shape: { images: [{ image, mediaType }], hint }. Legacy single-image
  // shape ({ image, mediaType }) is still accepted for the CLI/curl path.
  const rawList = Array.isArray(input.images)
    ? (input.images as unknown[]).map((it) => {
        const o = (it ?? {}) as Record<string, unknown>;
        return { image: o.image, mediaType: o.mediaType };
      })
    : [{ image: input.image, mediaType: input.mediaType }];

  if (rawList.length === 0) {
    return { status: 400, body: { error: "Provide at least one image" } };
  }
  if (rawList.length > MAX_IMAGES) {
    return { status: 400, body: { error: `Too many images (max ${MAX_IMAGES})` } };
  }

  const images: ImageInput[] = [];
  for (const item of rawList) {
    if (typeof item.image !== "string" || item.image.length === 0) {
      return {
        status: 400,
        body: { error: "Missing 'image' (base64 JPEG string, no data: prefix)" },
      };
    }
    const mediaType =
      typeof item.mediaType === "string" && item.mediaType
        ? item.mediaType
        : "image/jpeg";
    if (!isValidMediaType(mediaType)) {
      return { status: 400, body: { error: `Unsupported mediaType: ${mediaType}` } };
    }
    images.push({ data: item.image, mediaType });
  }

  const hint = typeof input.hint === "string" ? input.hint : undefined;

  if (!process.env.ANTHROPIC_API_KEY) {
    return {
      status: 500,
      body: { error: "Server misconfigured: ANTHROPIC_API_KEY is not set" },
    };
  }

  // Cost guard: per-device daily cap (+ optional global daily cap). Also bumps
  // the all-time scan counter. Fail-open if the KV store isn't configured.
  const gate = await checkAndRecordScan(ctx.deviceId);
  if (!gate.allowed) {
    const error =
      gate.reason === "global"
        ? "We've hit today's scan limit across all users. Please try again tomorrow."
        : `You've reached the daily limit of ${gate.limit} scans. Try again tomorrow.`;
    return { status: 429, body: { error } };
  }

  try {
    const result = await analyzeImage(images, hint);
    const priced = await maybeVerifyPrice(result);
    return { status: 200, body: priced as unknown as Record<string, unknown> };
  } catch (err) {
    console.error("[analyze] failed:", err);
    return { status: 502, body: { error: "Analysis failed" } };
  }
}

// --- Optional price verification -----------------------------------------
//
// Off unless PRICE_VERIFY=on. Everything below is additive: on any miss, skip,
// budget exhaustion, or failure the caller gets exactly the result it would
// have got before this existed.

// Below this the search isn't worth its own cost — a cent and several seconds
// to refine a $30 estimate helps nobody.
const VERIFY_MIN_USD = Number(process.env.VERIFY_MIN_USD ?? 40);

/**
 * Decide whether one web search is worth a cent for this item.
 *
 * The deciding signals come from the MODEL, in the call we already made:
 * `valuationBasis` and `priceConfidence` are both declared before the price, so
 * by the time we get here the model has already told us whether it was working
 * from a market it knows.
 *
 * The important thing is which way this points. The obvious gate — verify the
 * items we identified precisely — is backwards: a confidently identified Levi's
 * 501 is exactly the item whose price the model already knows cold, and paying
 * to look it up buys almost nothing. Search earns its cent where pretrained
 * knowledge is THIN: one-of-a-kind pieces with no market to memorise, and
 * anything the model itself flags as a guess.
 */
function shouldVerify(r: AnalyzeResult): boolean {
  if (process.env.PRICE_VERIFY !== "on") return false;
  if (r.estimatedValueUSD.high < VERIFY_MIN_USD) return false;
  return r.valuationBasis === "original" || r.priceConfidence === "low";
}

// Cache identity: what makes two scans "the same item" for pricing purposes.
// Deliberately excludes the photo — two people photographing the same jacket
// should share one lookup.
function verifyCacheKey(r: AnalyzeResult): string {
  const identity = [
    r.valuationBasis,
    r.brand.toLowerCase(),
    r.title.toLowerCase(),
    r.condition,
  ].join("|");
  return createHash("sha1").update(identity).digest("hex").slice(0, 20);
}

async function maybeVerifyPrice(result: AnalyzeResult): Promise<AnalyzeResult> {
  if (!shouldVerify(result)) return result;

  const key = verifyCacheKey(result);

  // Cache first: a hit costs nothing and makes a repeat scan faster, not just
  // cheaper. Cached ranges skipped the sanity check on the way out, so they've
  // already been vetted once.
  const cached = await getCachedVerification(key);
  if (cached) {
    console.log("[verify] cache hit");
    return applyVerified(result, cached);
  }

  // Only now do we spend. Fails closed: no budget, no search.
  if (!(await claimSearchBudget())) return result;

  const verified = await verifyPrice(result);
  if (!verified) return result;

  await cacheVerification(key, verified);
  return applyVerified(result, verified);
}

function applyVerified(
  result: AnalyzeResult,
  v: { low: number; high: number; note: string },
): AnalyzeResult {
  return {
    ...result,
    estimatedValueUSD: { low: v.low, high: v.high },
    priceBasis: "verified",
    priceNote: v.note,
  };
}

// Loot Check 1.0.0 is live in the App Store and fetches the price over the wire;
// later builds compute it on-device from the analyze result and never call this.
// Kept working for those older installs. `confidence`/`source`/`sampleSize` are
// vestigial — 1.0.0 switches on `confidence` to pick a caption and would render a
// blank line without it — so they stay on the wire until that build is gone.
const LEGACY_PRICE_FIELDS = {
  sampleSize: 0,
  confidence: "estimate",
  source: "model_estimate",
} as const;

export async function handlePriceRequest(
  body: unknown,
): Promise<HandlerResponse> {
  const input = (body ?? {}) as Record<string, unknown>;
  const fallback = (input.fallbackEstimate ?? {}) as Record<string, unknown>;

  const low = typeof fallback.low === "number" ? fallback.low : 0;
  const high = typeof fallback.high === "number" ? fallback.high : 0;

  const result = priceItem({ low, high });
  return { status: 200, body: { ...result, ...LEGACY_PRICE_FIELDS } };
}

// Public stats: the all-time total scans across everyone, for the app's counter.
export async function handleStatsRequest(): Promise<HandlerResponse> {
  const totalScans = await getTotalScans();
  return { status: 200, body: { totalScans } };
}
