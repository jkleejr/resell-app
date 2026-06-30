// Per-device daily cap + global scan counters, backed by Upstash Redis (REST).
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
