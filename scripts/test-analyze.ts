// Fastest way to verify M1's "done when": point it at one OR MORE image files
// and it prints the structured JSON. Calls the analysis logic directly (no HTTP).
//   npm run analyze -- ./photos/chair.jpg
//   npm run analyze -- ./photos/overall.jpg ./photos/logo.jpg   (multi-image)
import { readFile } from "node:fs/promises";
import { extname } from "node:path";
import { analyzeImage, type ImageInput } from "../lib/analyze.js";
import { isValidMediaType, type MediaType } from "../lib/schema.js";

const EXT_TO_MEDIA: Record<string, MediaType> = {
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".png": "image/png",
  ".webp": "image/webp",
  ".gif": "image/gif",
};

async function main(): Promise<void> {
  const paths = process.argv.slice(2);
  if (paths.length === 0) {
    console.error("Usage: npm run analyze -- <path-to-image> [more-images...]");
    process.exit(1);
  }
  if (!process.env.ANTHROPIC_API_KEY) {
    console.error("ANTHROPIC_API_KEY is not set.");
    process.exit(1);
  }

  const images: ImageInput[] = [];
  for (const path of paths) {
    const mediaType = EXT_TO_MEDIA[extname(path).toLowerCase()];
    if (!mediaType || !isValidMediaType(mediaType)) {
      console.error(`Unsupported image type for ${path} (use jpg/png/webp/gif).`);
      process.exit(1);
    }
    const data = (await readFile(path)).toString("base64");
    images.push({ data, mediaType });
  }

  const started = Date.now();
  const result = await analyzeImage(images);
  const ms = Date.now() - started;

  console.log(JSON.stringify(result, null, 2));
  console.error(`\n(${ms} ms)`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
