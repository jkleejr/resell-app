// The Where to sell payouts. Run: npm test
import assert from "node:assert/strict";
import { test } from "node:test";
import { buildComparison, marketplaceDetails } from "../mobile/pricing.js";

const row = (name: string, anchor: number) =>
  buildComparison(anchor, name, [name]).find((r) => r.name === name)!;

test("The RealReal's 10–80% cut shows its payout as a range", () => {
  const r = row("The RealReal", 50);
  assert.equal(r.feeNote, "10–80%");
  assert.deepEqual(r.netRange, [10, 45]);
  assert.equal(r.net, 28);
  assert.deepEqual(marketplaceDetails("The RealReal"), {
    feeNote: "10–80%",
    feeFree: false,
    shipping: "Ship",
  });
});

test("a single fee rate shows one payout", () => {
  assert.equal(row("Depop", 50).net, 48);
  assert.equal(row("Depop", 50).netRange, undefined);
  assert.equal(row("StockX", 30).net, 26);
  assert.equal(row("StockX", 30).feeNote, "12%");
});

test("Poshmark takes a flat $2.95 under $15 and 20% from $15 up", () => {
  assert.equal(row("Poshmark", 10).net, 7);
  assert.equal(row("Poshmark", 10).feeNote, "$2.95");
  assert.equal(row("Poshmark", 15).net, 12);
  assert.equal(row("Poshmark", 15).feeNote, "20%");
});
