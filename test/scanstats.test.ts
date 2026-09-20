// The arithmetic behind `npm run report`. Run: npm test
import assert from "node:assert/strict";
import { test } from "node:test";
import type { ScanEvent } from "../lib/scanlog.js";
import { summarize } from "../lib/scanstats.js";

const DAY1 = Date.UTC(2026, 8, 21, 15, 0, 0);
const DAY2 = Date.UTC(2026, 8, 22, 15, 0, 0);

function ok(over: Partial<ScanEvent> = {}): ScanEvent {
  return {
    ts: DAY1,
    outcome: "ok",
    totalMs: 6000,
    photos: 1,
    hint: false,
    scanOfDay: 1,
    visionMs: 5800,
    retried: false,
    model: "claude-sonnet-4-6",
    costUSD: 0.01,
    category: "clothing",
    condition: "good",
    specificity: "exact",
    basis: "resale",
    priceConfidence: "high",
    craftLevel: "not_applicable",
    brandKnown: true,
    low: 20,
    high: 40,
    verify: "not_eligible",
    ...over,
  };
}

test("an empty log summarizes to zero scans rather than crashing", () => {
  const s = summarize([]);
  assert.equal(s.total, 0);
  assert.equal(s.failureRate, 0);
  assert.equal(s.duration.all.median, null);
});

test("counts outcomes, and the failure rate ignores scans blocked by the cap", () => {
  const s = summarize([
    ok(),
    ok(),
    ok(),
    { ts: DAY1, outcome: "error", totalMs: 900, photos: 1, hint: false },
    { ts: DAY1, outcome: "timeout", totalMs: 42000, photos: 1, hint: false },
    { ts: DAY1, outcome: "capped", totalMs: 40, photos: 1, hint: false, scanOfDay: 101 },
  ]);
  assert.equal(s.total, 6);
  assert.deepEqual(s.outcomes, { ok: 3, timeout: 1, error: 1, capped: 1 });
  assert.equal(s.failureRate, 2 / 5);
});

test("splits scan time into regular scans and scans that ran a web search", () => {
  const s = summarize([
    ok({ totalMs: 5000 }),
    ok({ totalMs: 6000 }),
    ok({ totalMs: 7000 }),
    ok({ totalMs: 20000, verify: "verified", verifyMs: 13000 }),
    ok({ totalMs: 24000, verify: "no_listings", verifyMs: 17000 }),
  ]);
  assert.equal(s.duration.regular.median, 6000);
  assert.equal(s.duration.regular.count, 3);
  assert.equal(s.duration.withSearch.median, 22000);
  assert.equal(s.duration.withSearch.count, 2);
  assert.equal(s.duration.all.median, 7000);
  assert.deepEqual(s.verify, { not_eligible: 3, verified: 1, no_listings: 1 });
});

test("reports what was scanned: basis, confidence, identification, categories", () => {
  const s = summarize([
    ok(),
    ok({ category: "shoes", priceConfidence: "low", specificity: "generic", brandKnown: false }),
    ok({ category: "home_decor", basis: "original", craftLevel: "competent", priceConfidence: "low", brandKnown: false, specificity: "generic" }),
    ok({ category: "clothing" }),
  ]);
  assert.deepEqual(s.basis, { resale: 3, original: 1 });
  assert.deepEqual(s.craftLevels, { competent: 1 });
  assert.equal(s.lowConfidenceShare, 0.5);
  assert.equal(s.genericShare, 0.5);
  assert.equal(s.brandKnownShare, 0.5);
  assert.deepEqual(s.categories, { clothing: 2, shoes: 1, home_decor: 1 });
});

test("measures how far a web search moved the price", () => {
  const s = summarize([
    // estimate mid 100 → verified mid 150: moved +50%
    ok({ low: 80, high: 120, verify: "verified", verifyMs: 9000, verifiedLow: 120, verifiedHigh: 180 }),
    // estimate mid 100 → verified mid 90: moved -10%
    ok({ low: 80, high: 120, verify: "verified", verifyMs: 9000, verifiedLow: 80, verifiedHigh: 100 }),
    ok(),
  ]);
  assert.equal(s.priceShift.count, 2);
  assert.equal(s.priceShift.medianChange, 0.2);
  assert.equal(s.priceShift.raised, 1);
  assert.equal(s.priceShift.lowered, 1);
});

test("works out how much people scan in a day from the scan-of-day counts alone", () => {
  // Day 1: one device scans 4 times, another scans once. Day 2: one device, 2 scans.
  const s = summarize([
    ok({ ts: DAY1, scanOfDay: 1 }),
    ok({ ts: DAY1, scanOfDay: 2 }),
    ok({ ts: DAY1, scanOfDay: 3 }),
    ok({ ts: DAY1, scanOfDay: 4 }),
    ok({ ts: DAY1, scanOfDay: 1 }),
    ok({ ts: DAY2, scanOfDay: 1 }),
    ok({ ts: DAY2, scanOfDay: 2 }),
  ]);
  assert.equal(s.depth.deviceDays, 3);
  assert.equal(s.depth.scansPerDeviceDay, 7 / 3);
  assert.deepEqual(s.depth.buckets, { "1": 1, "2-3": 1, "4-9": 1, "10+": 0 });
  assert.equal(s.depth.most, 4);
});

test("totals cost, photos, hints, server retries, and scans per day", () => {
  const s = summarize([
    ok({ ts: DAY1, costUSD: 0.0066, photos: 1 }),
    ok({ ts: DAY1, costUSD: 0.0466, photos: 3, hint: true, retried: true }),
    ok({ ts: DAY2, costUSD: 0.0068, photos: 1 }),
  ]);
  assert.equal(s.cost.totalUSD, 0.06);
  assert.equal(s.cost.perScanUSD, 0.02);
  assert.deepEqual(s.photos, { "1": 2, "3": 1 });
  assert.equal(s.hintShare, 1 / 3);
  assert.equal(s.serverRetries, 1);
  assert.deepEqual(s.perDay, { "2026-09-21": 2, "2026-09-22": 1 });
  assert.equal(s.from, DAY1);
  assert.equal(s.to, DAY2);
});
