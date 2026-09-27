import AsyncStorage from "@react-native-async-storage/async-storage";
import * as StoreReview from "expo-store-review";

// Ask for an App Store rating once the user has had a few good scans. This is
// Apple's own rating sheet (stars right in the app, written review optional) —
// Apple doesn't allow a custom rating form. iOS also rate-limits it to ~3 shows
// a year and may silently skip a request, so we only ever ask once per install
// rather than spend those shows on repeat calls. Best-effort: any failure is
// ignored, the prompt is never worth breaking a scan over.
const SCANS_BEFORE_ASKING = 3;
// Let the user see their price before the sheet slides over it.
const ASK_DELAY_MS = 2000;

const SCANS_KEY = "successfulScans";
const ASKED_KEY = "reviewRequested";

export async function recordSuccessfulScan(): Promise<void> {
  try {
    if (await AsyncStorage.getItem(ASKED_KEY)) return;

    const scans = Number(await AsyncStorage.getItem(SCANS_KEY)) + 1;
    await AsyncStorage.setItem(SCANS_KEY, String(scans));
    if (scans < SCANS_BEFORE_ASKING) return;
    if (!(await StoreReview.isAvailableAsync())) return;

    await AsyncStorage.setItem(ASKED_KEY, "1");
    await new Promise((resolve) => setTimeout(resolve, ASK_DELAY_MS));
    await StoreReview.requestReview();
  } catch {
    // no-op — the rating prompt is optional
  }
}
