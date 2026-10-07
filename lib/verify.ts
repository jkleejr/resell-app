import Anthropic from "@anthropic-ai/sdk";
import {
  VERIFY_EVIDENCE,
  VERIFY_SCHEMA,
  type AnalyzeResult,
  type VerifiedPrice,
  type VerifyOutcome,
} from "./schema.js";
import { EFFORT, THINKING_OFF, tokenCostUSD } from "./analyze.js";
import { cleanText } from "./text.js";

// The optional second pass: one web search to sanity-check the model's own
// price, run ONLY when lib/handler.ts decides it's worth a cent.
//
// Two things keep this cheap. First, it is TEXT-ONLY — the item is already
// identified, so we send ~40 tokens of description instead of re-processing the
// ~1,050-token photo a second time. Second, `max_uses: 1` caps it at a single
// search no matter what the model would like to do.
//
// It FAILS OPEN in every failure mode: no search, thin results, a malformed
// response, a timeout, a bad tool combination, an outright exception. All of
// them return null, and the caller keeps the model's original estimate. A wrong
// comp is worse for the seller than an honest guess, so the bar to overwrite
// the estimate is deliberately high.

const MODEL = process.env.VERIFY_MODEL ?? "claude-sonnet-5-5";

// Ceiling on the whole verification, including the search. Past this we
// abandon it and serve the estimate — a slow scan is a worse product than an
// unverified one.
//
// This is a CEILING, not the budget actually used. The caller knows how much of
// the request's own 45s deadline the vision pass already spent, and passes in
// whatever is left; this value only caps that. See maybeVerifyPrice().
//
// Measured: a search plus both inference passes takes 8-15s. The first budget
// here was 9s, which cut off most of its own successes. 20s clears the observed
// range with room to spare; it is generous on purpose, because this only ever
// runs on originals and a timeout there means falling back to a number with no
// market behind it at all.
const TIMEOUT_MS = Number(process.env.VERIFY_TIMEOUT_MS ?? 20_000);

// Basic (direct) web search rather than the newer dynamic-filtering versions.
// Dynamic filtering runs the search from inside code execution and would cut
// the result tokens further, but it stacks code execution on top of structured
// outputs and server tools, and we can't verify that combination works before
// shipping. Start with the combination we can reason about; the token savings
// are the obvious next optimization if this proves useful.
const SEARCH_TOOL_VERSION = "web_search_20250305";

// What Anthropic bills per web search ($10 per 1,000), on top of the tokens.
const SEARCH_COST_USD = 0.01;

// Where each kind of item is actually priced. This is quality control, not cost
// control: an unrestricted search surfaces retail and manufacturer pages, and
// retail is the single anchor most likely to drag an estimate wrong.
const RESALE_DOMAINS = [
  "ebay.com",
  "mercari.com",
  "poshmark.com",
  "depop.com",
  "worthpoint.com",
  "therealreal.com",
];

// Originals are searched broadly, with only the print farms blocked.
//
// Pinning the search to a handful of art marketplaces was actively harmful:
// their category pages don't expose prices to a search index, so the search
// found the market and couldn't read a number out of it. Searching broadly
// fixes that — the plain consumer query returns shopping results that do carry
// prices.
//
// But broad is not unrestricted. These sellers deal in mass-produced canvas
// prints, and a print is the one thing an original is definitionally not:
// their prices describe a $20 poster of a painting, not a painting. Letting
// them through also puts "Amazon, Walmart" in the provenance note under a
// price labelled ORIGINAL, which reads as nonsense to the seller even when the
// number happens to land right.
const ORIGINAL_BLOCKED_DOMAINS = [
  "amazon.com",
  "walmart.com",
  "wayfair.com",
  "elephantstock.com",
  "icanvas.com",
  "displate.com",
  "society6.com",
  "redbubble.com",
];

// A refined range this far from the model's own estimate almost always means
// the search matched the wrong thing — a different product, a retail page, a
// print instead of an original. Discard rather than trust it.
const SANITY_FACTOR = 3;

// The two modes differ on one question: is an ASKING price useful evidence?
//
// For a mass-produced used item, no. There is a real clearing price to find, and
// asking prices sit systematically above it — marketplaces are full of hopeful
// listings that never sell. Pricing a used item off them overstates what the
// seller will actually get, which is the one number they came for.
//
// For a one-of-a-kind piece, yes — and it is the only evidence there is. The
// piece has never been sold and never will be until this sale, so there is no
// clearing price to discover. The seller is SETTING a price, and the real
// question is what comparable makers ask. That is exactly what listings show.
const RESALE_TASK = `Search ONCE for what this item has actually SOLD for recently on the secondhand market.

You want completed or sold prices from private sellers. Active listings are NOT evidence here: a marketplace is full of hopeful prices that never found a buyer, and this item has a real going rate that asking prices sit above. If the search returns only active listings and no sold data, that is evidence "none" — say so and keep the existing estimate.

Ignore new and retail prices entirely. What a product costs new tells you almost nothing about what a used one fetches.

For antiques and collectibles, WorthPoint records what comparable pieces actually sold for, and eBay's sold listings do the same; both are sold data.`;

const ORIGINAL_TASK = `This is a one-of-a-kind piece made by the person selling it. It has never been sold, so there is no sale history to find and you should not look for one.

Search ONCE, the way a person would: the SUBJECT, the kind of object, and the word "price". "shark painting price", "stoneware mug price", "handmade wooden bowl price". Nothing clever, no size or artist qualifiers.

The subject is the part that must not be dropped. It is what makes the search return finished pieces for sale rather than the materials they were made from — query "acrylic painting price" and you get sets of acrylic paint; query "shark painting price" and you get shark paintings. Lead with what the thing depicts or is, and let the medium follow if it helps.

That phrasing matters more than it looks. A precise query like "original acrylic painting 16x20 independent artist" returns marketplace category pages with no prices visible in them at all. The plain consumer question returns shopping results and price breakdowns with actual numbers, because that is the question the web is organised to answer. Asking prices are the right evidence here: the seller is deciding what to charge, and what comparable work asks is exactly what that decision needs.

What comes back will be TIERS, not one band. A search for shark paintings returns roughly: mass-produced prints at $3-35, decorative canvases at $45-150, substantial handmade work at $400-1,700, and gallery pieces above that. Report those tiers in findings, with their prices.

Your job is then to place THIS piece in the right tier. You are told its craft level, judged from the photo by a model that could see it:
- "basic" — the bottom of the handmade range, near decorative-print money.
- "competent" — solid amateur work. Usually the decorative-canvas tier, NOT the substantial-handmade tier. This is where most home-made work belongs.
- "accomplished" — the upper handmade range.
- "professional" — gallery tier.

Placing a competent piece in the professional tier is the failure mode to avoid: it produces a price nobody pays and the piece never sells. When the craft level sits between two tiers, take the lower one.

Assume the maker has no established following unless told otherwise. Their audience, not the object, drives the top of the range.

You are giving the seller an IDEA of what their piece could fetch, not an appraisal. A few comparable pieces with visible prices, from whichever single marketplace happens to have them, is enough to answer that. Do not try to be comprehensive, do not survey several sites, and do not privilege any particular one — take the credible prices the search puts in front of you and work from those. Holding out for a thorough picture just means returning nothing, and nothing is worse than a rough number honestly labelled.`;

// How to turn what the search found into a number. Shared, because the
// discipline is the same either way: interpret the spread, don't report it.
const REPORTING_RULES = `Then report, in this order:
- findings: what the search actually showed — the prices you saw and where. One or two sentences. If the results were thin, off-target, or about a different item, say so plainly.
- match: "exact" only when the prices you are going on are listings of THIS item — the same product, model, or the very same piece. "similar" when they are comparable items: the same kind of thing from other makers, other models, other artists. A one-of-a-kind piece is almost always "similar", since what the search finds is other people's work. When in doubt, "similar".
- evidence: how much the search gave you to price with.
  • "none" — nothing usable: the results were off-target, about a different item, category pages with no prices showing, or carried no prices at all.
  • "a_few" — one to a few relevant prices: real, but too thin to stand behind on their own. They can still nudge the estimate. Relevant means close to what this piece is worth: for an original, prices in or next to the tier you place it in. Prices that only show a different tier (gallery pieces when this is a decorative canvas, $5 prints when it is handmade) did not help price THIS piece, so on their own they are "none".
  • "enough" — the results give you a workable idea of the price. Calibrate this to the job: for a one-of-a-kind piece the seller wants a ballpark, so a handful of comparable listings with visible prices is enough and demanding a thorough survey just returns nothing. For a resale item the bar is higher, because a real going rate exists and asking prices are not it.
  Report what you actually saw. When torn between two levels, choose the lower one — the seller is told plainly either way, and overstating the evidence is the one mistake that misleads them.
- rangeUSD: NOT the raw spread of what you found. The cheapest listing is usually an outlier and so is the dearest — one is a bargain or a mistake, the other is someone hoping. Trim both ends and give the band where a piece like this would realistically change hands: above the lowest asking price, below the highest, and drawn from the bulk of what you saw in the middle. Widen it a little when the results were thin, because a thin sample deserves an honest band — but a range so wide it spans every possibility tells the seller nothing. For an original, keep the band generous — a tier spans real spread and pretending otherwise is false precision — but never so wide it spans two tiers. If evidence is "a_few", let those prices move the existing estimate only as far as they actually point, and keep the band wide. If evidence is "none", repeat the existing estimate unchanged.
- note: ONE short line under the price saying WHERE it came from. Under 40 characters. Do not say whether the listings were for this item or similar ones — match carries that, and the app words it. Never describe the item — the seller is looking at it, so "Based on Etsy listings for handmade stoneware mugs" wastes its second half saying what they already know. "Based on Etsy listings" is the whole note. Default to "Based on prior listings" and name a marketplace only when one clearly supplied the prices, without reaching for the same one from habit.
  Name at most one marketplace, or none. Say "listed" for active listings and "sold" ONLY for completed sales — never call an asking price a sale.
- source: the ONE marketplace or site that supplied the relevant prices your range is drawn from, by its common name ("Etsy", "eBay", "Saatchi Art"), or "" when they came from several sites or none. Never name a site whose prices you set aside, such as one that only showed a different tier: the seller reads this as where the number came from. A name only, never a sentence.`;

function buildSystemPrompt(basis: AnalyzeResult["valuationBasis"]): string {
  return `You are checking a price estimate against current market information. You get exactly one web search.

${basis === "original" ? ORIGINAL_TASK : RESALE_TASK}

${REPORTING_RULES}`;
}

// A compact text description of the item. This is the whole reason the second
// call is cheap — it replaces the photo entirely.
function describeItem(r: AnalyzeResult): string {
  const lines = [
    `Item: ${r.title}`,
    r.brand ? `Brand: ${r.brand}` : null,
    `Category: ${r.category.replace(/_/g, " ")}`,
    `Condition: ${r.condition.replace(/_/g, " ")}`,
    `Kind: ${r.valuationBasis === "original" ? "original one-of-a-kind piece, sold by its maker" : "mass-produced item being resold secondhand"}`,
    r.craftLevel !== "not_applicable" ? `Craft level (judged from the photo): ${r.craftLevel}` : null,
    `Current estimate: $${r.estimatedValueUSD.low}-${r.estimatedValueUSD.high}`,
  ];
  return lines.filter(Boolean).join("\n");
}

export async function verifyPrice(
  result: AnalyzeResult,
  budgetMs: number = TIMEOUT_MS,
): Promise<VerifyOutcome> {
  const isOriginal = result.valuationBasis === "original";
  const timeout = Math.min(TIMEOUT_MS, budgetMs);

  try {
    const client = new Anthropic({ timeout, maxRetries: 0 });

    const response = await client.messages.create({
      model: MODEL,
      max_tokens: 700,
      thinking: THINKING_OFF,
      system: buildSystemPrompt(result.valuationBasis),
      messages: [{ role: "user", content: describeItem(result) }],
      tools: [
        {
          type: SEARCH_TOOL_VERSION,
          name: "web_search",
          // The hard per-scan cost ceiling. One search, $0.01, no exceptions.
          max_uses: 1,
          // Originals block the print farms; resale allows only real resale
          // marketplaces. The API rejects both fields on one tool, so each mode
          // sets exactly one of them.
          ...(isOriginal
            ? { blocked_domains: ORIGINAL_BLOCKED_DOMAINS }
            : { allowed_domains: RESALE_DOMAINS }),
          // Prices throughout the app are USD.
          user_location: { type: "approximate", country: "US" },
        } satisfies Anthropic.Messages.WebSearchTool20250305,
      ],
      output_config: {
        effort: EFFORT,
        format: {
          type: "json_schema",
          schema: VERIFY_SCHEMA as unknown as Record<string, unknown>,
        },
      },
    });

    // What the call cost whatever came of it — it is billed either way, and the
    // search results it read are most of the bill. For the scan log.
    const searches =
      response.usage.server_tool_use?.web_search_requests ?? 0;
    const costUSD =
      (tokenCostUSD(
        MODEL,
        response.usage.input_tokens,
        response.usage.output_tokens,
      ) ?? 0) +
      searches * SEARCH_COST_USD;

    // A long search can come back paused. We don't continue paused turns — the
    // whole point is to be fast and cheap — so treat it as "no answer".
    if (response.stop_reason === "pause_turn") {
      // The search may well have run, but we never got a verdict, so we have
      // nothing to report about what it found.
      console.log("[verify] paused turn, falling back to the estimate");
      return { ...NOT_SEARCHED, costUSD };
    }

    console.log(
      `[verify] basis=${result.valuationBasis} searches=${searches}` +
        ` in=${response.usage.input_tokens} out=${response.usage.output_tokens}`,
    );

    // No search performed means the model answered from the same pretrained
    // knowledge that produced the estimate. Nothing was verified, and nothing
    // was looked for either.
    if (searches === 0) return { ...NOT_SEARCHED, costUSD };

    // Unlike the single-shot analyze call, a search turn emits SEVERAL text
    // blocks: Claude's "I'll look this up" preamble, then commentary around the
    // tool result, and only last the constrained JSON. Taking content[0] would
    // hand the preamble to JSON.parse. Walk backwards to the last block that
    // actually parses.
    for (let i = response.content.length - 1; i >= 0; i--) {
      const block = response.content[i];
      if (block?.type !== "text") continue;
      try {
        // A search ran and we can read its verdict. Whether that verdict is
        // usable is interpret()'s call, but either way we can honestly say we
        // looked.
        const verdict = interpret(JSON.parse(block.text), result);
        return {
          price: verdict === DISCARDED ? null : verdict,
          searched: true,
          discarded: verdict === DISCARDED,
          costUSD,
        };
      } catch {
        continue;
      }
    }
    // A search ran, but its answer is unreadable — so we do not know what it
    // found and must not characterise it.
    console.log("[verify] no parseable JSON in response");
    return { ...NOT_SEARCHED, costUSD };
  } catch (err) {
    // Includes timeouts and any 400 from an unsupported tool combination.
    console.warn("[verify] failed, keeping the estimate:", err);
    return NOT_SEARCHED;
  }
}

// Nothing ran, or nothing came back we can speak to. The caller serves the
// estimate with no note at all.
const NOT_SEARCHED: VerifyOutcome = { price: null, searched: false };

// Prices came back, but not ones we're willing to show. Kept apart from null
// (nothing usable found) because the seller is told different things.
const DISCARDED = "discarded";

// Turn a raw verification response into a price we're willing to show — or
// null when the search found nothing usable, or DISCARDED when it found prices
// we set aside.
function interpret(
  raw: unknown,
  result: AnalyzeResult,
): VerifiedPrice | typeof DISCARDED | null {
  const r = (raw ?? {}) as Record<string, unknown>;

  const evidence = VERIFY_EVIDENCE.includes(
    r.evidence as (typeof VERIFY_EVIDENCE)[number],
  )
    ? (r.evidence as (typeof VERIFY_EVIDENCE)[number])
    : "none";
  if (evidence === "none") {
    // Log what the search actually turned up. A discard is the common case and
    // the expensive one — we paid for the search and kept the estimate anyway —
    // so this line is the only way to tell an unhelpful search (nothing indexed,
    // wrong market) from an unhelpfully strict bar.
    console.log(`[verify] no usable prices: ${String(r.findings ?? "").slice(0, 600)}`);
    return null;
  }

  const range = (r.rangeUSD ?? {}) as Record<string, unknown>;
  const low = Math.round(toFinite(range.low));
  const high = Math.round(toFinite(range.high));
  if (low <= 0 || high <= 0 || high < low) return DISCARDED;

  // Sanity band: compare midpoints, since a search that widens or tightens a
  // range is fine but one that RELOCATES it has almost certainly mismatched.
  const estMid = (result.estimatedValueUSD.low + result.estimatedValueUSD.high) / 2;
  const newMid = (low + high) / 2;
  if (estMid > 0) {
    const ratio = newMid / estMid;
    if (ratio > SANITY_FACTOR || ratio < 1 / SANITY_FACTOR) {
      console.log(
        `[verify] discarded: $${low}-${high} is ${ratio.toFixed(1)}x the estimate`,
      );
      return DISCARDED;
    }
  }

  const note = cleanText(r.note).slice(0, 80);
  // Anything but a clear "exact" reads as similar: claiming the search found
  // this very item is the stronger statement, so it has to be earned.
  const exact = r.match === "exact";

  // Length backstop. The prompt asks for under 40 characters and mostly gets
  // it, but it drifts — "Based on Etsy listings" one run, "Based on active
  // listings across retail sites" the next. Truncating would leave a mangled
  // half-sentence under the price, so anything over budget falls back to the
  // generic line instead. Nothing is lost: the overflow is always padding, and
  // the note only ever claimed to say where the number came from.
  if (evidence === "a_few") {
    // Worded here, not by the model: a thin result says so in the same few
    // words every time, naming the site only when one clearly supplied them.
    const source = cleanText(r.source);
    return {
      low,
      high,
      note:
        source.length > 0 && source.length <= 25
          ? `Based on a few listings from ${source}`
          : "Based on a few listings",
      strength: "a_few",
    };
  }

  const GENERIC = "Based on prior listings";
  const where = note.length > 0 && note.length <= 40 ? note : GENERIC;
  return {
    low,
    high,
    // Added here rather than asked of the model, so the 40-character budget
    // above stays about the source and the wording never drifts.
    note: exact ? where : `${where} of similar items`,
    strength: "enough",
  };
}

function toFinite(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}
