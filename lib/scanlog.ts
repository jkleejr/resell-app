// The scan log: one small anonymous record per scan, so we can see how the app
// is actually used — how long scans take, how often the web search runs, what
// kinds of things people scan, how often a scan fails.
//
// The privacy line is drawn HERE, and it is a whitelist. A record is only ever
// built from the fields named in ScanEvent, so nothing reaches the log by
// default — a new field on the analyze result stays out until someone adds it
// below on purpose. What is deliberately NOT in a record:
//   - the device id, in any form (not even hashed) — records cannot be linked
//     to a device, or to each other
//   - the photos
//   - the user's hint text (only whether there was one)
//   - the item's title, brand name, keywords, description — any free text the
//     model wrote about the thing in the photo. Category is as close as it gets.
//   - IP address, location, app-store identity
// test/scanlog.test.ts holds the line: it fails if any of those show up.
//
// Stored as a Redis list in the same Upstash DB as the counters. Best-effort
// and FAILS OPEN like the scan gate: a log write that errors or stalls is
// dropped, never allowed to break or noticeably slow a scan.
import type {
  AnalyzeResult,
  Category,
  Condition,
  CraftLevel,
  PriceConfidence,
  Specificity,
  ValuationBasis,
} from "./schema.js";
import { configured, pipeline } from "./usage.js";

const KEY = "scanlog";

// The function has to wait for the write — Vercel freezes it the moment the
// response is sent — so this is the most a slow store can add to a scan.
// A healthy write is ~30ms.
const WRITE_TIMEOUT_MS = 1_500;

const READ_CHUNK = 1_000;

/** What became of the optional web-search price check on this scan. */
export type VerifyStatus =
  /** Not an original over the minimum value, or the feature is off. */
  | "not_eligible"
  /** Eligible, but too little of the request's deadline was left to start. */
  | "no_time"
  /** Eligible, but the device had spent its daily search allowance. */
  | "no_allowance"
  /** Attempted, but no verdict came back: timed out, errored, or never searched. */
  | "not_searched"
  /** Searched, and the findings were not good enough to replace the estimate. */
  | "no_listings"
  /** Searched, and a few listings moved the price; shown without the tick. */
  | "few_listings"
  /** Searched, and the price shown is the verified one. */
  | "verified";

/**
 * Why the user ran this scan, as the app labels it. Absent on scans from an app
 * that predates the label (1.0.3, and the 1.0.4 binary until its OTA update
 * arrives) and from the CLI.
 */
export type ScanAttempt =
  /** A fresh scan from the compose screen. */
  | "new"
  /** "Try again" after a failed scan — the same photos, re-sent. */
  | "retry"
  /** "Add a photo & retry" after a generic result — the photos plus more. */
  | "add_photo";

export const SCAN_ATTEMPTS: readonly ScanAttempt[] = ["new", "retry", "add_photo"];

export interface ScanEvent {
  /**
   * The UTC day of the scan, as epoch ms at 00:00 UTC — the date only, never
   * the time of day. (Records written before this change hold the exact time;
   * readers only ever look at the day.)
   */
  ts: number;
  /**
   * "capped" = blocked by a daily limit before any model call.
   * "refused" = the model declined to analyze the photos (stop_reason
   * "refusal"), told apart from "error" so the report can say how often it
   * happens.
   */
  outcome: "ok" | "timeout" | "error" | "capped" | "refused";
  /** Whole request, as the user waited for it. */
  totalMs: number;
  photos: number;
  /** Whether a hint was typed — never the hint itself. */
  hint: boolean;
  /** The device's Nth scan of the UTC day. A count, not an identity. */
  scanOfDay?: number;
  /** Why the user ran it. A label, so a retry is visible without linking records. */
  attempt?: ScanAttempt;

  // --- The vision call. Absent on a capped scan.
  visionMs?: number;
  /** The server's own one retry after a stalled/failed first attempt. */
  retried?: boolean;
  model?: string;
  inputTokens?: number;
  outputTokens?: number;
  /** Everything this scan cost us: vision, plus the price check if it ran. */
  costUSD?: number;
  /**
   * Only on outcome "refused": the safety category the API gave ("cyber",
   * "bio", "frontier_llm", "reasoning_extraction", "general_harms"), or "none"
   * when it gave none. A category, never anything about the photo.
   */
  refusalCategory?: string;

  // --- What the scan concluded. Only on outcome "ok".
  category?: Category;
  condition?: Condition;
  specificity?: Specificity;
  basis?: ValuationBasis;
  priceConfidence?: PriceConfidence;
  craftLevel?: CraftLevel;
  /** Whether a brand was identified — never which. */
  brandKnown?: boolean;
  /** The model's own estimate, before any verification. */
  low?: number;
  high?: number;

  // --- The price check. Only on outcome "ok".
  verify?: VerifyStatus;
  /** Time spent on the price check, when one was attempted. */
  verifyMs?: number;
  /** The range the search put in place of the estimate. */
  verifiedLow?: number;
  verifiedHigh?: number;
}

/** The loggable part of an analyze result. See the whitelist note above. */
export function itemFacts(r: AnalyzeResult): Partial<ScanEvent> {
  return {
    category: r.category,
    condition: r.condition,
    specificity: r.specificity,
    basis: r.valuationBasis,
    priceConfidence: r.priceConfidence,
    craftLevel: r.craftLevel,
    brandKnown: r.brand !== "",
    low: r.estimatedValueUSD.low,
    high: r.estimatedValueUSD.high,
  };
}

// On unless switched off, wherever the counters are on.
function enabled(): boolean {
  return process.env.SCAN_LOG !== "off" && configured();
}

const DAY_MS = 86_400_000;

/** Midnight UTC of the day `ms` falls in — the same day `scanOfDay` counts in. */
export function startOfUTCDay(ms: number): number {
  return ms - (ms % DAY_MS);
}

export async function recordScan(event: Omit<ScanEvent, "ts">): Promise<void> {
  if (!enabled()) return;
  try {
    const record: ScanEvent = { ts: startOfUTCDay(Date.now()), ...event };
    await pipeline([["RPUSH", KEY, JSON.stringify(record)]], WRITE_TIMEOUT_MS);
  } catch (err) {
    // pipeline() already swallows its own failures; this is for anything else.
    // The caller is mid-scan and must never see the log throw.
    console.warn("[scanlog] record dropped:", err);
  }
}

/** Every record, oldest first. For the report script — nothing serves this. */
export async function readScanEvents(): Promise<ScanEvent[]> {
  if (!configured()) return [];
  const events: ScanEvent[] = [];
  for (let start = 0; ; start += READ_CHUNK) {
    const out = await pipeline([["LRANGE", KEY, start, start + READ_CHUNK - 1]]);
    if (!out) throw new Error("Could not read the scan log from Upstash");
    const rows = (out[0] as { result?: unknown })?.result;
    if (!Array.isArray(rows) || rows.length === 0) break;
    for (const row of rows) {
      try {
        events.push(JSON.parse(String(row)) as ScanEvent);
      } catch {
        // One unreadable row is not worth losing the report over.
      }
    }
    if (rows.length < READ_CHUNK) break;
  }
  return events;
}
