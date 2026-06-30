import Anthropic from "@anthropic-ai/sdk";
import {
  ANALYZE_SCHEMA,
  CATEGORIES,
  CONDITIONS,
  EXPECTED_SPEED,
  PLATFORM_NAMES,
  SPECIFICITY,
  type AnalyzeResult,
  type MediaType,
} from "./schema.js";

// Sonnet 4.6 is the default: vision-capable, supports structured outputs, and
// cheap enough to run per-scan. Override with the MODEL env var to A/B test a
// cheaper model (e.g. MODEL=claude-haiku-4-5, ~3x cheaper) against it on real
// photos — both support vision + structured outputs, so no other code changes.
const MODEL = process.env.MODEL ?? "claude-sonnet-4-6";

// Per-1M-token prices (USD) for the cost log below. Keep in sync with the
// models we actually switch between; unknown models just skip the cost line.
const PRICING: Record<string, { input: number; output: number }> = {
  "claude-sonnet-4-6": { input: 3, output: 15 },
  "claude-haiku-4-5": { input: 1, output: 5 },
};

const SYSTEM_PROMPT = `You are an expert reseller's assistant. You are shown one or more photos of a SINGLE physical item the user wants to sell secondhand. When there are multiple photos they show the same item — different angles, or a close-up of a label, tag, or logo. Use every photo together to identify it. Identify the item and produce a structured listing summary.

Rules:
- Identify the single main item. Ignore the background, hands, packaging clutter, and any other objects.
- title: a concise marketplace-style title — brand (if known) + item type + key attributes + colour/material. Keep it under ~80 characters.
- category: choose the single best fit from the allowed set.
- brand: the brand name ONLY if you can identify it with high confidence from a visible logo, label, or unmistakable design. If you are not confident, return an empty string "". Never guess a brand.
- condition: estimate from visible wear. Default to "good" for a normal used item with no visible damage. Use "new"/"like_new" only with clear evidence (tags attached, pristine surfaces); use "fair"/"poor" only for visible damage or heavy wear.
- keywords: 3-8 short, lowercase terms a buyer might search for.
- searchQuery: a short query for finding comparable SOLD listings — brand + item type + key attributes. No punctuation needed.
- estimatedValueUSD: the RESALE value — what this item would realistically sell for SECONDHAND today (what a buyer would pay a private seller on a resale marketplace), as a whole-dollar range with low < high. This is NOT the original retail/store price and NOT replacement cost; a used item is normally well below retail. Base it on the item type, brand, and apparent condition.
- specificity: "exact" if you confidently identified a specific brand/model; "generic" if this is a best-effort generic description.
- listingDescription: 2-4 sentences a seller could post as-is on a marketplace. Friendly and factual: what it is, notable features, and the condition. Do NOT mention price. No markdown, hashtags, or emoji.
- recommendedPlatform: the SINGLE marketplace where THIS specific item is most likely to actually sell, and sell quickly. Choose from: Facebook Marketplace, OfferUp, Vinted, Depop, Mercari, eBay, Poshmark. Use where the buyers for this item actually are:
  • Facebook Marketplace / OfferUp — local pickup. Best for bulky/heavy items (furniture, appliances) and low-value items where shipping isn't worth it.
  • eBay — shippable items buyers search for by brand/model: electronics, collectibles, parts, media, tools, branded gear. Widest buyer base.
  • Poshmark / Depop / Vinted — fashion (clothing, shoes, accessories). Depop/Vinted skew younger, streetwear, and vintage; Poshmark is broad.
  • Mercari — general shippable goods at mid value.
- recommendationReason: ONE short sentence, specific to this item, on why that platform is the best place to sell it.
- expectedSpeed: how quickly it is likely to sell on that platform — "fast" (days), "moderate" (a couple of weeks), or "slow" (a month or more / niche demand).

If the photo is blurry, dark, partial, or ambiguous: describe the item generically, set brand to "", set specificity to "generic", and give a WIDE price range. Degrade gracefully — do NOT invent a brand or model you cannot actually see.`;

export interface ImageInput {
  /** base64-encoded image data, no `data:` prefix. */
  data: string;
  mediaType: MediaType;
}

export async function analyzeImage(
  images: ImageInput[],
  hint?: string,
): Promise<AnalyzeResult> {
  // Reads ANTHROPIC_API_KEY from the environment.
  const client = new Anthropic();

  const imageBlocks = images.map((img) => ({
    type: "image" as const,
    source: {
      type: "base64" as const,
      media_type: img.mediaType,
      data: img.data,
    },
  }));

  const instruction =
    images.length > 1
      ? "Analyze this item for resale. The photos all show the SAME single item (e.g. different angles or a close-up of a label or logo)."
      : "Analyze this item for resale.";
  // The hint is user-supplied disambiguation (a brand, model, size). Treat it as
  // a clue, not ground truth — the photo still wins if they conflict.
  const text = hint?.trim()
    ? `${instruction}\n\nThe user adds this hint about the item: "${hint.trim()}". Use it only when consistent with what you see; never contradict the photos.`
    : instruction;

  // Structured outputs constrain the response to ANALYZE_SCHEMA on the normal
  // text channel — cleaner than forced tool use, which can leak tool-call
  // formatting tokens into string fields on degenerate inputs.
  const response = await client.messages.create({
    model: MODEL,
    max_tokens: 1024,
    thinking: { type: "disabled" },
    system: SYSTEM_PROMPT,
    messages: [
      {
        role: "user",
        content: [...imageBlocks, { type: "text", text }],
      },
    ],
    output_config: {
      format: {
        type: "json_schema",
        schema: ANALYZE_SCHEMA as unknown as Record<string, unknown>,
      },
    },
  });

  // Per-scan usage + cost, so the model A/B test shows real numbers (not
  // estimates) next to the result quality.
  const u = response.usage;
  const price = PRICING[MODEL];
  const cost = price
    ? (u.input_tokens * price.input + u.output_tokens * price.output) / 1_000_000
    : undefined;
  console.log(
    `[analyze] model=${MODEL} in=${u.input_tokens} out=${u.output_tokens}` +
      (cost !== undefined ? ` cost=$${cost.toFixed(4)}` : ""),
  );

  const textBlock = response.content.find((b) => b.type === "text");
  if (!textBlock || textBlock.type !== "text") {
    throw new Error("Model returned no text content");
  }

  return normalize(JSON.parse(textBlock.text));
}

// Structured outputs guarantee the shape, but we still defend against bad
// values: out-of-range prices, and any markup/control characters the model
// might leak into string fields on degenerate inputs.
function normalize(raw: unknown): AnalyzeResult {
  const r = raw as Record<string, unknown>;

  const category = oneOf(r.category, CATEGORIES, "other");
  const condition = oneOf(r.condition, CONDITIONS, "good");
  const specificity = oneOf(r.specificity, SPECIFICITY, "generic");

  const value = (r.estimatedValueUSD ?? {}) as Record<string, unknown>;
  let low = toFiniteNumber(value.low, 0);
  let high = toFiniteNumber(value.high, 0);
  if (low < 0) low = 0;
  if (high < low) high = low;

  const keywords = Array.isArray(r.keywords)
    ? r.keywords.map(cleanText).filter((k) => k.length > 0).slice(0, 8)
    : [];

  const title = cleanText(r.title) || "Unidentified item";

  return {
    title,
    category,
    brand: cleanBrand(r.brand),
    condition,
    keywords,
    searchQuery: cleanText(r.searchQuery),
    estimatedValueUSD: { low: Math.round(low), high: Math.round(high) },
    specificity,
    listingDescription: cleanText(r.listingDescription),
    recommendedPlatform: oneOf(r.recommendedPlatform, PLATFORM_NAMES, "eBay"),
    recommendationReason: cleanText(r.recommendationReason),
    expectedSpeed: oneOf(r.expectedSpeed, EXPECTED_SPEED, "moderate"),
  };
}

// Strip control characters and tag-like fragments, then collapse whitespace.
function cleanText(value: unknown): string {
  if (typeof value !== "string") return "";
  return value
    .replace(/[\u0000-\u001F\u007F]/g, " ")
    .replace(/<[^>]*>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

// Brand must look like a real brand, never leaked markup. When in doubt, blank.
function cleanBrand(value: unknown): string {
  if (typeof value !== "string") return "";
  if (/[<>]|antml|parameter|name=|\//i.test(value)) return "";
  return cleanText(value);
}

function oneOf<T extends readonly string[]>(
  value: unknown,
  allowed: T,
  fallback: T[number],
): T[number] {
  return typeof value === "string" && (allowed as readonly string[]).includes(value)
    ? (value as T[number])
    : fallback;
}

function toFiniteNumber(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}
