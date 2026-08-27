// Generates every app icon asset from the master logo at assets-src/logo.png.
// The master is a square PNG, flat brand colour on opaque white. Run: npm run icon
//
// Nothing here is tuned to one particular mark: the artwork's bounding box is
// measured at build time and the Android safe-zone scale and favicon crop are
// derived from it. Swapping in a new logo is a one-file change.
import sharp from "sharp";

const SOURCE = "assets-src/logo.png";

// Brand blue, sampled from the master. Also the colour the transparent variants
// are re-flattened to, so antialiased edges stay clean instead of fringing grey.
const BRAND = { r: 0x2d, g: 0x2b, b: 0xe0 };

/** Tightest box containing every non-white pixel of the master. */
async function measure(): Promise<{ size: number; box: { minX: number; minY: number; maxX: number; maxY: number } }> {
  const { data, info } = await sharp(SOURCE).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  const { width, height, channels } = info;
  if (width !== height) throw new Error(`master must be square, got ${width}x${height}`);

  let minX = width, minY = height, maxX = -1, maxY = -1;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = (y * width + x) * channels;
      if (data[i]! < 240 || data[i + 1]! < 240 || data[i + 2]! < 240) {
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
      }
    }
  }
  if (maxX < 0) throw new Error("master appears to be blank");
  return { size: width, box: { minX, minY, maxX, maxY } };
}

/**
 * Rebuilds the master as brand-colour-on-transparent.
 *
 * The master is a two-colour image, so each pixel is a blend
 * `p = a*BRAND + (1-a)*white`. Solving for `a` on the red channel (the one with
 * the widest spread between white and BRAND, so it's least noisy) recovers the
 * original coverage exactly. Naive white-keying would leave grey fringes on
 * every antialiased edge; this does not.
 *
 * White knockouts *inside* the mark (the shoe, the tag hole) become transparent
 * too — which is what we want. On every surface these assets are used the layer
 * behind them is white, so they read identically, and on a themed Android
 * launcher they punch through to the tinted background.
 */
async function transparentMaster(): Promise<Buffer> {
  const { data, info } = await sharp(SOURCE).ensureAlpha().raw().toBuffer({ resolveWithObject: true });

  const span = 255 - BRAND.r; // white -> brand distance on the red channel
  for (let i = 0; i < data.length; i += info.channels) {
    const coverage = Math.min(255, Math.max(0, ((255 - data[i]!) / span) * 255));
    data[i] = BRAND.r;
    data[i + 1] = BRAND.g;
    data[i + 2] = BRAND.b;
    data[i + 3] = coverage;
  }

  return sharp(data, { raw: { width: info.width, height: info.height, channels: 4 } })
    .png()
    .toBuffer();
}

// Shrink `input` to `scale` of the canvas and re-centre it on a transparent
// square of `size` — used to pull the mark into a mask's safe zone.
async function inset(input: Buffer, size: number, scale: number): Promise<Buffer> {
  const inner = Math.round(size * scale);
  const art = await sharp(input).resize(inner, inner).toBuffer();
  return sharp({
    create: { width: size, height: size, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } },
  })
    .composite([{ input: art, gravity: "centre" }])
    .png()
    .toBuffer();
}

async function write(buf: Buffer, out: string): Promise<void> {
  await sharp(buf).toFile(out);
  console.log("wrote", out);
}

const { size, box } = await measure();
const spanX = box.maxX - box.minX + 1;
const spanY = box.maxY - box.minY + 1;

// Android adaptive icons are masked to an arbitrary launcher shape; only a
// centred circle of diameter 66.6% is guaranteed visible. Scale the mark so its
// furthest corner lands inside that circle, or a round mask clips it.
const safeRadius = size / 3;
const furthest = Math.max(
  ...[
    [box.minX, box.minY],
    [box.maxX, box.minY],
    [box.minX, box.maxY],
    [box.maxX, box.maxY],
  ].map(([x, y]) => Math.hypot(x! - size / 2, y! - size / 2)),
);
const adaptiveScale = Math.min(1, safeRadius / furthest);

// Favicon: crop to the artwork plus a little breathing room so the master's
// margin doesn't eat the 48px it gets. Clamps to the full frame when the mark
// already fills the canvas.
const faviconSide = Math.min(size, Math.round(Math.max(spanX, spanY) * 1.06));
const faviconOffset = Math.round((size - faviconSide) / 2);

console.log(
  `master ${size}px · art ${spanX}x${spanY} (${(spanX / spanY).toFixed(2)}:1)` +
    ` · adaptive scale ${adaptiveScale.toFixed(3)} · favicon crop ${faviconSide}px`,
);

const transparent = await transparentMaster();

// iOS / App Store icon: opaque, no alpha channel — Apple rejects icons with
// transparency. iOS applies its own corner rounding, so ship it square.
const opaque = await sharp(SOURCE).flatten({ background: "#ffffff" }).png().toBuffer();
await write(opaque, "mobile/assets/icon.png");

// The 1024 store upload is the same artwork; App Store Connect wants it as a
// standalone file rather than pulled out of the app bundle.
await write(opaque, "icon_appstore.png");

// Android adaptive foreground: transparent, inset to the safe zone. The
// adaptiveIcon backgroundColor (#FFFFFF) in mobile/app.json is the layer behind.
await write(await inset(transparent, 1024, adaptiveScale), "mobile/assets/android-icon-foreground.png");

// Adaptive background layer. Unused while app.json sets backgroundColor, but
// kept in sync so wiring it up later doesn't resurrect a stale colour.
await write(
  await sharp({ create: { width: 512, height: 512, channels: 4, background: "#ffffff" } })
    .png()
    .toBuffer(),
  "mobile/assets/android-icon-background.png",
);

// Android 13+ themed icon: the launcher tints this, so only the alpha matters.
await write(await inset(transparent, 432, adaptiveScale), "mobile/assets/android-icon-monochrome.png");

// Splash mark: transparent, rendered at 200px wide over the splash
// backgroundColor. Full-bleed — the master's own margin is the breathing room.
await write(transparent, "mobile/assets/splash-icon.png");

await write(
  await sharp(transparent)
    .extract({ left: faviconOffset, top: faviconOffset, width: faviconSide, height: faviconSide })
    .resize(48, 48)
    .png()
    .toBuffer(),
  "mobile/assets/favicon.png",
);
