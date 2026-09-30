import Anthropic from "@anthropic-ai/sdk";
import {
  ANALYZE_SCHEMA,
  CATEGORIES,
  CONDITIONS,
  EXPECTED_SPEED,
  LEGACY_PLATFORMS,
  CRAFT_LEVEL,
  PRICE_CONFIDENCE,
  SPECIFICITY,
  VALUATION_BASIS,
  type AnalyzeResult,
  type MediaType,
  type PlatformName,
} from "./schema.js";
import { cleanText, completeSentences, dropHedges, dropTitleHedges } from "./text.js";

// Sonnet 4.6 is the default: vision-capable, supports structured outputs, and
// cheap enough to run per-scan. Override with the MODEL env var to A/B test a
// cheaper model (e.g. MODEL=claude-haiku-4-5, ~3x cheaper) against it on real
// photos — both support vision + structured outputs, so no other code changes.
const MODEL = process.env.MODEL ?? "claude-sonnet-4-6";

// Wall-clock ceiling on the FIRST vision attempt.
//
// The vision call is the one step with no fallback: verification can fail and
// still leave the estimate, but a failed identification leaves nothing to show.
// So a stalled first attempt gets one more try rather than an error screen. A
// slow call is usually one stuck request, and a fresh one comes back in the
// normal ~6s far more often than the stuck one finishes.
//
// 20s is a little over three times the ~6s a scan actually takes, and it leaves
// ~22s of the request's 45s deadline for the retry.
const FIRST_ATTEMPT_MS = Number(process.env.ANALYZE_TIMEOUT_MS ?? 20_000);

// Not worth starting a retry with less than this left — it would time out
// before a normal scan could finish, and the user would wait longer for the
// same error.
const MIN_RETRY_MS = 8_000;

// The SDK's own retries stay off. It defaults to two, each costing a full
// timeout and none of them aware of the request's deadline. The one retry lives
// in analyzeImage(), where it can be sized to whatever time is actually left.
const MAX_RETRIES = 0;

// Headroom, not a budget. A normal scan spends ~200 output tokens, so this
// never costs anything extra — but the schema has fifteen fields and the
// description sits twelfth, which means a cap the model can actually reach gets
// spent on the analysis and truncates the copy the seller pastes. A scan that
// stopped mid-sentence is what this number is set against.
const MAX_OUTPUT_TOKENS = 4096;

// Per-1M-token prices (USD) for the cost log below. Keep in sync with the
// models we actually switch between; unknown models just skip the cost line.
const PRICING: Record<string, { input: number; output: number }> = {
  "claude-sonnet-4-6": { input: 3, output: 15 },
  "claude-haiku-4-5": { input: 1, output: 5 },
};

// What a call cost in tokens, or undefined for a model we have no prices for.
export function tokenCostUSD(
  model: string,
  inputTokens: number,
  outputTokens: number,
): number | undefined {
  const price = PRICING[model];
  return price
    ? (inputTokens * price.input + outputTokens * price.output) / 1_000_000
    : undefined;
}

/**
 * What the vision pass did, as opposed to what it found — filled in for the
 * scan log (lib/scanlog.ts). Passed in rather than returned so it survives a
 * throw: a scan that failed after a retry still has a retry worth recording.
 */
export interface AnalyzeTrace {
  model?: string;
  retried?: boolean;
  inputTokens?: number;
  outputTokens?: number;
  costUSD?: number;
}

const SYSTEM_PROMPT = `You are an expert reseller's assistant. You are shown one or more photos of a SINGLE physical item the user wants to sell. When there are multiple photos they show the same item — different angles, or a close-up of a label, tag, or logo. Use every photo together to identify it. Identify the item and produce a structured listing summary.

Most items you see are mass-produced goods being resold secondhand, and that is the default assumption. But not everything is: some items are one-of-a-kind pieces made by the person photographing them. Those have no secondhand market to discount from, so they are valued differently. The valuationBasis field below is where you make that call.

Rules:
- Identify the single main item. Ignore the background, hands, packaging clutter, and any other objects.
- title: a concise marketplace-style title — brand (if known) + item type + key attributes + colour/material. Keep it under ~80 characters. It names the ITEM, never the photograph: nothing about how the thing is posed, angled, lit, opened, or arranged, and no word that only makes sense while looking at the picture. "Apple MacBook Pro 13-inch Laptop, Silver" is a title a buyer searches for; "Laptop Computer with Display Open" is a caption, and pasting a caption into a listing throws away the brand and model the search traffic actually comes from.
  • The exact model is what buyers search for, so put it in the title whenever you can determine it: the model name or number, the generation or version ("MK3", "Series 7", "3rd Gen", "V2"), and the one spec that splits the product line — key count, storage, screen size, capacity. "Apple AirPods Pro 2nd Generation with USB-C Case" beats "Apple AirPods Wireless Earbuds, White"; the first is the listing buyers find, the second matches every generation at once. Count what can be counted.
  • Every word of the title must be something you are sure of. A spec you would have to estimate — a case or screen size with nothing in the photo to measure it against, a capacity or clothing size that isn't printed anywhere you can read — stays out. Never give two options ("42mm/44mm", "64GB or 128GB"): that is a guess, and a buyer who receives the other one returns it. Put in what you know, leave out what you don't, and the title is exactly as specific as the photo allows. The same goes for ranges and qualifiers — "Series 3 or Later", "or similar", "Type", "Style" — and for tacking on a feature to stand in for the model you couldn't name ("— Front LCD Display Model"): end the title at the last thing you know.
  • Many product lines come in look-alike generations. Tell them apart by what actually differs between them — a display or none, the type of knob or joystick, the ports, the printed model or generation mark — not by the overall look. If you cannot tell which generation it is, name the line without one; a wrong generation misleads the buyer and gets the item returned.
- category: choose the single best fit from the allowed set. Use "jewelry" for bracelets, necklaces, rings, earrings, and watches; use "accessory" for bags, belts, wallets, sunglasses, hats, and scarves. Reserve "clothing" for worn garments.
- brand: the brand name ONLY if you can identify it with high confidence from a visible logo, label, or unmistakable design. If you are not confident, return an empty string "". Never guess a brand.
- condition: estimate from visible wear. Default to "good" for a normal used item with no visible damage. Use "new"/"like_new" only with clear evidence (tags attached, pristine surfaces); use "fair"/"poor" only for visible damage or heavy wear. A newly made original piece is "new" — but do not lean on condition when pricing it, since it carries no information there.
- keywords: 3-8 short, lowercase terms a buyer might search for.
- searchQuery: a short query someone would type to find this exact item on a marketplace — brand + model and generation + item type + key attributes. No punctuation needed.
- specificity: "exact" if you confidently identified a specific brand/model; "generic" if this is a best-effort generic description.
- valuationBasis: "original" ONLY when this is a one-of-a-kind piece being sold by the person who made it — an original artwork, a handmade or handcrafted object, a custom-built piece. Everything else is "resale". Default to "resale" and require real evidence to leave it: visible brushwork or impasto, raw or stapled canvas edges, a hand-written signature, tool marks, glaze irregularities, an unfinished back or underside. A mass-produced print, a factory-made decorative object, or a piece the user is flipping rather than made is "resale". If the user's hint says they made it, believe them.
- priceConfidence: your own honest read on whether checking current listings would materially change your number. "high" when you know this market well — a common branded product with a deep, stable secondhand market. "low" when your knowledge is thin, stale, or the market is volatile: one-of-a-kind pieces, niche collectibles, small or fast-moving markets. "low" is not a failure and it costs the seller nothing; claiming "high" on a market you barely know does cost them.
- craftLevel: for an original piece ONLY, how well it is executed. "not_applicable" whenever valuationBasis is "resale".
  • The market for handmade work comes in tiers, not one band. Search a subject like "shark painting" and you find prints around $3-35, decorative canvases around $45-150, substantial handmade work around $400-1,700, and gallery pieces well above that. Which tier a piece belongs to is the whole valuation, and the photo is the only evidence for it.
  • "basic" — simple, quickly made, beginner work. Flat colour, little detail, visible unsteadiness.
  • "competent" — solid amateur work with real care taken. Controlled technique, deliberate composition, finished properly. Most things people make at home land here.
  • "accomplished" — clear skill and substantial time. Confident technique, considered composition, would hold its own hung in a room among bought art.
  • "professional" — gallery standard. The work of someone who does this for a living.
  Grade the WORK, not the subject or your taste in it. Be honest and be willing to use the middle: inflating this inflates the price, and a seller who prices a competent piece as a professional one simply never sells it.
- estimatedValueUSD: a whole-dollar range with low < high. What that number MEANS depends on valuationBasis:
  • "resale" — the RESALE value: what this item would realistically sell for SECONDHAND today (what a buyer would pay a private seller on a resale marketplace). This is NOT the original retail/store price and NOT replacement cost; a used item is normally well below retail. Base it on the item type, brand, and apparent condition.
  • "original" — the PRIMARY asking price: what the maker could realistically ask. Do NOT discount from retail — there is no retail, this piece has never been sold, and the seller IS the primary market. Anchor on medium, size, execution, and finish. For 2D artwork a common convention is (height + width in inches) × roughly $1-4 per inch for a maker with no established sales history. Assume no established following unless told otherwise, and keep the range wide: the maker's audience, not the object, drives the top end.
- listingDescription: 1-4 complete sentences the seller pastes straight into a listing, unedited. Open with what the item is, then add the facts a buyer decides on — brand and model, colour, material, size or capacity, the features that are plainly there — and stop as soon as you run out of ones you can state flatly. Four is a CEILING, never a quota. One true sentence is a finished description; a sentence written to reach a count is always worse than the silence it replaced, because the only material left to pad with is what you do not know. This is buyer-facing copy, NOT your analysis of the photo — never write that something is "visible", "shown", "pictured", "in frame", or describe where in the shot it sits. Never explain how you identified the item either: "identifiable by its rounded top" and "consistent with normal use" are your reasoning, not facts about the item. Write only plain statements of fact about the item, and include a detail ONLY if you can state it flatly. That list is a menu, not a checklist: every entry you cannot assert outright is one you leave out. General condition is optional. A description that never mentions condition is correct; "appears to be in good condition" is not, and reaching for a hedge is the signal you should have dropped the detail instead.
  • Specific flaws are the exception: disclose them. A missing part, knob, cap, or button; a crack, chip, dent, stain, tear, or broken piece — anything a buyer would find wrong on arrival — goes in its own short, flat sentence at the end: "One knob cap is missing." "The left hinge has a small crack." A flaw the listing never mentioned is how an item gets returned, so this is the one piece of condition that is never optional. Only state a flaw you can plainly see, and state it as fact; normal light wear is not a flaw and stays out. Glare, reflections, dust, and photo blur are not scratches or damage — when you can't be sure a mark is on the item, leave it out. And no flaw means no sentence: never write that an item has "no damage", "no cracks", that a part is "intact", or that the item is "in good condition" — that is general condition, which stays out.
    Flaws are easy to miss because they are small. Before writing, look closely at every set of repeated parts — knobs, keys, buttons, pads, caps, feet, screws, stones, buttons on a garment — and check that each one matches the others. One that looks different from its siblings (a bare shaft where the rest have caps, an empty setting, a missing key) is a missing or broken part.
  • Finish what you start. Every sentence ends in a full stop and every last sentence is a whole thought. A short description that ends cleanly is always better than a longer one that stops mid-clause — the seller pastes this without reading it, so a dangling "and" ships straight to buyers.
  • Never hedge. Do not write "appears to be", "looks like", "seems", "possibly", "presumably", "likely", "probably", "hard to tell", or any remark that a label is unreadable or the item unidentified. Your uncertainty is already reported in brand and specificity; it must never appear in this text.
  • Describe only what the buyer receives. Anything that was true of the moment the shutter opened but is not true of the item in the box is out: what is on the screen, what it is plugged into, what it is resting on, what is sitting next to it, what is inside it that does not come with it. A powered-on display is showing the seller's desktop, not a feature of the laptop, and a sentence about it is a sentence the buyer has to read past to find out what they are buying.
  • Never report what you could not determine. "Exact year not confirmed", "model unknown", "specs unverified" are all the same move, and so is handing the question to the buyer: never write "inquire", "message me", "contact for details", or "ask before buying". The seller knows things you cannot see and will add them; a gap in your copy is an invitation for them to fill it, while a sentence about the gap is something they have to notice and delete. A fact you cannot state is a fact you leave out, silently.
  • Do not offer alternatives. "A paint swatch, colour reference card, or fabric sample" is three guesses wearing one sentence. Name the one thing you are most confident it is, at whatever level of detail you can actually stand behind.
  • The three rules above are the ones that break most often, and they break the same way: you run out of things you can assert, and reach for filler. What that filler looks like in practice, and what to write instead:
      WRONG "Apple MacBook Pro laptop in silver aluminum. The exact year and processor generation are not listed here, so please verify the specs before purchasing."
      RIGHT "Apple MacBook Pro laptop in silver aluminum with a black backlit keyboard and large trackpad."
      WRONG "Men's black faux or genuine leather biker jacket with an asymmetric zip front."
      RIGHT "Men's black biker jacket with an asymmetric zip front, quilted shoulder panels, and silver-tone hardware."
      WRONG "White ceramic espresso or cappuccino cup in a small, rounded style."
      RIGHT "Small white ceramic cup with a rounded body."
    In every pair the RIGHT version is shorter and says less. That is the trade: the seller can add the model year, the leather, the intended drink. They cannot easily notice and delete a sentence that reads as if it belongs.
  • When you are unsure, become LESS SPECIFIC — never less certain. Drop the detail you can't verify and state what you can. "Glass bottle of golden facial oil with a white cap, travel size" is correct when the label is illegible; "what appears to be an oil or serum, label not clearly legible" is not.
  • No sales pitch, no imagined buyer, no filler. Cut "ideal for", "perfect for", "great for anyone who", "a must-have", "ready to hang", "ready to display", "ready to use", "a great addition to". Anything describing what the buyer could DO with the item is filler; only what the item IS belongs here.
  • Do NOT mention price, shipping, returns, or payment. No markdown, hashtags, or emoji.
  • When valuationBasis is "original", write AT MOST TWO sentences, in this exact shape:
      1. What it is — original rather than a print, medium, surface, dimensions. "Original acrylic painting on canvas, 16x20 inches."
      2. What it looks like — subject, composition, colours.
    Then stop. There is no third sentence, and the second one ends at the last colour you name. Filler arrives at the end or not at all, so ending on time is the whole discipline.
    Never write that a piece is signed, hand-painted, framed, mounted, ready to hang, or ready to display — not even when the user's hint says so. The hint exists to help you identify and price the item; it is not copy to relay to a buyer. Claims about provenance are the seller's to make, not yours.
- recommendedPlatform: the SINGLE marketplace where THIS specific item is most likely to actually sell, and sell quickly. Choose from the marketplaces the user message says this seller uses, spelled exactly as listed there. Use where the buyers for this item actually are:
  • Facebook Marketplace / OfferUp — local pickup. Best for bulky/heavy items (furniture, appliances) and low-value items where shipping isn't worth it.
  • eBay — shippable items buyers search for by brand/model: electronics, collectibles, parts, media, tools, branded gear. Widest buyer base.
  • Poshmark / Depop / Vinted — fashion (clothing, shoes, accessories). Depop/Vinted skew younger, streetwear, and vintage; Poshmark is broad.
  • Mercari — general shippable goods at mid value.
  • Etsy — handmade, vintage (20+ years old), art, and craft supplies. The natural home for original and handmade pieces. Without it, usually Depop for small decorative or wearable work, eBay for anything a buyer would search for by subject or style.
  • StockX — new or deadstock sneakers, streetwear, trading cards and collectibles, and some current electronics. Not for used everyday goods.
  When the best home for this item isn't among the seller's marketplaces, pick the closest fit from theirs and say so plainly in recommendationReason.
- recommendationReason: ONE short sentence, specific to this item, on why that platform is the best place to sell it.
- relevantPlatforms: the marketplaces where THIS item would realistically sell, best first, starting with recommendedPlatform. At most 7, from the same choices as recommendedPlatform. Leave out any whose buyers don't want this kind of item — StockX for a used lamp, Poshmark for a power drill, local-only sites for something small and valuable that ships well. A short list is fine; a padded one sends the seller somewhere it won't sell.
- expectedSpeed: how quickly it is likely to sell on that platform — "fast" (days), "moderate" (a couple of weeks), or "slow" (a month or more / niche demand).

If the photo is blurry, dark, partial, or ambiguous: describe the item generically, set brand to "", set specificity to "generic", and give a WIDE price range. Degrade gracefully — do NOT invent a brand or model you cannot actually see.

That degrading happens in the DATA fields — brand, specificity, priceConfidence, and the price range carry your uncertainty. The title and listingDescription stay clean either way: they get shorter and more general, never hedged. A seller must be able to post them without editing a word.`;

/**
 * Did this call run out of time, as opposed to failing some other way?
 *
 * Lives here so the handler can ask without importing the SDK, and so the one
 * place that knows how the client is configured is the same place that knows
 * what its failures look like.
 */
export function isTimeout(err: unknown): boolean {
  return (
    err instanceof Anthropic.APIConnectionTimeoutError ||
    (err instanceof Error && err.name === "APIConnectionTimeoutError")
  );
}

export interface ImageInput {
  /** base64-encoded image data, no `data:` prefix. */
  data: string;
  mediaType: MediaType;
}

/**
 * Is this failure the API's rather than the request's — worth one more try?
 *
 * Timeouts, dropped connections, 529 overloaded and other 5xx are about the
 * API's state at that moment, and a fresh request can land somewhere healthy.
 * A 4xx is about what we sent, and sending it again gets the same answer.
 */
function isRetryable(err: unknown): boolean {
  if (isTimeout(err)) return true;
  if (err instanceof Anthropic.APIConnectionError) return true;
  return (
    err instanceof Anthropic.APIError &&
    typeof err.status === "number" &&
    err.status >= 500
  );
}

// Where this seller sells, from the app's settings. See handler.ts.
export interface Marketplaces {
  /** The listed marketplaces they use, in the app's order. Never empty. */
  platforms: readonly PlatformName[];
  /** Whether the model may recommend a marketplace not on the list. */
  allowOther: boolean;
}

export const LEGACY_MARKETPLACES: Marketplaces = {
  platforms: LEGACY_PLATFORMS,
  allowOther: false,
};

export async function analyzeImage(
  images: ImageInput[],
  hint?: string,
  // Epoch ms by which the vision pass must be done, retry included. The
  // handler derives it from the request's own deadline.
  deadline: number = Date.now() + FIRST_ATTEMPT_MS,
  trace: AnalyzeTrace = {},
  markets: Marketplaces = LEGACY_MARKETPLACES,
): Promise<AnalyzeResult> {
  trace.model = MODEL;
  trace.retried = false;
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
  const withHint = hint?.trim()
    ? `${instruction}\n\nThe user adds this hint about the item: "${hint.trim()}". Use it only when consistent with what you see; never contradict the photos.`
    : instruction;
  // Per request, not in the system prompt: each seller's list is their own.
  // With "Loot Check decides" on, the list is a starting point, not a limit.
  const text = markets.allowOther
    ? `${withHint}\n\nThis seller will sell anywhere. For recommendedPlatform and relevantPlatforms, choose freely from any well-known marketplace — these (${markets.platforms.join(", ")}) or any other, such as a specialist site for this item's category — whichever genuinely suit this item best. Give each by its common name.`
    : `${withHint}\n\nThis seller sells on: ${markets.platforms.join(", ")}. recommendedPlatform and relevantPlatforms must come from these only.`;

  // Structured outputs constrain the response to ANALYZE_SCHEMA on the normal
  // text channel — cleaner than forced tool use, which can leak tool-call
  // formatting tokens into string fields on degenerate inputs.
  const attempt = (timeout: number) =>
    // Reads ANTHROPIC_API_KEY from the environment.
    new Anthropic({ timeout, maxRetries: MAX_RETRIES }).messages.create({
      model: MODEL,
      max_tokens: MAX_OUTPUT_TOKENS,
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

  // One try, and one more only if the failure was the API's and there is time
  // for a normal scan to finish. Otherwise the error goes up to the handler,
  // which turns a timeout into "That took longer than expected".
  let response;
  try {
    response = await attempt(
      Math.min(FIRST_ATTEMPT_MS, Math.max(deadline - Date.now(), 1)),
    );
  } catch (err) {
    const left = deadline - Date.now();
    if (!isRetryable(err) || left < MIN_RETRY_MS) throw err;
    const reason = isTimeout(err)
      ? "timeout"
      : err instanceof Anthropic.APIError && err.status
        ? `status ${err.status}`
        : "connection error";
    console.log(`[analyze] retrying after ${reason}, ${left}ms left`);
    trace.retried = true;
    response = await attempt(left);
  }

  // Per-scan usage + cost, so the model A/B test shows real numbers (not
  // estimates) next to the result quality.
  const u = response.usage;
  const cost = tokenCostUSD(MODEL, u.input_tokens, u.output_tokens);
  trace.inputTokens = u.input_tokens;
  trace.outputTokens = u.output_tokens;
  trace.costUSD = cost;
  console.log(
    `[analyze] model=${MODEL} in=${u.input_tokens} out=${u.output_tokens}` +
      (cost !== undefined ? ` cost=$${cost.toFixed(4)}` : ""),
  );

  // Structured outputs guarantee the SHAPE, not that the model finished
  // talking. Hitting the cap cuts a string wherever it happened to be — the
  // listing text most of all, since it is the longest field — and the result
  // still parses, so nothing downstream would notice. Fail instead: a scan the
  // seller retries beats a listing that ends on "and".
  if (response.stop_reason === "max_tokens") {
    throw new Error(
      `Response hit the ${MAX_OUTPUT_TOKENS}-token cap and was truncated` +
        ` (out=${u.output_tokens})`,
    );
  }

  const textBlock = response.content.find((b) => b.type === "text");
  if (!textBlock || textBlock.type !== "text") {
    throw new Error("Model returned no text content");
  }

  return normalize(JSON.parse(textBlock.text), markets);
}

// Structured outputs guarantee the shape, but we still defend against bad
// values: out-of-range prices, any markup or invisible characters the model
// might leak into string fields on degenerate inputs, and copy that does not
// finish its last sentence.
function normalize(raw: unknown, markets: Marketplaces): AnalyzeResult {
  const r = raw as Record<string, unknown>;

  const category = oneOf(r.category, CATEGORIES, "other");
  const condition = oneOf(r.condition, CONDITIONS, "good");
  const specificity = oneOf(r.specificity, SPECIFICITY, "generic");
  // Both default to the conservative answer: treat it as an ordinary resale the
  // model knows, so a malformed response can never trigger a paid search or
  // relabel someone's used jacket as an original work.
  const valuationBasis = oneOf(r.valuationBasis, VALUATION_BASIS, "resale");
  const priceConfidence = oneOf(r.priceConfidence, PRICE_CONFIDENCE, "high");
  const craftLevel = oneOf(r.craftLevel, CRAFT_LEVEL, "not_applicable");

  const value = (r.estimatedValueUSD ?? {}) as Record<string, unknown>;
  let low = toFiniteNumber(value.low, 0);
  let high = toFiniteNumber(value.high, 0);
  if (low < 0) low = 0;
  if (high < low) high = low;

  const keywords = Array.isArray(r.keywords)
    ? r.keywords.map(cleanText).filter((k) => k.length > 0).slice(0, 8)
    : [];

  const title = dropTitleHedges(cleanText(r.title)) || "Unidentified item";

  return {
    title,
    category,
    brand: cleanBrand(r.brand),
    condition,
    keywords,
    searchQuery: cleanText(r.searchQuery),
    specificity,
    valuationBasis,
    priceConfidence,
    craftLevel,
    estimatedValueUSD: { low: Math.round(low), high: Math.round(high) },
    // Three passes, because the three ways this text goes wrong are different:
    // cleanText removes what the app would render as a stray blank line,
    // dropHedges removes a caveat sentence the prompt already forbids, and
    // completeSentences removes a tail that never finished. Order matters —
    // dropping a sentence can expose a new last one, so the terminator check
    // runs last.
    listingDescription: completeSentences(
      dropHedges(cleanText(r.listingDescription)),
    ),
    ...pickPlatform(
      cleanText(r.recommendedPlatform),
      cleanText(r.recommendationReason),
      r.relevantPlatforms,
      markets,
    ),
    expectedSpeed: oneOf(r.expectedSpeed, EXPECTED_SPEED, "moderate"),
    // Server-set. The handler upgrades these if the verification pass runs.
    priceBasis: "estimate",
    priceNote: "",
  };
}

// Brand must look like a real brand, never leaked markup. When in doubt, blank.
function cleanBrand(value: unknown): string {
  if (typeof value !== "string") return "";
  if (/[<>]|antml|parameter|name=|\//i.test(value)) return "";
  return cleanText(value);
}

// A marketplace name from the model, held to the seller's settings: one of
// theirs, spelled the way the app's table spells it (the app matches rows by
// name); or, when they allow other sites, any sensible name; otherwise null.
function allowedPlatform(name: string, markets: Marketplaces): string | null {
  const listed = markets.platforms.find(
    (p) => p.toLowerCase() === name.toLowerCase(),
  );
  if (listed) return listed;
  return markets.allowOther && name.length > 0 && name.length <= 40 ? name : null;
}

const MAX_RELEVANT = 7;

// The recommendation, and the marketplaces worth listing the item on. A pick
// the seller can't use becomes their first marketplace, and the reason goes
// with it — it was written about a site they don't use. The list keeps only
// usable names, once each, recommendation first.
function pickPlatform(
  name: string,
  reason: string,
  relevant: unknown,
  markets: Marketplaces,
): {
  recommendedPlatform: string;
  recommendationReason: string;
  relevantPlatforms: string[];
} {
  const picked = allowedPlatform(name, markets);
  const recommendedPlatform = picked ?? markets.platforms[0]!;
  const ranked = (Array.isArray(relevant) ? relevant : [])
    .map((n) => allowedPlatform(cleanText(n), markets))
    .filter((n): n is string => n !== null);
  const relevantPlatforms = [...new Set([recommendedPlatform, ...ranked])].slice(
    0,
    MAX_RELEVANT,
  );
  return {
    recommendedPlatform,
    recommendationReason: picked ? reason : "",
    relevantPlatforms,
  };
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
