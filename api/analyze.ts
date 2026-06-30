import type { VercelRequest, VercelResponse } from "@vercel/node";
import { handleAnalyzeRequest } from "../lib/handler.js";

export default async function handler(
  req: VercelRequest,
  res: VercelResponse,
): Promise<void> {
  if (req.method !== "POST") {
    res.status(405).json({ error: "Method not allowed" });
    return;
  }

  const header = req.headers["x-device-id"];
  const deviceId = Array.isArray(header) ? header[0] : header;
  const { status, body } = await handleAnalyzeRequest(req.body, { deviceId });
  res.status(status).json(body);
}
