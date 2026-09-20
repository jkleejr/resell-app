// Turns the scan log (lib/scanlog.ts) into the numbers `npm run report` prints.
// Pure arithmetic over records — no I/O — so it can be tested on its own.
import type { ScanEvent } from "./scanlog.js";

export interface Spread {
  count: number;
  median: number | null;
  p90: number | null;
}

export interface ScanSummary {
  total: number;
  /** First and last record (epoch ms), or null when there are none. */
  from: number | null;
  to: number | null;
  outcomes: Record<string, number>;
  /** Timeouts + errors, over scans that actually ran (capped ones never did). */
  failureRate: number;
  /** Successful scans only, as the user waited for them (ms). */
  duration: { all: Spread; regular: Spread; withSearch: Spread };
  verify: Record<string, number>;
  basis: Record<string, number>;
  /** Originals only. */
  craftLevels: Record<string, number>;
  /** Shares of successful scans. */
  lowConfidenceShare: number;
  genericShare: number;
  brandKnownShare: number;
  categories: Record<string, number>;
  /** Verified scans: how far the search moved the midpoint of the estimate. */
  priceShift: {
    count: number;
    /** e.g. 0.2 = the verified price was typically 20% above the estimate. */
    medianChange: number | null;
    raised: number;
    lowered: number;
  };
  depth: {
    /** Times some device scanned at least once in a day. */
    deviceDays: number;
    scansPerDeviceDay: number;
    /** Device-days by how many scans they reached. */
    buckets: Record<"1" | "2-3" | "4-9" | "10+", number>;
    most: number;
  };
  cost: { totalUSD: number; perScanUSD: number };
  photos: Record<string, number>;
  hintShare: number;
  serverRetries: number;
  /** Scans per UTC day, keyed YYYY-MM-DD. */
  perDay: Record<string, number>;
}

function tally<T>(items: T[], key: (item: T) => string | undefined) {
  const out: Record<string, number> = {};
  for (const item of items) {
    const k = key(item);
    if (k !== undefined) out[k] = (out[k] ?? 0) + 1;
  }
  return out;
}

function median(sorted: number[]): number | null {
  if (sorted.length === 0) return null;
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2
    ? sorted[mid]!
    : (sorted[mid - 1]! + sorted[mid]!) / 2;
}

function spread(values: number[]): Spread {
  const sorted = [...values].sort((a, b) => a - b);
  return {
    count: sorted.length,
    median: median(sorted),
    // Nearest rank: the wait nine scans in ten came in under.
    p90: sorted.length ? sorted[Math.ceil(sorted.length * 0.9) - 1]! : null,
  };
}

const share = (n: number, of: number) => (of ? n / of : 0);
const round = (n: number, places: number) =>
  Math.round(n * 10 ** places) / 10 ** places;

// How heavily people use the app in a day, with no device in the log to group
// by. It falls out of scanOfDay: every device-day that reached N scans left
// exactly one record numbered N. So the count of records numbered N is the
// number of device-days with AT LEAST N scans, and the difference between
// neighbouring counts is the number that stopped at exactly N.
function depth(events: ScanEvent[]): ScanSummary["depth"] {
  const reached = new Map<number, number>();
  for (const e of events) {
    if (e.scanOfDay) reached.set(e.scanOfDay, (reached.get(e.scanOfDay) ?? 0) + 1);
  }
  const buckets = { "1": 0, "2-3": 0, "4-9": 0, "10+": 0 };
  const most = Math.max(0, ...reached.keys());
  for (let n = 1; n <= most; n++) {
    // Clamped: days only partly covered by the log can make this dip below 0.
    const stopped = Math.max(0, (reached.get(n) ?? 0) - (reached.get(n + 1) ?? 0));
    buckets[n === 1 ? "1" : n <= 3 ? "2-3" : n <= 9 ? "4-9" : "10+"] += stopped;
  }
  const deviceDays = reached.get(1) ?? 0;
  const counted = events.filter((e) => e.scanOfDay).length;
  return {
    deviceDays,
    scansPerDeviceDay: share(counted, deviceDays),
    buckets,
    most,
  };
}

export function summarize(events: ScanEvent[]): ScanSummary {
  const oks = events.filter((e) => e.outcome === "ok");
  const outcomes = tally(events, (e) => e.outcome);
  const failed = (outcomes.timeout ?? 0) + (outcomes.error ?? 0);

  const searched = (e: ScanEvent) => e.verifyMs !== undefined;
  const shifts = oks
    .filter((e) => e.verify === "verified" && e.verifiedLow !== undefined)
    .map((e) => {
      const was = (e.low! + e.high!) / 2;
      const now = (e.verifiedLow! + e.verifiedHigh!) / 2;
      return was > 0 ? round(now / was - 1, 3) : 0;
    })
    .sort((a, b) => a - b);
  const shiftMedian = median(shifts);

  const totalCost = events.reduce((sum, e) => sum + (e.costUSD ?? 0), 0);
  const paidScans = events.filter((e) => e.costUSD !== undefined).length;

  return {
    total: events.length,
    from: events.length ? Math.min(...events.map((e) => e.ts)) : null,
    to: events.length ? Math.max(...events.map((e) => e.ts)) : null,
    outcomes,
    failureRate: share(failed, oks.length + failed),
    duration: {
      all: spread(oks.map((e) => e.totalMs)),
      regular: spread(oks.filter((e) => !searched(e)).map((e) => e.totalMs)),
      withSearch: spread(oks.filter(searched).map((e) => e.totalMs)),
    },
    verify: tally(oks, (e) => e.verify),
    basis: tally(oks, (e) => e.basis),
    craftLevels: tally(
      oks.filter((e) => e.basis === "original"),
      (e) => e.craftLevel,
    ),
    lowConfidenceShare: share(oks.filter((e) => e.priceConfidence === "low").length, oks.length),
    genericShare: share(oks.filter((e) => e.specificity === "generic").length, oks.length),
    brandKnownShare: share(oks.filter((e) => e.brandKnown).length, oks.length),
    categories: tally(oks, (e) => e.category),
    priceShift: {
      count: shifts.length,
      medianChange: shiftMedian === null ? null : round(shiftMedian, 3),
      raised: shifts.filter((s) => s > 0).length,
      lowered: shifts.filter((s) => s < 0).length,
    },
    depth: depth(events),
    cost: {
      totalUSD: round(totalCost, 4),
      perScanUSD: round(share(totalCost, paidScans), 4),
    },
    photos: tally(events, (e) => String(e.photos)),
    hintShare: share(events.filter((e) => e.hint).length, events.length),
    serverRetries: events.filter((e) => e.retried).length,
    perDay: tally(events, (e) => new Date(e.ts).toISOString().slice(0, 10)),
  };
}
