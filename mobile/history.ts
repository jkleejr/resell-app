import AsyncStorage from "@react-native-async-storage/async-storage";
import { Directory, File, Paths } from "expo-file-system";
import { manipulateAsync, SaveFormat } from "expo-image-manipulator";
import type { AnalyzeResult } from "./types";

// Past scans, kept on this device only — never sent to the backend, which
// deliberately stores nothing that could identify an item (see lib/scanlog.ts
// and the privacy policy). Deleting the app deletes the history with it.
//
// The results themselves are one JSON array in AsyncStorage, newest first. The
// first photo of each scan is kept as a small JPEG in the document directory:
// the photos the scan used live in the image manipulator's cache, which the OS
// may clear at any time.
//
// Best-effort throughout, like review.ts: history is never worth breaking a
// scan over, so every failure is swallowed, and a thumbnail that can't be
// written just leaves the entry without a photo.

const HISTORY_KEY = "scanHistory";
const MAX_SAVED = 50;
const THUMB_WIDTH = 512;

export type SavedScan = {
  id: string;
  savedAt: number;
  result: AnalyzeResult;
  // A file name, not a URI: iOS moves the app's container on every update, so
  // a stored absolute path would point nowhere after the next release.
  thumbName?: string;
};

function scansDir(): Directory {
  return new Directory(Paths.document, "scans");
}

export function thumbUri(scan: SavedScan): string | null {
  return scan.thumbName ? new File(scansDir(), scan.thumbName).uri : null;
}

function deleteThumb(scan: SavedScan): void {
  if (!scan.thumbName) return;
  try {
    const file = new File(scansDir(), scan.thumbName);
    if (file.exists) file.delete();
  } catch {
    // no-op — an orphaned thumbnail only costs a few KB
  }
}

export async function loadHistory(): Promise<SavedScan[]> {
  try {
    const raw = await AsyncStorage.getItem(HISTORY_KEY);
    const parsed: unknown = raw ? JSON.parse(raw) : [];
    return Array.isArray(parsed) ? (parsed as SavedScan[]) : [];
  } catch {
    return [];
  }
}

async function writeHistory(scans: SavedScan[]): Promise<void> {
  await AsyncStorage.setItem(HISTORY_KEY, JSON.stringify(scans));
}

export async function saveScan(
  result: AnalyzeResult,
  photoUri: string | undefined,
): Promise<void> {
  try {
    const id = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

    let thumbName: string | undefined;
    if (photoUri) {
      try {
        const small = await manipulateAsync(
          photoUri,
          [{ resize: { width: THUMB_WIDTH } }],
          { compress: 0.6, format: SaveFormat.JPEG },
        );
        const dir = scansDir();
        if (!dir.exists) dir.create({ intermediates: true });
        const name = `${id}.jpg`;
        new File(small.uri).move(new File(dir, name));
        thumbName = name;
      } catch {
        // saved without a photo
      }
    }

    const entry: SavedScan = { id, savedAt: Date.now(), result, thumbName };
    const all = [entry, ...(await loadHistory())];
    all.slice(MAX_SAVED).forEach(deleteThumb);
    await writeHistory(all.slice(0, MAX_SAVED));
  } catch {
    // no-op — history is optional
  }
}

export async function deleteScan(id: string): Promise<SavedScan[]> {
  const all = await loadHistory();
  all.filter((s) => s.id === id).forEach(deleteThumb);
  const rest = all.filter((s) => s.id !== id);
  try {
    await writeHistory(rest);
  } catch {
    return all;
  }
  return rest;
}

export async function clearHistory(): Promise<void> {
  try {
    await AsyncStorage.removeItem(HISTORY_KEY);
    const dir = scansDir();
    if (dir.exists) dir.delete();
  } catch {
    // no-op
  }
}
