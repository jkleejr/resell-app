import {
  analyzeImage,
  isTimeout,
  type AnalyzeTrace,
  type ImageInput,
} from "./analyze.js";
import { priceItem } from "./price.js";
import {
  itemFacts,
  recordScan,
  SCAN_ATTEMPTS,
  type ScanAttempt,
  type ScanEvent,
  type VerifyStatus,
} from "./scanlog.js";
import { isValidMediaType, type AnalyzeResult } from "./schema.js";
import {
  checkAndRecordScan,
  claimSearchBudget,
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
  // Start the clock before any work, so the deadline handed to verification
  // reflects everything this request has already spent.
  const startedAt = Date.now();
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
  // Only a known label is kept; anything else is dropped rather than logged,
  // so this field can never carry free text into the scan log.
  const attempt = SCAN_ATTEMPTS.find((a) => a === input.attempt) as
    | ScanAttempt
    | undefined;

  if (!process.env.ANTHROPIC_API_KEY) {
    return {
      status: 500,
      body: { error: "Server misconfigured: ANTHROPIC_API_KEY is not set" },
    };
  }

  // Cost guard: per-device daily cap (+ optional global daily cap). Also bumps
  // the all-time scan counter. Fail-open if the KV store isn't configured.
  const gate = await checkAndRecordScan(ctx.deviceId);

  // From here on this is a scan, and however it ends it leaves one anonymous
  // record behind (lib/scanlog.ts). Requests rejected above were never scans.
  // Note what is NOT carried forward: the device id, the photos, the hint text.
  const logScan = (event: Omit<ScanEvent, "ts" | "totalMs" | "photos" | "hint">) =>
    recordScan({
      ...event,
      totalMs: Date.now() - startedAt,
      photos: images.length,
      hint: Boolean(hint?.trim()),
      scanOfDay: gate.scanOfDay,
      attempt,
    });

  if (!gate.allowed) {
    await logScan({ outcome: "capped" });
    const error =
      gate.reason === "global"
        ? "We've hit today's scan limit across all users. Please try again tomorrow."
        : `You've reached the daily limit of ${gate.limit} scans. Try again tomorrow.`;
    return { status: 429, body: { error } };
  }

  const trace: AnalyzeTrace = {};
  const visionStartedAt = Date.now();
  try {
    // The vision pass (retry included) must finish inside the same deadline
    // verification works to, leaving the margin for writing the response.
    const result = await analyzeImage(
      images,
      hint,
      startedAt + FUNCTION_BUDGET_MS - RESPONSE_MARGIN_MS,
      trace,
    );
    const visionMs = Date.now() - visionStartedAt;
    const checked = await maybeVerifyPrice(result, ctx.deviceId, startedAt);
    const priced = checked.result;
    const verified = priced.priceBasis === "verified";
    await logScan({
      outcome: "ok",
      visionMs,
      ...trace,
      // Four decimals is a hundredth of a cent — and keeps float noise out.
      costUSD: roundTo4((trace.costUSD ?? 0) + (checked.costUSD ?? 0)),
      // The model's OWN estimate, from before verification could replace it, so
      // the log can show how far a search moved the price.
      ...itemFacts(result),
      verify: checked.status,
      verifyMs: checked.ms,
      verifiedLow: verified ? priced.estimatedValueUSD.low : undefined,
      verifiedHigh: verified ? priced.estimatedValueUSD.high : undefined,
    });
    return { status: 200, body: priced as unknown as Record<string, unknown> };
  } catch (err) {
    console.error("[analyze] failed:", err);
    await logScan({
      outcome: isTimeout(err) ? "timeout" : "error",
      visionMs: Date.now() - visionStartedAt,
      ...trace,
    });
    // A timeout is worth its own message. "Analysis failed" reads like the
    // photo was the problem and invites the user to take a better one; running
    // out of time says nothing about their photo, and trying again is the right
    // move rather than a wasted one.
    if (isTimeout(err)) {
      return {
        status: 504,
        body: { error: "That took longer than expected. Please try again." },
      };
    }
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

// The request's own deadline: the longest anyone waits for a scan. Everything
// works to it rather than to fixed budgets — the vision pass (and its one
// retry, see analyzeImage) spends what it needs, and verification gets only
// what is left.
//
// Vercel kills the function at 60s (vercel.json maxDuration), deliberately
// well past this. A killed function returns a platform 504 with an HTML body —
// no JSON, no message the app can show — so the platform limit is only a
// backstop for time spent before this clock starts (cold start, receiving
// four photos), never the thing that ends a scan.
//
// 45s is set by the slow path: a stalled first vision attempt (20s) plus a
// retry that gets the ~22s left. A normal scan is ~6s, or ~20s with the price
// check, so nobody waits this long unless the API was stuck.
const FUNCTION_BUDGET_MS = 45_000;

// Held back so the result can be serialised and written after verification
// returns. Small, but it is the difference between a complete response and no
// response at all.
const RESPONSE_MARGIN_MS = 3_000;

// Below this there is no point starting: a search plus both inference passes
// takes 8-15s, so anything less is an allowance spent on a call that cannot
// finish. Skipping costs the user nothing — they get the estimate, which is
// what a timeout would have given them anyway, just sooner.
const MIN_VERIFY_MS = 8_000;

/**
 * Decide whether one web search is worth a cent for this item.
 *
 * Originals only — and the reason is about what the web can actually tell us,
 * not about how confident the model feels.
 *
 * A live run made this concrete. Searching a used pair of Levi's returned only
 * active listings and no sold data, and the model correctly refused to price
 * from them: a used item has a real going rate, and asking prices sit above it,
 * so a marketplace full of hopeful listings would have overstated exactly the
 * number the seller came for. The search cost a cent and taught us nothing,
 * because the sold data it needed is not on the open web.
 *
 * An original piece inverts that. It has never been sold, so there is no
 * clearing price to discover and no sale history to miss. The seller is SETTING
 * a price, and what comparable makers currently ask is precisely the evidence
 * that decision needs — which is the one thing a web search is good at. The
 * model has no memorised market for a hand-thrown mug or a stranger's painting
 * either, so this is also where its own knowledge is thinnest.
 *
 * `priceConfidence` used to widen this gate to anything the model flagged as a
 * guess. That is what pulled the jeans in. The field is still emitted and still
 * worth logging, but it no longer spends money.
 */
function shouldVerify(r: AnalyzeResult): boolean {
  if (process.env.PRICE_VERIFY !== "on") return false;
  if (r.estimatedValueUSD.high < VERIFY_MIN_USD) return false;
  return r.valuationBasis === "original";
}

// The result to serve, plus — for the scan log — what became of the check.
interface PriceCheck {
  result: AnalyzeResult;
  status: VerifyStatus;
  /** Time and money the check took. Unset when it was never attempted. */
  ms?: number;
  costUSD?: number;
}

function roundTo4(n: number): number {
  return Math.round(n * 10_000) / 10_000;
}

async function maybeVerifyPrice(
  result: AnalyzeResult,
  deviceId?: string,
  startedAt: number = Date.now(),
): Promise<PriceCheck> {
  if (!shouldVerify(result)) return { result, status: "not_eligible" };

  // What is left of the function's own lifetime. Checked BEFORE the allowance
  // is claimed, so a search we have no time to finish never costs anyone one.
  const remainingMs =
    FUNCTION_BUDGET_MS - (Date.now() - startedAt) - RESPONSE_MARGIN_MS;
  if (remainingMs < MIN_VERIFY_MS) {
    console.log(`[verify] skipped: only ${remainingMs}ms left of the request`);
    return { result, status: "no_time" };
  }

  // Spend against this device's own daily allowance. Fails closed: no
  // allowance, no search. No note either — nothing was attempted, so there is
  // nothing to tell the seller about.
  if (!(await claimSearchBudget(deviceId))) {
    return { result, status: "no_allowance" };
  }

  const verifyStartedAt = Date.now();
  const outcome = await verifyPrice(result, remainingMs);
  const spent = { ms: Date.now() - verifyStartedAt, costUSD: outcome.costUSD };
  if (!outcome.price) {
    // Two different situations, and only one of them is ours to explain.
    //
    // A search that ran and came back empty earns a line: the scan just took
    // ten seconds longer than usual and the seller deserves to know why,
    // without a tour of which marketplaces were tried. WHICH site failed is our
    // problem, not theirs — "no eBay results" invites them to wonder whether
    // eBay is broken. priceBasis stays "estimate" because the number is still
    // the model's own.
    //
    // A search that never ran — it timed out, threw, or was never issued —
    // earns silence. "Couldn't find listings" would be the app describing an
    // outcome it never reached, and the seller has no use for a report on a
    // lookup that did not happen.
    return outcome.searched
      ? {
          result: { ...result, priceNote: "Couldn't find listings" },
          status: "no_listings",
          ...spent,
        }
      : { result, status: "not_searched", ...spent };
  }

  return {
    result: applyVerified(result, outcome.price),
    status: "verified",
    ...spent,
  };
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
