# Flip — backend

Resale scanner backend. Photo of an item → structured listing JSON.

Status: **core loop complete (M1–M4 code)** — identify → price → compare → ready-to-post listing.
- `POST /api/analyze` — vision ID + listing description.
- `POST /api/price` — fair-value ladder (real eBay sold comps when `RAPIDAPI_KEY` is set; honest "estimate" label otherwise).
- Mobile (`mobile/`) — capture → result screen with price, marketplace comparison, copy listing text, and a "List on …" deep link.

Deferred until before public release: backend per-device usage cap (needs a KV store) and store submission (needs Apple/Google accounts). Real sold-comps and cross-platform breadth (M5) are drop-in upgrades. See `PRD-resale-scanner.md`.

## Setup

```bash
npm install
cp .env.example .env   # then paste your Anthropic API key into .env
```

Get a key at https://console.anthropic.com/settings/keys

## Verify M1 (the "does identification feel magic" test)

Quickest path — run the analyzer against image files directly:

```bash
npm run analyze -- ./photos/brand-item.jpg   # a brand-name thing (e.g. a labelled gadget)
npm run analyze -- ./photos/generic-item.jpg # a generic thing (e.g. a plain mug)
npm run analyze -- ./photos/blurry.jpg        # a deliberately blurry/dark shot
```

Each prints the contract JSON. The blurry case should describe the item
generically with `brand: ""` and `specificity: "generic"` — it must **not**
invent a brand.

Or run it over HTTP exactly as production will:

```bash
npm run dev      # starts http://localhost:3000/api/analyze

# in another terminal:
IMG=$(base64 -i ./photos/brand-item.jpg)
curl -s localhost:3000/api/analyze \
  -H 'content-type: application/json' \
  -d "{\"image\":\"$IMG\",\"mediaType\":\"image/jpeg\"}" | jq
```

## Data contract

`POST /api/analyze`

Request: `{ "image": "<base64 jpeg, no data: prefix>", "mediaType": "image/jpeg" }`

Response: see `lib/schema.ts` (`AnalyzeResult`). Categories, conditions, and
specificity values are enumerated there.

## Deploying (later, for M2)

This is a Vercel project: `api/analyze.ts` is the serverless function.
Set `ANTHROPIC_API_KEY` as a Vercel project env var — never ship it in the app
bundle. The key only ever lives on the backend.
