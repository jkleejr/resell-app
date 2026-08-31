import Anthropic from "@anthropic-ai/sdk";
import {
  PRICE_CONFIDENCE,
  VERIFY_SCHEMA,
  type AnalyzeResult,
  type VerifiedPrice,
} from "./schema.js";

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

const MODEL = process.env.VERIFY_MODEL ?? "claude-sonnet-4-6";

// Total wall-clock budget for the whole verification, including the search.
// Past this we abandon it and serve the estimate — a slow scan is a worse
// product than an unverified one.
const TIMEOUT_MS = Number(process.env.VERIFY_TIMEOUT_MS ?? 9_000);

// Basic (direct) web search rather than the newer dynamic-filtering versions.
// Dynamic filtering runs the search from inside code execution and would cut
// the result tokens further, but it stacks code execution on top of structured
// outputs and server tools, and we can't verify that combination works before
// shipping. Start with the combination we can reason about; the token savings
// are the obvious next optimization if this proves useful.
const SEARCH_TOOL_VERSION = "web_search_20250305";

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

// Originals are priced against what comparable independent work asks, so the
// useful sources are primary marketplaces for makers, not resale marketplaces.
const ORIGINAL_DOMAINS = [
  "etsy.com",
  "saatchiart.com",
  "artfinder.com",
  "singulart.com",
  "fineartamerica.com",
];

// A refined range this far from the model's own estimate almost always means
// the search matched the wrong thing — a different product, a retail page, a
// print instead of an original. Discard rather than trust it.
const SANITY_FACTOR = 3;

const RESALE_TASK = `Search ONCE for what this item has actually SOLD for recently on the secondhand market.

You want completed/sold prices from private sellers. Ignore new and retail prices — the retail price of a product tells you almost nothing about what a used one fetches, and anchoring on it is the specific mistake this check exists to catch.`;

const ORIGINAL_TASK = `This is a one-of-a-kind piece made by the person selling it. There is no comparable sale for this exact piece and you should not look for one.

Search ONCE for what COMPARABLE original work currently sells for: same medium, similar size, an independent maker without an established name or following. You are calibrating a price band for work of this kind, not finding a match for this piece.

Assume the maker has no established sales history unless told otherwise. Their audience, not the object, drives the top of the range.`;

function buildSystemPrompt(basis: AnalyzeResult["valuationBasis"]): string {
  return `You are checking a price estimate against current market information. You get exactly one web search.

${basis === "original" ? ORIGINAL_TASK : RESALE_TASK}

Then report, in this order:
- findings: what the search actually showed — the prices you saw and where. One or two sentences. If the results were thin, off-target, or retail rather than resale, say so plainly.
- confidence: "high" ONLY if the results genuinely support a price band for this item. "low" if they were thin, irrelevant, retail rather than secondhand, or about a different product. When in doubt choose "low": the existing estimate is kept and nothing is lost. An unhelpful search is normal and reporting it honestly is the correct outcome.
- rangeUSD: your refined whole-dollar range, low < high. If confidence is "low", repeat the existing estimate unchanged.
- note: ONE short factual line telling the seller what backs the number, under 60 characters. For example "Based on 4 recent sold listings" or "Based on comparable originals on Etsy". State the source, not the price. Never hedge.`;
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
    `Current estimate: $${r.estimatedValueUSD.low}-${r.estimatedValueUSD.high}`,
  ];
  return lines.filter(Boolean).join("\n");
}

export async function verifyPrice(
  result: AnalyzeResult,
): Promise<VerifiedPrice | null> {
  const isOriginal = result.valuationBasis === "original";

  try {
    const client = new Anthropic({ timeout: TIMEOUT_MS, maxRetries: 0 });

    const response = await client.messages.create({
      model: MODEL,
      max_tokens: 700,
      thinking: { type: "disabled" },
      system: buildSystemPrompt(result.valuationBasis),
      messages: [{ role: "user", content: describeItem(result) }],
      tools: [
        {
          type: SEARCH_TOOL_VERSION,
          name: "web_search",
          // The hard per-scan cost ceiling. One search, $0.01, no exceptions.
          max_uses: 1,
          allowed_domains: isOriginal ? ORIGINAL_DOMAINS : RESALE_DOMAINS,
          // Prices throughout the app are USD.
          user_location: { type: "approximate", country: "US" },
        } satisfies Anthropic.Messages.WebSearchTool20250305,
      ],
      output_config: {
        format: {
          type: "json_schema",
          schema: VERIFY_SCHEMA as unknown as Record<string, unknown>,
        },
      },
    });

    // A long search can come back paused. We don't continue paused turns — the
    // whole point is to be fast and cheap — so treat it as "no answer".
    if (response.stop_reason === "pause_turn") {
      console.log("[verify] paused turn, falling back to the estimate");
      return null;
    }

    const searches =
      response.usage.server_tool_use?.web_search_requests ?? 0;
    console.log(
      `[verify] basis=${result.valuationBasis} searches=${searches}` +
        ` in=${response.usage.input_tokens} out=${response.usage.output_tokens}`,
    );

    // No search performed means the model answered from the same pretrained
    // knowledge that produced the estimate. Nothing was verified.
    if (searches === 0) return null;

    // Unlike the single-shot analyze call, a search turn emits SEVERAL text
    // blocks: Claude's "I'll look this up" preamble, then commentary around the
    // tool result, and only last the constrained JSON. Taking content[0] would
    // hand the preamble to JSON.parse. Walk backwards to the last block that
    // actually parses.
    for (let i = response.content.length - 1; i >= 0; i--) {
      const block = response.content[i];
      if (block?.type !== "text") continue;
      try {
        return interpret(JSON.parse(block.text), result);
      } catch {
        continue;
      }
    }
    console.log("[verify] no parseable JSON in response");
    return null;
  } catch (err) {
    // Includes timeouts and any 400 from an unsupported tool combination.
    console.warn("[verify] failed, keeping the estimate:", err);
    return null;
  }
}

// Turn a raw verification response into a price we're willing to show — or null.
function interpret(
  raw: unknown,
  result: AnalyzeResult,
): VerifiedPrice | null {
  const r = (raw ?? {}) as Record<string, unknown>;

  const confidence = PRICE_CONFIDENCE.includes(
    r.confidence as (typeof PRICE_CONFIDENCE)[number],
  )
    ? (r.confidence as string)
    : "low";
  if (confidence !== "high") return null;

  const range = (r.rangeUSD ?? {}) as Record<string, unknown>;
  const low = Math.round(toFinite(range.low));
  const high = Math.round(toFinite(range.high));
  if (low <= 0 || high <= 0 || high < low) return null;

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
      return null;
    }
  }

  const note = typeof r.note === "string"
    ? r.note.replace(/[\u0000-\u001F\u007F]/g, " ").replace(/<[^>]*>/g, " ")
        .replace(/\s+/g, " ").trim().slice(0, 80)
    : "";

  return { low, high, note: note || "Checked against current listings" };
}

function toFinite(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}
