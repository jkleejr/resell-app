# App Store listing — Loot Check

Copy each field into the matching App Store Connect field.

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

## Description (max 4000)
Got stuff you might sell but no idea what it's worth? Loot Check turns a single photo into an answer — what the item is, what it's worth, and the best place to sell it.

Snap a photo and Loot Check identifies the item, estimates its resale value, recommends where to list it, and even writes the listing for you. Turn the clutter in your closet into cash.

HOW IT WORKS
• Snap a photo — or add a few angles (a close-up of a logo or label helps nail the exact product)
• Get an instant ID — brand, item type, and condition
• See what it's worth — an estimated resale price range
• Find the best place to sell — a recommended marketplace, with a side-by-side look at what you'd actually pocket after fees
• Copy a ready-to-post listing — a title and description written for you, one tap to copy

FEATURES
• Photo-based item identification
• Resale value estimates
• Smart marketplace recommendations across eBay, Poshmark, Mercari, Depop, Vinted, Facebook Marketplace, and OfferUp
• Fee-aware payout comparison so you can see where you net the most
• Auto-generated listing title and description
• Add a hint or extra photos for hard-to-identify items
• No account, no sign-up — just open and scan

A NOTE ON PRICES
Values shown are estimates to guide your pricing, not guarantees. What an item actually sells for depends on its condition, demand, and timing.

Free to use. No ads, no account required. Find out what your stuff is really worth with Loot Check.

## Other required fields (reference)
- Support URL: https://resell-it-backend.vercel.app/support
- Privacy Policy URL: https://resell-it-backend.vercel.app/privacy
- Primary category: Shopping (or Utilities)
- Age rating: 4+
- Price: Free

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
