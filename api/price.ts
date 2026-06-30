import type { VercelRequest, VercelResponse } from "@vercel/node";
import { handlePriceRequest } from "../lib/handler.js";

export default async function handler(
  req: VercelRequest,
  res: VercelResponse,
): Promise<void> {
  if (req.method !== "POST") {
    res.status(405).json({ error: "Method not allowed" });
    return;
  }

  const { status, body } = await handlePriceRequest(req.body);
  res.status(status).json(body);
}
