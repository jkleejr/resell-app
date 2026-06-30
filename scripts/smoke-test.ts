// End-to-end smoke test: generates a synthetic PNG (no real item), runs the
// full analyze pipeline against the live API, and checks the contract shape.
// An abstract image should degrade gracefully (brand "", specificity generic).
import zlib from "node:zlib";
import { analyzeImage } from "../lib/analyze.js";

function makePng(w: number, h: number, rgb: [number, number, number]): Buffer {
  const raw = Buffer.alloc((w * 3 + 1) * h);
  let p = 0;
  for (let y = 0; y < h; y++) {
    raw[p++] = 0; // filter byte: none
    for (let x = 0; x < w; x++) {
      raw[p++] = rgb[0];
      raw[p++] = rgb[1];
      raw[p++] = rgb[2];
    }
  }
  const idat = zlib.deflateSync(raw);

  const chunk = (type: string, data: Buffer): Buffer => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length, 0);
    const t = Buffer.from(type, "ascii");
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(zlib.crc32(Buffer.concat([t, data])) >>> 0, 0);
    return Buffer.concat([len, t, data, crc]);
  };

  const sig = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // colour type: RGB
  return Buffer.concat([
    sig,
    chunk("IHDR", ihdr),
    chunk("IDAT", idat),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

async function main(): Promise<void> {
  const png = makePng(96, 96, [130, 128, 126]);
  const started = Date.now();
  const result = await analyzeImage([
    { data: png.toString("base64"), mediaType: "image/png" },
  ]);
  const ms = Date.now() - started;

  console.log(JSON.stringify(result, null, 2));

  // Contract assertions
  const checks: [string, boolean][] = [
    ["title is a non-empty string", typeof result.title === "string" && result.title.length > 0],
    ["category present", typeof result.category === "string"],
    ["condition present", typeof result.condition === "string"],
    ["keywords is array", Array.isArray(result.keywords)],
    ["searchQuery is string", typeof result.searchQuery === "string"],
    ["price low <= high", result.estimatedValueUSD.low <= result.estimatedValueUSD.high],
    ["specificity present", ["exact", "generic"].includes(result.specificity)],
  ];
  console.error("");
  let ok = true;
  for (const [label, pass] of checks) {
    console.error(`${pass ? "✓" : "✗"} ${label}`);
    if (!pass) ok = false;
  }
  console.error(`\n(${ms} ms)`);
  if (!ok) process.exit(1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
