# App Store listing — Loot Check

Copy each field into the matching App Store Connect field.
Current submission: **1.0.1** (build auto-increments remotely; last shipped was 1.0.0 build 2, 30 Jun 2026).

## App Name (max 30)
Loot Check

## Subtitle (max 30)
Snap it, see what it's worth

## Promotional Text (max 170 — editable anytime, no review)
Point your camera at anything you own. Loot Check tells you what it's worth, where to sell it, and writes the listing for you — in seconds.

## Keywords (max 100, comma-separated, no spaces — ~95 used)
resell,resale,declutter,thrift,flip,ebay,poshmark,mercari,depop,price,value,secondhand,appraise

> Don't repeat words already in the name/subtitle (Apple indexes those separately).
> The marketplace names (ebay, poshmark…) are good search terms but carry a small
> trademark-flag risk. If a reviewer objects, swap them for:
> marketplace,vintage,used,collectibles,estate

## What's New in This Version (max 4000)

Paste into App Store Connect → the new version's **What's New in This Version** field.
Required for every update; it's the one listing field a new version forces you to fill in.

```
• A new app icon and a refreshed launch screen
• Faster results — your estimated resale value now appears the moment the item is identified
• A cleaner price card
```

### Release-note history

- **1.0.1** — new icon + launch screen; price now renders instantly on-device
  (the sold-comps lookup that never shipped was removed along with its caption).
- **1.0.0** — initial release.

## Description (max 4000)

Note: Apple does **not** index the description for App Store search — only the name,
subtitle, and keywords. So this field is written for conversion, not keywords. The
first ~170 characters are what shows before the "more" cutoff; everything important
is front-loaded. Nothing here claims the prices come from market or sales data —
they are the model's estimates, and "A NOTE ON PRICES" says so plainly.

```
Got stuff you might sell but no idea what it's worth? Snap one photo. Loot Check identifies the item, estimates what it would sell for secondhand, and tells you where to list it — in seconds.

No account. No sign-up. No ads. Just point your camera at the clutter in your closet and start turning it into cash.

HOW IT WORKS
• Snap a photo — or add a few angles (a close-up of a logo or label helps nail the exact product)
• Get an instant ID — brand, item type, and condition
• See an estimated resale price range
• Find the best place to sell — a recommended marketplace, with a side-by-side look at what you'd actually pocket after fees
• Copy a ready-to-post listing — a title and description written for you, one tap to copy

FEATURES
• AI photo identification — brand, item type, and condition from a single picture
• Estimated resale value, instantly
• Marketplace recommendations across eBay, Poshmark, Mercari, Depop, Vinted, Facebook Marketplace, and OfferUp
• Fee-aware payout comparison so you can see where you net the most
• Auto-generated listing title and description
• Add a hint or extra photos for hard-to-identify items
• No account, no sign-up — just open and scan

A NOTE ON PRICES
Prices in Loot Check are AI-generated estimates, meant to help you price with confidence — not appraisals or guarantees. What an item actually sells for depends on its condition, demand, and timing.

Free to use. No ads, no account required. Find out what your stuff is worth with Loot Check.
```

## Other required fields (reference)
- Support URL: https://resell-it-backend.vercel.app/support
- Privacy Policy URL: https://resell-it-backend.vercel.app/privacy
- Primary category: Shopping (or Utilities)
- Age rating: 4+
- Price: Free

## Submission checklist for an update

Most listing metadata carries over from the last version untouched. These are the
things a new version actually makes you handle:

- [ ] **Version string** — `mobile/app.json` → `expo.version` is `1.0.1`. The build
      number is managed remotely (`appVersionSource: "remote"` in `eas.json`) and
      `autoIncrement` bumps it to 3 on the next production build. Don't set it by hand.
- [ ] **New build** — the icon lives in the binary, so this needs `eas build -p ios
      --profile production`, not an OTA update. Then `eas submit -p ios`.
- [ ] **What's New** — paste the block above. Mandatory field on every update.
- [ ] **Screenshots** — no change needed. `App.tsx` hasn't been touched since the
      1.0.0 build, and the app UI never renders the icon asset, so the existing
      screenshots still match what a reviewer will see.
- [ ] **Export compliance** — already declared in `app.json`
      (`ITSAppUsesNonExemptEncryption: false`), so App Store Connect won't re-ask.
- [ ] **App Privacy** — unchanged. No new data is collected in this version; the
      two-item answer below still matches the app's behaviour.
- [ ] **Age rating questionnaire** — Apple replaced this in 2025 and required every
      app to re-answer it by 31 Jan 2026 or be blocked from submitting updates. If
      the 1.0.0 submission predates your answering it, App Store Connect will make
      you complete it before this build can go anywhere.
- [ ] **Minimum SDK** — since 28 Apr 2026, uploads must be built with Xcode 26 /
      the iOS 26 SDK. The 30 Jun 2026 production build already cleared this on
      Expo SDK 54, so the next EAS build will too.

### Note on runtime version

`app.json` sets `runtimeVersion.policy: "appVersion"`. Bumping to 1.0.1 starts a new
OTA channel: updates published for 1.0.0 will no longer reach 1.0.1 installs, and
vice versa. Expected — just don't expect an OTA to patch both at once.

## App Privacy questionnaire (App Store Connect → App Privacy)

Principle: Apple counts data as "collected" if it's transmitted off the device,
even if you don't store it. Loot Check sends photos to the backend → Anthropic,
and a device ID for the daily cap — so those two are declared. Everything else is No.

### Gate question
"Do you or your third-party partners collect data from this app?" → **Yes**

### Data types to select (only these two)
- **User Content → Photos or Videos** (the item photos users scan)
- **Identifiers → Device ID** (per-install ID for the daily scan cap)

Leave everything else unchecked: no Contact Info, Financial Info, Location, Contacts,
Health, Search/Browsing History, Purchases, Usage Data, or Diagnostics.
(No accounts, no payments, no analytics/crash SDKs, no ads, no location.)

### Configure each (same 3 questions)
Photos or Videos
- Used to track you? → No
- Linked to the user's identity? → No
- Purposes → App Functionality only

Device ID
- Used to track you? → No
- Linked to the user's identity? → No
- Purposes → App Functionality only (fraud/abuse prevention via the daily cap)

### Resulting privacy label
- Data Used to Track You: None
- Data Linked to You: None
- Data Not Linked to You: Photos or Videos, Device ID

### Reminder
If you later add analytics, crash reporting (e.g. Sentry), or ads, you MUST update
this — those add Usage Data / Diagnostics / tracking declarations. As-is, the
two-item answer is accurate and matches the published privacy policy.
