import AsyncStorage from "@react-native-async-storage/async-storage";
import * as StoreReview from "expo-store-review";

// Ask for an App Store rating every once in a while, after the user has had a
// few good scans. This is Apple's own rating sheet (stars right in the app,
// written review optional) — Apple doesn't allow a custom rating form.
//
// Cadence: the first ask comes after SCANS_BEFORE_ASKING successful scans, and
// each later ask needs both COOLDOWN_DAYS since the last one and another
// SCANS_BEFORE_ASKING scans since then. The cooldown means it never shows on
// consecutive days, let alone twice in one day. iOS adds its own cap on top
// (~3 shows a year, and none once the user has rated this version), silently
// skipping requests past it. Best-effort: any failure is ignored, the prompt is
// never worth breaking a scan over.
const SCANS_BEFORE_ASKING = 3;
const COOLDOWN_DAYS = 30;
// Let the user see their price before the sheet slides over it.
const ASK_DELAY_MS = 2000;

const SCANS_KEY = "scansSinceReviewAsk";
const LAST_ASKED_KEY = "lastReviewAskAt";

const DAY_MS = 24 * 60 * 60 * 1000;

export async function recordSuccessfulScan(): Promise<void> {
  try {
    const scans = Number(await AsyncStorage.getItem(SCANS_KEY)) + 1;
    await AsyncStorage.setItem(SCANS_KEY, String(scans));
    if (scans < SCANS_BEFORE_ASKING) return;

    const lastAsked = Number(await AsyncStorage.getItem(LAST_ASKED_KEY));
    if (lastAsked && Date.now() - lastAsked < COOLDOWN_DAYS * DAY_MS) return;
    if (!(await StoreReview.isAvailableAsync())) return;

    // Record the ask before showing it, so a crash or quick exit can't cause a
    // second ask the same day.
    await AsyncStorage.setItem(LAST_ASKED_KEY, String(Date.now()));
    await AsyncStorage.setItem(SCANS_KEY, "0");
    await new Promise((resolve) => setTimeout(resolve, ASK_DELAY_MS));
    await StoreReview.requestReview();
  } catch {
    // no-op — the rating prompt is optional
  }
}
