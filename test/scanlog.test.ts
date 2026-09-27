// The scan log, tested through the real /api/analyze handler against in-memory
// stand-ins for Upstash and Anthropic (see fake-services.ts). Run: npm test
import assert from "node:assert/strict";
import { after, before, beforeEach, test } from "node:test";
import { startFakeServices, ORIGINAL_ITEM, type FakeServices } from "./fake-services.js";

const DEVICE = "DEVICE-ABC-123";
const HINT = "SECRETHINT my grandma gave me this";

let fake: FakeServices;
let handleAnalyzeRequest: typeof import("../lib/handler.js").handleAnalyzeRequest;
let readScanEvents: typeof import("../lib/scanlog.js").readScanEvents;

before(async () => {
  fake = await startFakeServices();
  // The lib modules read these once, when first imported — so set them, THEN import.
  process.env.UPSTASH_REDIS_REST_URL = fake.url;
  process.env.UPSTASH_REDIS_REST_TOKEN = "fake-token";
  process.env.ANTHROPIC_BASE_URL = fake.url;
  process.env.ANTHROPIC_API_KEY = "fake-key";
  process.env.ANALYZE_TIMEOUT_MS = "400";
  ({ handleAnalyzeRequest } = await import("../lib/handler.js"));
  ({ readScanEvents } = await import("../lib/scanlog.js"));
});

after(() => fake.close());

beforeEach(() => {
  fake.reset();
  delete process.env.PRICE_VERIFY;
  delete process.env.SCAN_LOG;
});

const scan = (photos = 1, hint?: string) =>
  handleAnalyzeRequest(
    {
      images: Array.from({ length: photos }, () => ({
        image: "aGVsbG8=",
        mediaType: "image/jpeg",
      })),
      hint,
    },
    { deviceId: DEVICE },
  );

test("a successful scan is remembered as one anonymous record of what happened", async () => {
  const before = Date.now();
  const res = await scan(2, HINT);
  assert.equal(res.status, 200);

  const events = await readScanEvents();
  assert.equal(events.length, 1);
  const e = events[0]!;

  assert.equal(e.outcome, "ok");
  assert.ok(e.ts >= before && e.ts <= Date.now());
  assert.equal(e.photos, 2);
  assert.equal(e.hint, true);
  assert.equal(e.category, "clothing");
  assert.equal(e.condition, "good");
  assert.equal(e.specificity, "exact");
  assert.equal(e.basis, "resale");
  assert.equal(e.priceConfidence, "high");
  assert.equal(e.craftLevel, "not_applicable");
  assert.equal(e.brandKnown, true);
  assert.equal(e.low, 25);
  assert.equal(e.high, 40);
  assert.equal(e.verify, "not_eligible");
  assert.equal(e.retried, false);
  assert.equal(e.model, "claude-sonnet-4-6");
  assert.equal(e.inputTokens, 1200);
  assert.equal(e.outputTokens, 200);
  // 1200 in × $3/M + 200 out × $15/M
  assert.equal(e.costUSD, 0.0066);
  assert.ok(typeof e.totalMs === "number" && e.totalMs >= 0);
  assert.ok(typeof e.visionMs === "number" && e.visionMs <= e.totalMs);
});

test("the record holds nothing that identifies the person, the device, or the item's text", async () => {
  await scan(1, HINT);

  const stored = JSON.stringify(fake.store.get("scanlog"));
  assert.ok(stored.length > 20, "expected a stored record to inspect");
  for (const secret of [DEVICE, "SECRETTITLE", "SECRETBRAND", "SECRETHINT", "aGVsbG8="]) {
    assert.ok(!stored.includes(secret), `scan log must not contain ${secret}`);
  }
});

test("records how many scans the device had made that day, without the device", async () => {
  await scan();
  await scan();
  await scan();

  const events = await readScanEvents();
  assert.deepEqual(
    events.map((e) => e.scanOfDay),
    [1, 2, 3],
  );
});

test("an original that a web search repriced keeps both the estimate and the verified range", async () => {
  process.env.PRICE_VERIFY = "on";
  fake.visionItem = ORIGINAL_ITEM;

  const res = await scan();
  assert.equal(res.body.priceBasis, "verified");

  const [e] = await readScanEvents();
  assert.equal(e!.basis, "original");
  assert.equal(e!.craftLevel, "competent");
  assert.equal(e!.brandKnown, false);
  assert.equal(e!.verify, "verified");
  assert.deepEqual([e!.low, e!.high], [60, 120]);
  assert.deepEqual([e!.verifiedLow, e!.verifiedHigh], [90, 150]);
  assert.ok(typeof e!.verifyMs === "number");
  // vision $0.0066 + verify (9000 in × $3/M + 200 out × $15/M + one $0.01 search)
  assert.equal(e!.costUSD, 0.0466);
});

test("a web search whose findings were discarded is recorded as no_listings", async () => {
  process.env.PRICE_VERIFY = "on";
  fake.visionItem = ORIGINAL_ITEM;
  fake.verifyReply = { ...fake.verifyReply, confidence: "low" };

  await scan();

  const [e] = await readScanEvents();
  assert.equal(e!.verify, "no_listings");
  assert.equal(e!.verifiedLow, undefined);
});

test("a web search skipped because the device's allowance is spent is recorded as no_allowance", async () => {
  process.env.PRICE_VERIFY = "on";
  fake.visionItem = ORIGINAL_ITEM;
  const day = new Date().toISOString().slice(0, 10).replace(/-/g, "");
  fake.store.set(`search:${DEVICE}:${day}`, 25);

  await scan();

  const [e] = await readScanEvents();
  assert.equal(e!.verify, "no_allowance");
});

test("a scan that fails is recorded as an error with no item details", async () => {
  fake.visionFailStatus = 400;

  const res = await scan();
  assert.equal(res.status, 502);

  const [e] = await readScanEvents();
  assert.equal(e!.outcome, "error");
  assert.equal(e!.photos, 1);
  assert.equal(e!.category, undefined);
  assert.equal(e!.low, undefined);
});

test("a scan the server had to retry says so", async () => {
  fake.visionStallFirstMs = 900; // past ANALYZE_TIMEOUT_MS=400, so attempt one times out

  const res = await scan();
  assert.equal(res.status, 200);

  const [e] = await readScanEvents();
  assert.equal(e!.outcome, "ok");
  assert.equal(e!.retried, true);
});

test("a scan blocked by the daily cap is recorded as capped", async () => {
  const day = new Date().toISOString().slice(0, 10).replace(/-/g, "");
  fake.store.set(`usage:${DEVICE}:${day}`, 100);

  const res = await scan();
  assert.equal(res.status, 429);

  const [e] = await readScanEvents();
  assert.equal(e!.outcome, "capped");
  assert.equal(e!.scanOfDay, 101);
  assert.equal(fake.visionCalls, 0);
});

test("a rejected request (no image) is not a scan and is not recorded", async () => {
  const res = await handleAnalyzeRequest({ images: [] }, { deviceId: DEVICE });
  assert.equal(res.status, 400);
  assert.deepEqual(await readScanEvents(), []);
});

const scanAs = (attempt: unknown) =>
  handleAnalyzeRequest(
    { images: [{ image: "aGVsbG8=", mediaType: "image/jpeg" }], attempt },
    { deviceId: DEVICE },
  );

test("records why the user ran the scan: new, a retry, or an added photo", async () => {
  await scanAs("new");
  await scanAs("retry");
  await scanAs("add_photo");
  const events = await readScanEvents();
  assert.deepEqual(
    events.map((e) => e.attempt),
    ["new", "retry", "add_photo"],
  );
});

test("an unknown or missing attempt label is left out, never logged as sent", async () => {
  await scanAs("my secret note");
  await scanAs(42);
  await scan(); // older apps send no label at all
  const events = await readScanEvents();
  assert.equal(events.length, 3);
  for (const e of events) assert.equal("attempt" in e, false);
  assert.ok(!JSON.stringify(events).includes("secret"));
});

test("SCAN_LOG=off turns recording off", async () => {
  process.env.SCAN_LOG = "off";
  const res = await scan();
  assert.equal(res.status, 200);
  assert.deepEqual(await readScanEvents(), []);
});

test("the scan still succeeds when the log store is down", async () => {
  fake.upstashDown = true;
  const res = await scan();
  assert.equal(res.status, 200);
  assert.equal(res.body.category, "clothing");
});

test("a slow log store holds a scan up by no more than about a second and a half", async () => {
  fake.rpushDelayMs = 3000;
  const started = Date.now();
  const res = await scan();
  assert.equal(res.status, 200);
  assert.ok(Date.now() - started < 2500, `scan took ${Date.now() - started}ms`);
});
