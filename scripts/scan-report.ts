// How is the app actually being used? Reads the anonymous scan log
// (lib/scanlog.ts) and prints a summary.
//
//   npm run report                # everything recorded so far
//   npm run report -- --days 7    # only the last 7 days
//   npm run report -- --json      # the raw summary, for a spreadsheet or script
//
// Needs the PRODUCTION Upstash creds in .env (UPSTASH_REDIS_REST_URL and
// UPSTASH_REDIS_REST_TOKEN) — it reads the same database the live app writes
// to. Read-only, and costs nothing: one Upstash command per 1,000 scans.
//
// The log starts on the day this shipped. Scans from before then were only
// ever counted, so they show up in the all-time total and nowhere else.
import { readScanEvents } from "../lib/scanlog.js";
import { summarize, type Spread } from "../lib/scanstats.js";
import { getTotalScans } from "../lib/usage.js";

const args = process.argv.slice(2);
const asJson = args.includes("--json");
const daysAt = args.indexOf("--days");
const days = daysAt >= 0 ? Number(args[daysAt + 1]) : null;

const pct = (n: number) => `${(n * 100).toFixed(1)}%`;
const secs = (ms: number | null) => (ms === null ? "—" : `${(ms / 1000).toFixed(1)}s`);
const date = (ts: number | null) => (ts === null ? "—" : new Date(ts).toISOString().slice(0, 10));

function heading(text: string): void {
  console.log(`\n${text}\n${"─".repeat(text.length)}`);
}

function row(label: string, value: string | number): void {
  console.log(`  ${label.padEnd(34)} ${value}`);
}

// A tally, biggest first, each with its share of the whole.
function breakdown(counts: Record<string, number>): void {
  const total = Object.values(counts).reduce((a, b) => a + b, 0);
  const sorted = Object.entries(counts).sort((a, b) => b[1] - a[1]);
  if (sorted.length === 0) row("(none yet)", "");
  for (const [name, n] of sorted) {
    row(name.replace(/_/g, " "), `${String(n).padStart(5)}   ${pct(n / total)}`);
  }
}

function timing(label: string, s: Spread): void {
  row(label, s.count ? `${secs(s.median)} typical, ${secs(s.p90)} slow end  (${s.count} scans)` : "—");
}

async function main(): Promise<void> {
  if (!process.env.UPSTASH_REDIS_REST_URL || !process.env.UPSTASH_REDIS_REST_TOKEN) {
    console.error(
      "UPSTASH_REDIS_REST_URL / UPSTASH_REDIS_REST_TOKEN are not set.\n" +
        "Add the production values to .env — the report reads the live scan log.",
    );
    process.exit(1);
  }

  let events = await readScanEvents();
  if (days !== null && Number.isFinite(days)) {
    const since = Date.now() - days * 86_400_000;
    events = events.filter((e) => e.ts >= since);
  }
  const s = summarize(events);

  if (asJson) {
    console.log(JSON.stringify(s, null, 2));
    return;
  }

  const allTime = await getTotalScans();
  console.log(`Loot Check — scan report${days !== null ? ` (last ${days} days)` : ""}`);
  row("Scans in the log", s.total);
  row("Logged from / to", `${date(s.from)} → ${date(s.to)}`);
  if (allTime !== null) row("All-time counter (incl. pre-log)", allTime);
  if (s.total === 0) {
    console.log("\nNothing recorded yet. Records start once this version is deployed.");
    return;
  }

  heading("Did scans work?");
  breakdown(s.outcomes);
  row("Failure rate (of scans that ran)", pct(s.failureRate));
  row("Server had to retry the AI call", s.serverRetries);

  heading("How long did people wait? (successful scans)");
  timing("All scans", s.duration.all);
  timing("Regular scans", s.duration.regular);
  timing("Scans with a web search", s.duration.withSearch);

  heading("Web-search price check");
  breakdown(s.verify);
  if (s.priceShift.count) {
    row("Typical change to the price", `${s.priceShift.medianChange! >= 0 ? "+" : ""}${pct(s.priceShift.medianChange!)}`);
    row("Raised / lowered the estimate", `${s.priceShift.raised} / ${s.priceShift.lowered}`);
  }

  heading("What kind of item?");
  breakdown(s.basis);
  if (Object.keys(s.craftLevels).length) {
    console.log("  Craft level of the originals:");
    breakdown(s.craftLevels);
  }

  heading("How sure were we?");
  row("Low price confidence (best guess)", pct(s.lowConfidenceShare));
  row("Generic ID (no exact brand/model)", pct(s.genericShare));
  row("Brand recognised", pct(s.brandKnownShare));

  heading("Categories");
  breakdown(s.categories);

  heading("How much do people scan in a day?");
  row("Device-days (a device, on a day)", s.depth.deviceDays);
  row("Scans per device-day", s.depth.scansPerDeviceDay.toFixed(1));
  row("Most scans by one device in a day", s.depth.most);
  console.log("  Device-days by number of scans:");
  breakdown(s.depth.buckets);

  heading("How people scan");
  console.log("  Photos per scan:");
  breakdown(s.photos);
  row("Added a hint", pct(s.hintShare));
  console.log("  Why the scan was run (unlabelled = an app from before the label):");
  breakdown(s.attempts);

  heading("Cost");
  row("Total AI spend on logged scans", `$${s.cost.totalUSD.toFixed(2)}`);
  row("Per scan", `$${s.cost.perScanUSD.toFixed(4)}`);

  heading("Scans per day (UTC, last 14)");
  for (const [day, n] of Object.entries(s.perDay).sort().slice(-14)) {
    row(day, `${String(n).padStart(5)}  ${"█".repeat(Math.min(60, n))}`);
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
