// Generates the app icon assets from vector art (no fonts needed).
// A price-tag mark on a green gradient. Run: npm run icon
import sharp from "sharp";

// The price-tag silhouette, pointing left, with a punched hole near the point.
const TAG = "M430 300 H760 a60 60 0 0 1 60 60 V664 a60 60 0 0 1 -60 60 H430 L230 512 Z";

// iOS / store icon: full-bleed green gradient + white tag. iOS rounds corners.
const iconSvg = `
<svg width="1024" height="1024" viewBox="0 0 1024 1024" xmlns="http://www.w3.org/2000/svg">
  <defs>
    <linearGradient id="g" x1="0" y1="0" x2="1024" y2="1024" gradientUnits="userSpaceOnUse">
      <stop offset="0" stop-color="#10B981"/>
      <stop offset="1" stop-color="#047857"/>
    </linearGradient>
  </defs>
  <rect width="1024" height="1024" fill="url(#g)"/>
  <g transform="rotate(-12 512 512)">
    <path d="${TAG}" fill="#ffffff"/>
    <circle cx="356" cy="512" r="46" fill="#059669"/>
  </g>
</svg>`;

// Android adaptive foreground: transparent, white tag scaled into the safe
// zone. Adaptive backgroundColor (#047857) is set in app.json; the hole is that
// colour so it reads as punched through.
const foregroundSvg = `
<svg width="1024" height="1024" viewBox="0 0 1024 1024" xmlns="http://www.w3.org/2000/svg">
  <g transform="rotate(-12 512 512)">
    <g transform="translate(512 512) scale(0.84) translate(-512 -512)">
      <path d="${TAG}" fill="#ffffff"/>
      <circle cx="356" cy="512" r="46" fill="#047857"/>
    </g>
  </g>
</svg>`;

async function render(svg: string, out: string): Promise<void> {
  await sharp(Buffer.from(svg)).resize(1024, 1024).png().toFile(out);
  console.log("wrote", out);
}

await render(iconSvg, "mobile/assets/icon.png");
await render(foregroundSvg, "mobile/assets/android-icon-foreground.png");
