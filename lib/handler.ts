import { analyzeImage, type ImageInput } from "./analyze.js";
import { priceItem } from "./price.js";
import { isValidMediaType } from "./schema.js";
import { checkAndRecordScan, getTotalScans } from "./usage.js";

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
    return { status: 200, body: result as unknown as Record<string, unknown> };
  } catch (err) {
    console.error("[analyze] failed:", err);
    return { status: 502, body: { error: "Analysis failed" } };
  }
}

export async function handlePriceRequest(
  body: unknown,
): Promise<HandlerResponse> {
  const input = (body ?? {}) as Record<string, unknown>;
  const searchQuery = input.searchQuery;
  const fallback = (input.fallbackEstimate ?? {}) as Record<string, unknown>;

  if (typeof searchQuery !== "string" || searchQuery.trim().length === 0) {
    return { status: 400, body: { error: "Missing 'searchQuery'" } };
  }

  const low = typeof fallback.low === "number" ? fallback.low : 0;
  const high = typeof fallback.high === "number" ? fallback.high : 0;

  try {
    const result = await priceItem(searchQuery, { low, high });
    return { status: 200, body: result as unknown as Record<string, unknown> };
  } catch (err) {
    console.error("[price] failed:", err);
    return { status: 502, body: { error: "Pricing failed" } };
  }
}

// Public stats: the all-time total scans across everyone, for the app's counter.
export async function handleStatsRequest(): Promise<HandlerResponse> {
  const totalScans = await getTotalScans();
  return { status: 200, body: { totalScans } };
}
