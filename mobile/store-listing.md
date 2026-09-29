# App Store listing — Loot Check

Copy each field into the matching App Store Connect field.
Current submission: **1.0.5** (build auto-increments remotely; 1.0.3 went live 4 Sep 2026.
App Store Connect will not accept a new version while another is still in review).

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
- Your past scans are now saved in History on the home screen
- New Settings: choose which marketplaces you sell on
- Etsy and StockX added
- Where to sell now shows only the marketplaces that fit your item
- Cancel a scan while it's identifying
- Tap the camera square to add more photos
- Swipe left to delete a past scan
- Cleaner results page
```

> Kept short and casual to match the notes live on the App Store.

### Release-note history

- **1.0.5** — scan history on the home screen (saved on the device only), with
  swipe-to-delete and retry from a past scan; cancel a scan mid-identify; a
  camera slot in place of "Add another photo"; a Settings page to choose
  marketplaces, with Etsy and StockX added and "Loot Check decides" letting the
  AI suggest any site; Where to sell lists only the marketplaces that suit the
  item (needs the matching backend deploy); results page restyled.
  Needs a new binary: history adds expo-file-system (native).
  Notes as pasted: see the block above.
- **1.0.4** — asks for an App Store rating (Apple's native sheet) after the
  10th successful scan, then at most once per 30 days. Also: the scanned photos
  stay above a failed scan's error, the verified-scan wait estimate is ~25s,
  and a revised icon (larger tag). Notes as pasted:
  "Photos stay on screen if a scan fails / More accurate wait time estimates /
  Updated app icon".
- **1.0.3** — released 4 Sep 2026. Notes as live on the App Store:
  "Improved listing descriptions - Added high confidence labels - Added web
  searches - Displays wait time estimates". Detail: original/handmade valuation surfaced in the UI: originals show
  "Estimated value" rather than a resale price, prices can carry a provenance
  line, and hitting the daily cap now actually stops further scans instead of
  offering a retry that cannot succeed. The valuation itself shipped earlier via
  the backend and is already live for 1.0.x installs; this build is what makes it
  legible on screen.

  Listing quality, added after build 9 was uploaded: descriptions no longer
  arrive truncated (`cleanText` now strips U+0085 and the rest of the C1 and
  zero-width families, and an over-long response fails the scan instead of
  going out half-written), titles name the item rather than narrating the
  photo, hedges and buyer-directed caveats are stripped in code by `dropHedges`
  rather than merely discouraged in the prompt, the badge row can now say
  "pretty certain" / "very certain" instead of only flagging a best guess, and
  the wait carries a measured estimate that relabels itself when the price
  check runs long.
- **1.0.2** — new app icon (second revision of the scan-tag mark).
- **1.0.1** — new icon + launch screen; price now renders instantly on-device
  (the sold-comps lookup that never shipped was removed along with its caption).
  Approved and released 29 Aug 2026.
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

- [ ] **Version string** — `mobile/app.json` → `expo.version` is `1.0.5`. The build
      number is managed remotely (`appVersionSource: "remote"` in `eas.json`) and
      `autoIncrement` bumps it on the next production build. Don't set it by hand.
- [ ] **Previous version out of review** — App Store Connect will not accept 1.0.5 while 1.0.4
      is still `Waiting for Review` or `In Review`. Check before submitting.
- [ ] **Deploy the backend first** — 1.0.5's per-item Where to sell and "Loot Check
      decides" need it. It's safe for older installs: they send no marketplace list
      and keep getting the original seven.
- [ ] **New build** — 1.0.5 adds a native module (expo-file-system, for scan history),
      so it can only ship as a new binary; an OTA update can't carry it.
      `eas build -p ios --profile production`, then `eas submit -p ios`.
- [ ] **What's New** — paste the block above. Mandatory field on every update.
- [ ] **Screenshots** — not required to change. The result screen now reads
      "Estimated value" for originals and can show a provenance line under the
      price, but existing screenshots show a resale item, which still matches.
      (Screenshot 3 may still show the removed price caption from before 1.0.1 —
      worth a look, but not a blocker.)
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

`app.json` sets `runtimeVersion.policy: "appVersion"`. Bumping to 1.0.3 starts a new
OTA channel: updates published for 1.0.2 will no longer reach 1.0.3 installs, and
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
