// Minimal local server so you can hit POST /api/analyze and /api/price exactly
// as in production, without the Vercel CLI. Run with: npm run dev
import { createServer } from "node:http";
import {
  handleAnalyzeRequest,
  handlePriceRequest,
  handleStatsRequest,
  type HandlerResponse,
  type RequestContext,
} from "../lib/handler.js";

const PORT = Number(process.env.PORT ?? 3000);
const BODY_LIMIT = 6 * 1024 * 1024; // generous local cap; Vercel's real limit is ~4.5 MB

const ROUTES: Record<
  string,
  (body: unknown, ctx: RequestContext) => Promise<HandlerResponse>
> = {
  "/api/analyze": handleAnalyzeRequest,
  "/api/price": handlePriceRequest,
};

const server = createServer((req, res) => {
  // GET /api/stats — public all-time scan counter (no body).
  if (req.method === "GET" && req.url === "/api/stats") {
    void (async () => {
      const { status, body } = await handleStatsRequest();
      res.writeHead(status, { "content-type": "application/json" });
      res.end(JSON.stringify(body));
    })();
    return;
  }

  const route = req.url ? ROUTES[req.url] : undefined;
  if (req.method !== "POST" || !route) {
    res.writeHead(404, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: "Not found. POST /api/analyze or /api/price" }));
    return;
  }

  let raw = "";
  let tooLarge = false;
  req.on("data", (chunk) => {
    raw += chunk;
    if (raw.length > BODY_LIMIT) {
      tooLarge = true;
      req.destroy();
    }
  });

  req.on("end", () => {
    void (async () => {
      if (tooLarge) {
        res.writeHead(413, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: "Request body too large" }));
        return;
      }
      let parsed: unknown;
      try {
        parsed = raw ? JSON.parse(raw) : {};
      } catch {
        res.writeHead(400, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: "Invalid JSON body" }));
        return;
      }
      const header = req.headers["x-device-id"];
      const deviceId = Array.isArray(header) ? header[0] : header;
      const { status, body } = await route(parsed, { deviceId });
      res.writeHead(status, { "content-type": "application/json" });
      res.end(JSON.stringify(body));
    })();
  });
});

server.listen(PORT, () => {
  console.log(`dev server on http://localhost:${PORT}  (POST /api/analyze, /api/price)`);
  if (!process.env.ANTHROPIC_API_KEY) {
    console.warn("⚠  ANTHROPIC_API_KEY is not set — /api/analyze will return 500.");
  }
  if (!process.env.UPSTASH_REDIS_REST_URL || !process.env.UPSTASH_REDIS_REST_TOKEN) {
    console.warn("ℹ  Upstash not set — scan cap is OFF and the global counter won't increment (fine locally).");
  }
});
