import AsyncStorage from "@react-native-async-storage/async-storage";
import { MARKETPLACE_NAMES } from "./pricing";

// The seller's settings, kept on this device only. Sent with each scan so the
// backend recommends only from marketplaces they actually use.
//
// Best-effort, like history.ts: a failed read just means the defaults, and a
// failed write means the change lasts until the app closes.

const SETTINGS_KEY = "settings";

export type Settings = {
  /** The listed marketplaces they use, in the app's order. Never empty. */
  marketplaces: string[];
  /** Whether Loot Check may suggest a marketplace that isn't listed. */
  otherMarketplaces: boolean;
};

export const DEFAULT_SETTINGS: Settings = {
  marketplaces: MARKETPLACE_NAMES,
  otherMarketplaces: true,
};

export async function loadSettings(): Promise<Settings> {
  try {
    const raw = await AsyncStorage.getItem(SETTINGS_KEY);
    if (!raw) return DEFAULT_SETTINGS;
    const saved = JSON.parse(raw) as Partial<Settings>;
    // Kept in the app's order, and only names it still lists — so a
    // marketplace removed in an update just drops out.
    const marketplaces = Array.isArray(saved.marketplaces)
      ? MARKETPLACE_NAMES.filter((m) => saved.marketplaces!.includes(m))
      : DEFAULT_SETTINGS.marketplaces;
    const otherMarketplaces =
      typeof saved.otherMarketplaces === "boolean"
        ? saved.otherMarketplaces
        : DEFAULT_SETTINGS.otherMarketplaces;
    return {
      // "Loot Check decides" means every marketplace is on, so it also turns
      // on any added since the settings were saved (Reverb, in 1.0.5). A
      // seller who picked their own keeps exactly their picks.
      marketplaces: otherMarketplaces
        ? MARKETPLACE_NAMES
        : marketplaces.length > 0
          ? marketplaces
          : DEFAULT_SETTINGS.marketplaces,
      otherMarketplaces,
    };
  } catch {
    return DEFAULT_SETTINGS;
  }
}

export async function saveSettings(settings: Settings): Promise<void> {
  try {
    await AsyncStorage.setItem(SETTINGS_KEY, JSON.stringify(settings));
  } catch {
    // no-op — see above
  }
}
