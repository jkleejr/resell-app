import type { VercelRequest, VercelResponse } from "@vercel/node";
import { handleStatsRequest } from "../lib/handler.js";

export default async function handler(
  req: VercelRequest,
  res: VercelResponse,
): Promise<void> {
  if (req.method !== "GET") {
    res.status(405).json({ error: "Method not allowed" });
    return;
  }

  const { status, body } = await handleStatsRequest();
  res.status(status).json(body);
}
