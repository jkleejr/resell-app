// Which marketplace a scan may recommend, tested through the real handler
// against the fake Anthropic (see fake-services.ts). Run: npm test
import assert from "node:assert/strict";
import { after, before, beforeEach, test } from "node:test";
import { startFakeServices, RESALE_ITEM, type FakeServices } from "./fake-services.js";

let fake: FakeServices;
let handleAnalyzeRequest: typeof import("../lib/handler.js").handleAnalyzeRequest;

before(async () => {
  fake = await startFakeServices();
  process.env.UPSTASH_REDIS_REST_URL = fake.url;
  process.env.UPSTASH_REDIS_REST_TOKEN = "fake-token";
  process.env.ANTHROPIC_BASE_URL = fake.url;
  process.env.ANTHROPIC_API_KEY = "fake-key";
  process.env.ANALYZE_TIMEOUT_MS = "400";
  ({ handleAnalyzeRequest } = await import("../lib/handler.js"));
});

after(() => fake.close());

beforeEach(() => fake.reset());

// The model "recommends" `pick`; the request carries the seller's settings.
async function scanPicking(pick: string, settings: Record<string, unknown> = {}) {
  fake.visionItem = { ...RESALE_ITEM, recommendedPlatform: pick };
  const res = await handleAnalyzeRequest(
    { images: [{ image: "aGVsbG8=", mediaType: "image/jpeg" }], ...settings },
    { deviceId: "DEVICE-MARKETS" },
  );
  assert.equal(res.status, 200);
  return res.body as { recommendedPlatform: string; recommendationReason: string };
}

test("a pick from the seller's marketplaces is kept", async () => {
  const body = await scanPicking("Etsy", { marketplaces: ["Etsy", "eBay"] });
  assert.equal(body.recommendedPlatform, "Etsy");
  assert.equal(body.recommendationReason, RESALE_ITEM.recommendationReason);
});

test("a pick the seller turned off becomes their first marketplace, without its reason", async () => {
  // "First" in the app's own order, whatever order the request lists them in.
  const body = await scanPicking("Poshmark", { marketplaces: ["Etsy", "eBay"] });
  assert.equal(body.recommendedPlatform, "eBay");
  assert.equal(body.recommendationReason, "");
});

test("names are matched regardless of case", async () => {
  const body = await scanPicking("ebay", { marketplaces: ["Etsy", "eBay"] });
  assert.equal(body.recommendedPlatform, "eBay");
});

test("with other marketplaces on, an unlisted site is kept", async () => {
  const body = await scanPicking("Reverb", {
    marketplaces: ["eBay"],
    otherMarketplaces: true,
  });
  assert.equal(body.recommendedPlatform, "Reverb");
  assert.equal(body.recommendationReason, RESALE_ITEM.recommendationReason);
});

test("with other marketplaces off, an unlisted site is replaced", async () => {
  const body = await scanPicking("Reverb", {
    marketplaces: ["eBay"],
    otherMarketplaces: false,
  });
  assert.equal(body.recommendedPlatform, "eBay");
});

test("an app that sends no settings only ever gets the original seven", async () => {
  // Installed 1.0.x builds have no row for these, so they must never see them.
  for (const pick of ["Etsy", "StockX", "Reverb"]) {
    const body = await scanPicking(pick);
    assert.equal(body.recommendedPlatform, "Facebook Marketplace");
  }
  assert.equal((await scanPicking("Mercari")).recommendedPlatform, "Mercari");
});

test("unknown names in the seller's list are ignored", async () => {
  const body = await scanPicking("Poshmark", { marketplaces: ["Nope", "StockX"] });
  assert.equal(body.recommendedPlatform, "StockX");
});
