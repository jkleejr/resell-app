// In-memory stand-ins for the two services a scan talks to, so the real handler
// can be tested end to end without spending money or touching production data:
//   - Upstash Redis REST   (POST /pipeline)    — just the commands the app uses
//   - Anthropic Messages   (POST /v1/messages) — canned vision + verify replies
//
// Point the code at it with UPSTASH_REDIS_REST_URL and ANTHROPIC_BASE_URL.
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";

export interface FakeServices {
  url: string;
  /** Redis contents: strings/counters and lists, keyed like the real thing. */
  store: Map<string, string | number | string[]>;
  /** What the vision call "sees" — returned as the model's JSON. */
  visionItem: Record<string, unknown>;
  /** Make every vision call fail with this HTTP status. */
  visionFailStatus: number | null;
  /** Make every vision call a refusal in this category (HTTP 200, stop_reason "refusal"). */
  visionRefusal: string | null;
  /** Stall only the FIRST vision call this long (to trip the server's retry). */
  visionStallFirstMs: number;
  /** The verify (web search) pass's JSON verdict. */
  verifyReply: Record<string, unknown>;
  /** Make every Upstash call fail. */
  upstashDown: boolean;
  /** Stall list writes (the scan log) this long. */
  rpushDelayMs: number;
  visionCalls: number;
  reset(): void;
  close(): Promise<void>;
}

export const RESALE_ITEM = {
  title: "SECRETTITLE Levi's 501 jeans",
  category: "clothing",
  brand: "SECRETBRAND",
  condition: "good",
  keywords: ["jeans"],
  searchQuery: "levis 501",
  specificity: "exact",
  valuationBasis: "resale",
  priceConfidence: "high",
  craftLevel: "not_applicable",
  estimatedValueUSD: { low: 25, high: 40 },
  listingDescription: "Levi's 501 jeans in dark wash.",
  recommendedPlatform: "eBay",
  recommendationReason: "Buyers search for them by name.",
  expectedSpeed: "fast",
};

export const ORIGINAL_ITEM = {
  ...RESALE_ITEM,
  title: "SECRETTITLE Original acrylic shark painting",
  category: "home_decor",
  brand: "",
  condition: "new",
  specificity: "generic",
  valuationBasis: "original",
  priceConfidence: "low",
  craftLevel: "competent",
  estimatedValueUSD: { low: 60, high: 120 },
};

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function message(text: string, usage: Record<string, unknown>) {
  return {
    id: "msg_fake",
    type: "message",
    role: "assistant",
    model: "claude-sonnet-5-5",
    content: [{ type: "text", text }],
    stop_reason: "end_turn",
    stop_sequence: null,
    usage,
  };
}

export async function startFakeServices(): Promise<FakeServices> {
  let server: Server;

  const fake: FakeServices = {
    url: "",
    store: new Map(),
    visionItem: RESALE_ITEM,
    visionFailStatus: null,
    visionRefusal: null,
    visionStallFirstMs: 0,
    verifyReply: {},
    upstashDown: false,
    rpushDelayMs: 0,
    visionCalls: 0,
    reset() {
      fake.store.clear();
      fake.visionItem = RESALE_ITEM;
      fake.visionFailStatus = null;
      fake.visionRefusal = null;
      fake.visionStallFirstMs = 0;
      fake.verifyReply = {
        findings: "Comparable originals ask $90-150.",
        match: "similar",
        evidence: "enough",
        rangeUSD: { low: 90, high: 150 },
        note: "Based on Etsy listings",
        source: "Etsy",
      };
      fake.upstashDown = false;
      fake.rpushDelayMs = 0;
      fake.visionCalls = 0;
    },
    close: () => new Promise((resolve) => server.close(() => resolve())),
  };
  fake.reset();

  async function redis(cmd: (string | number)[]): Promise<unknown> {
    const [op, key, ...args] = cmd as [string, string, ...(string | number)[]];
    switch (op) {
      case "INCR": {
        const next = Number(fake.store.get(key) ?? 0) + 1;
        fake.store.set(key, next);
        return next;
      }
      case "EXPIRE":
        return 1;
      case "GET":
        return fake.store.get(key) ?? null;
      case "RPUSH": {
        if (fake.rpushDelayMs) await sleep(fake.rpushDelayMs);
        const list = (fake.store.get(key) as string[] | undefined) ?? [];
        list.push(...args.map(String));
        fake.store.set(key, list);
        return list.length;
      }
      case "LRANGE": {
        const list = (fake.store.get(key) as string[] | undefined) ?? [];
        const start = Number(args[0]);
        const stop = Number(args[1]);
        return list.slice(start, stop === -1 ? undefined : stop + 1);
      }
      default:
        throw new Error(`fake Upstash: unsupported command ${op}`);
    }
  }

  server = createServer((req, res) => {
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", () => {
      void (async () => {
        const body = raw ? JSON.parse(raw) : {};
        const json = (status: number, payload: unknown) => {
          res.writeHead(status, { "content-type": "application/json" });
          res.end(JSON.stringify(payload));
        };

        if (req.url === "/pipeline") {
          if (fake.upstashDown) return json(500, { error: "down" });
          const out = [];
          for (const cmd of body as (string | number)[][]) {
            out.push({ result: await redis(cmd) });
          }
          return json(200, out);
        }

        if (req.url === "/v1/messages") {
          // The verify pass is the only call that carries tools.
          if (body.tools) {
            return json(
              200,
              message(JSON.stringify(fake.verifyReply), {
                input_tokens: 9000,
                output_tokens: 200,
                server_tool_use: { web_search_requests: 1 },
              }),
            );
          }
          fake.visionCalls += 1;
          if (fake.visionCalls === 1 && fake.visionStallFirstMs) {
            await sleep(fake.visionStallFirstMs);
          }
          if (fake.visionFailStatus) {
            return json(fake.visionFailStatus, {
              type: "error",
              error: { type: "invalid_request_error", message: "fake failure" },
            });
          }
          if (fake.visionRefusal) {
            return json(200, {
              ...message("", { input_tokens: 1200, output_tokens: 5 }),
              content: [],
              stop_reason: "refusal",
              stop_details: {
                type: "refusal",
                category: fake.visionRefusal,
                explanation: "fake refusal",
              },
            });
          }
          return json(
            200,
            message(JSON.stringify(fake.visionItem), {
              input_tokens: 1200,
              output_tokens: 200,
            }),
          );
        }

        json(404, { error: "not found" });
      })();
    });
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  fake.url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return fake;
}
