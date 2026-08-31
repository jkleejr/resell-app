// Does the web-search pass actually make prices BETTER? This is how you find
// out before turning it on in production.
//
// It skips the photo entirely and feeds lib/verify.ts a hand-written item, so
// you can run a dozen items you already know the real value of for a few cents
// and compare. That comparison is the whole point — without it you'd be paying
// a cent a scan to change numbers you can't tell are improving.
//
//   npm run verify-test                     # the built-in sample items
//   npm run verify-test -- "Levi's 501 dark wash men's 32x32" 28 45
//   npm run verify-test -- "Original acrylic shark painting, 16x20 canvas" 50 80 original
//
// Cost: about a cent per item. Needs ANTHROPIC_API_KEY.
import { verifyPrice } from "../lib/verify.js";
import type { AnalyzeResult, ValuationBasis } from "../lib/schema.js";

// Stands in for a real analyze result. Only the fields lib/verify.ts reads are
// meaningful; the rest are filler to satisfy the type.
function fakeResult(
  title: string,
  low: number,
  high: number,
  basis: ValuationBasis,
): AnalyzeResult {
  return {
    title,
    category: "other",
    brand: "",
    condition: basis === "original" ? "new" : "good",
    keywords: [],
    searchQuery: title,
    specificity: basis === "original" ? "generic" : "exact",
    valuationBasis: basis,
    priceConfidence: "low",
    // Solid amateur work — the tier most things people make at home land in,
    // and the one worth testing since it's where a wrong tier costs the most.
    craftLevel: basis === "original" ? "competent" : "not_applicable",
    estimatedValueUSD: { low, high },
    listingDescription: "",
    recommendedPlatform: "eBay",
    recommendationReason: "",
    expectedSpeed: "moderate",
    priceBasis: "estimate",
    priceNote: "",
  };
}

// A spread worth checking: one item the model should already know well (search
// should change little), and two where its knowledge is genuinely thin.
const SAMPLES: [string, number, number, ValuationBasis][] = [
  ["Levi's 501 Original Fit jeans, dark wash, men's 32x32", 28, 45, "resale"],
  ["Original acrylic shark painting on canvas, 16x20, unframed, signed", 50, 80, "original"],
  ["Hand-thrown stoneware mug, speckled cream glaze, 12oz", 20, 40, "original"],
];

async function main(): Promise<void> {
  if (!process.env.ANTHROPIC_API_KEY) {
    console.error("ANTHROPIC_API_KEY is not set.");
    process.exit(1);
  }

  const args = process.argv.slice(2);
  const items: [string, number, number, ValuationBasis][] =
    args.length >= 3
      ? [[
          args[0] ?? "",
          Number(args[1]),
          Number(args[2]),
          (args[3] === "original" ? "original" : "resale") as ValuationBasis,
        ]]
      : SAMPLES;

  for (const [title, low, high, basis] of items) {
    const item = fakeResult(title, low, high, basis);
    console.log(`\n── ${title}`);
    console.log(`   basis:    ${basis}`);
    console.log(`   estimate: $${low}-${high}`);

    const started = Date.now();
    const verified = await verifyPrice(item);
    const elapsed = ((Date.now() - started) / 1000).toFixed(1);

    if (!verified) {
      console.log(`   verified: (none — kept the estimate)   ${elapsed}s`);
      continue;
    }
    const shift = (
      ((verified.low + verified.high) / 2 - (low + high) / 2) /
      ((low + high) / 2)
    ) * 100;
    console.log(
      `   verified: $${verified.low}-${verified.high}` +
        `  (${shift >= 0 ? "+" : ""}${shift.toFixed(0)}%)   ${elapsed}s`,
    );
    console.log(`   note:     ${verified.note}`);
  }

  console.log(
    "\nThe question to answer: are the verified numbers CLOSER to what you\n" +
      "know these are worth? If not, leave PRICE_VERIFY off.\n",
  );
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
