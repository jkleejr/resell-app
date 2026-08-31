// Per-device daily cap, global scan counters, and the price-verification
// budget/cache — all backed by Upstash Redis (REST).
//
// The backend is public, so anyone with the app URL can call /api/analyze and
// spend our Anthropic credits. This module limits that:
//   - per-device daily cap: one device gets at most DAILY_DEVICE_CAP scans/UTC-day
//   - all-time total counter: cumulative scans across everyone (for the stats UI)
//   - optional global daily cap: at most GLOBAL_DAILY_CAP scans/UTC-day across ALL
//     users — a circuit breaker on total daily spend. OFF unless the env var is set.
//
// The Anthropic monthly spend limit is the hard backstop. This is best-effort and
// FAILS OPEN: if Upstash isn't configured or is unreachable, scans are allowed so
// a KV blip never breaks the app.

const REST_URL = process.env.UPSTASH_REDIS_REST_URL;
const REST_TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN;
const DEVICE_CAP = Number(process.env.DAILY_DEVICE_CAP ?? 60);
const GLOBAL_DAILY_CAP = process.env.GLOBAL_DAILY_CAP
  ? Number(process.env.GLOBAL_DAILY_CAP)
  : null;

// ~2 days; the date embedded in each daily key is what actually resets the count
// at UTC midnight — the TTL is just housekeeping so old keys don't pile up.
const KEY_TTL_SECONDS = 172_800;

export interface ScanGate {
  allowed: boolean;
  /** Set when blocked, so the caller can return a helpful message. */
  reason?: "device" | "global";
  limit?: number;
}

function utcDay(): string {
  return new Date().toISOString().slice(0, 10).replace(/-/g, ""); // e.g. 20260624
}

function configured(): boolean {
  return Boolean(REST_URL && REST_TOKEN);
}

// Run an Upstash REST pipeline; returns the results array, or null on any error.
async function pipeline(
  commands: (string | number)[][],
): Promise<unknown[] | null> {
  try {
    const res = await fetch(`${REST_URL}/pipeline`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${REST_TOKEN}`,
        "content-type": "application/json",
      },
      body: JSON.stringify(commands),
    });
    if (!res.ok) throw new Error(`Upstash responded ${res.status}`);
    return (await res.json()) as unknown[];
  } catch (err) {
    console.warn("[usage] Upstash request failed:", err);
    return null;
  }
}

function resultInt(entry: unknown): number {
  const r = (entry as { result?: unknown })?.result;
  return typeof r === "number" ? r : 0;
}

// Enforce caps for one scan attempt and bump counters. Fail-open.
export async function checkAndRecordScan(
  deviceId: string | undefined,
): Promise<ScanGate> {
  if (!configured()) return { allowed: true };

  const day = utcDay();
  const id = (deviceId ?? "").trim() || "unknown";

  // Gating increments: per-device-day, and (optionally) global-day.
  const cmds: (string | number)[][] = [
    ["INCR", `usage:${id}:${day}`],
    ["EXPIRE", `usage:${id}:${day}`, KEY_TTL_SECONDS],
  ];
  if (GLOBAL_DAILY_CAP !== null) {
    cmds.push(
      ["INCR", `scans:day:${day}`],
      ["EXPIRE", `scans:day:${day}`, KEY_TTL_SECONDS],
    );
  }

  const out = await pipeline(cmds);
  if (!out) return { allowed: true }; // fail open on KV error

  const deviceUsed = resultInt(out[0]);
  if (deviceUsed > DEVICE_CAP) {
    return { allowed: false, reason: "device", limit: DEVICE_CAP };
  }
  if (GLOBAL_DAILY_CAP !== null) {
    const globalUsed = resultInt(out[2]);
    if (globalUsed > GLOBAL_DAILY_CAP) {
      return { allowed: false, reason: "global", limit: GLOBAL_DAILY_CAP };
    }
  }

  // Allowed → bump the all-time total. Counted only for scans we actually run,
  // so the counter reflects real (paid) scans, not blocked attempts.
  await pipeline([["INCR", "scans:total"]]);
  return { allowed: true };
}

// --- Price verification: budget + cache ----------------------------------
//
// The optional web-search pass (lib/verify.ts) costs about a cent each time it
// runs. These two helpers are what bound that: a hard daily ceiling on the
// number of searches, and a cache so the same item is never looked up twice in
// a fortnight.

const SEARCH_DAILY_CAP = Number(process.env.SEARCH_DAILY_CAP ?? 50);

// Resale prices move slowly; a fortnight-old comp is still a good comp, and
// re-running the search would cost a cent to learn almost nothing.
const VERIFY_CACHE_TTL_SECONDS = 1_209_600; // 14 days

/**
 * Claim one search against today's global budget.
 *
 * Note this FAILS CLOSED, the opposite of checkAndRecordScan above. That gate
 * fails open because a KV blip must never stop someone scanning — the scan is
 * the product. This one guards spending: if we can't confirm there's budget
 * left, we skip the search and serve the model's own estimate. The user still
 * gets a complete result, just an unverified one, so the cost of being wrong
 * here is a slightly less accurate price rather than a broken app.
 */
export async function claimSearchBudget(): Promise<boolean> {
  if (!configured()) return false;

  const day = utcDay();
  const key = `search:day:${day}`;
  const out = await pipeline([
    ["INCR", key],
    ["EXPIRE", key, KEY_TTL_SECONDS],
  ]);
  if (!out) return false;

  const used = resultInt(out[0]);
  if (used > SEARCH_DAILY_CAP) {
    console.log(`[verify] daily search budget spent (${SEARCH_DAILY_CAP})`);
    return false;
  }
  return true;
}

/** Cached verification for an item identity, or null on miss/misconfig/error. */
export async function getCachedVerification(
  key: string,
): Promise<{ low: number; high: number; note: string } | null> {
  if (!configured()) return null;

  const out = await pipeline([["GET", `verify:${key}`]]);
  if (!out) return null;
  const raw = (out[0] as { result?: unknown })?.result;
  if (typeof raw !== "string") return null;

  try {
    const v = JSON.parse(raw) as Record<string, unknown>;
    if (typeof v.low !== "number" || typeof v.high !== "number") return null;
    return {
      low: v.low,
      high: v.high,
      note: typeof v.note === "string" ? v.note : "",
    };
  } catch {
    return null;
  }
}

/** Store a verification. Best-effort — a failed write just means a future miss. */
export async function cacheVerification(
  key: string,
  value: { low: number; high: number; note: string },
): Promise<void> {
  if (!configured()) return;
  await pipeline([
    ["SET", `verify:${key}`, JSON.stringify(value)],
    ["EXPIRE", `verify:${key}`, VERIFY_CACHE_TTL_SECONDS],
  ]);
}

// All-time total scans across everyone, for the stats counter. Null if unknown
// (Upstash not configured); 0 if configured but nothing counted yet.
export async function getTotalScans(): Promise<number | null> {
  if (!configured()) return null;
  const out = await pipeline([["GET", "scans:total"]]);
  if (!out) return null;
  const r = (out[0] as { result?: unknown })?.result;
  if (r === null || r === undefined) return 0;
  const n = Number(r);
  return Number.isFinite(n) ? n : 0;
}
