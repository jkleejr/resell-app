import * as Application from "expo-application";
import { Platform } from "react-native";

// A best-effort stable identifier for this install, sent as the `x-device-id`
// header so the backend can apply its per-device daily scan cap. This is NOT a
// security boundary — a determined user can reset it — it's a fairness limit so
// one device can't drain the shared Anthropic budget. The Anthropic monthly
// spend limit is the hard backstop.
let cached: string | null = null;

export async function getDeviceId(): Promise<string> {
  if (cached) return cached;
  try {
    if (Platform.OS === "android") {
      cached = Application.getAndroidId();
    } else if (Platform.OS === "ios") {
      cached = await Application.getIosIdForVendorAsync();
    }
  } catch {
    // Fall through to the fallback below.
  }
  // Fallback if the OS id is briefly unavailable (e.g. iOS before first unlock)
  // or on web. Not persisted across reloads, which is acceptable.
  if (!cached) cached = `anon-${Math.random().toString(36).slice(2, 14)}`;
  return cached;
}
