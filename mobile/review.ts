import AsyncStorage from "@react-native-async-storage/async-storage";
import * as StoreReview from "expo-store-review";

// Ask for an App Store rating every once in a while, once the user has had a
// good number of successful scans. This is Apple's own rating sheet (stars
// right in the app, written review optional) — Apple doesn't allow a custom
// rating form.
//
// Cadence: the first ask comes after SCANS_BEFORE_FIRST_ASK successful scans,
// and each later ask comes on the next successful scan at least COOLDOWN_DAYS
// after the last one. The cooldown means it never shows on consecutive days,
// let alone twice in one day.
//
// Apple never tells the app whether the user rated, so we can't skip people
// who did — iOS does that itself: it stops showing the sheet to someone who
// has already rated, caps it at ~3 shows a year, and silently ignores requests
// past either limit. Best-effort: any failure is ignored, the prompt is
// never worth breaking a scan over.
const SCANS_BEFORE_FIRST_ASK = 10;
const COOLDOWN_DAYS = 30;
// Let the user see their price before the sheet slides over it.
const ASK_DELAY_MS = 2000;

const SCANS_KEY = "successfulScans";
const LAST_ASKED_KEY = "lastReviewAskAt";

const DAY_MS = 24 * 60 * 60 * 1000;

export async function recordSuccessfulScan(): Promise<void> {
  try {
    const lastAsked = Number(await AsyncStorage.getItem(LAST_ASKED_KEY));
    if (lastAsked) {
      if (Date.now() - lastAsked < COOLDOWN_DAYS * DAY_MS) return;
    } else {
      const scans = Number(await AsyncStorage.getItem(SCANS_KEY)) + 1;
      await AsyncStorage.setItem(SCANS_KEY, String(scans));
      if (scans < SCANS_BEFORE_FIRST_ASK) return;
    }
    if (!(await StoreReview.isAvailableAsync())) return;

    // Record the ask before showing it, so a crash or quick exit can't cause a
    // second ask the same day.
    await AsyncStorage.setItem(LAST_ASKED_KEY, String(Date.now()));
    await new Promise((resolve) => setTimeout(resolve, ASK_DELAY_MS));
    await StoreReview.requestReview();
  } catch {
    // no-op — the rating prompt is optional
  }
}
