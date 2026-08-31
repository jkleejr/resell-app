import { useEffect, useState } from "react";
import {
  ActivityIndicator,
  Image,
  Pressable,
  SafeAreaView,
  ScrollView,
  StatusBar,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native";
import * as ImagePicker from "expo-image-picker";
import { manipulateAsync, SaveFormat } from "expo-image-manipulator";
import * as Clipboard from "expo-clipboard";
import { BACKEND_URL } from "./config";
import { getDeviceId } from "./device";
import { buildComparison, speedLabel, toPrice } from "./pricing";

// Mirrors the backend /api/analyze contract (lib/schema.ts).
type AnalyzeResult = {
  title: string;
  category: string;
  brand: string;
  condition: string;
  keywords: string[];
  searchQuery: string;
  estimatedValueUSD: { low: number; high: number };
  specificity: "exact" | "generic";
  listingDescription: string;
  recommendedPlatform: string;
  recommendationReason: string;
  expectedSpeed: "fast" | "moderate" | "slow";
  // Added after 1.0.2 shipped. Optional so a build running against an older
  // backend deploy just falls back to the resale wording.
  valuationBasis?: "resale" | "original";
  priceBasis?: "estimate" | "verified";
  priceNote?: string;
};

type CapturedImage = { uri: string; base64: string };
type Status = "idle" | "working" | "done" | "error";

// Up to this many photos per scan — an overall shot plus a logo/label close-up
// dramatically improves identification. Keep in sync with MAX_IMAGES in the
// backend handler.
const MAX_IMAGES = 4;

const CONDITION_LABELS: Record<string, string> = {
  new: "New",
  like_new: "Like new",
  good: "Good",
  fair: "Fair",
  poor: "Poor",
};

const prettyCategory = (c: string) => c.replace(/_/g, " ");

export default function App() {
  const [status, setStatus] = useState<Status>("idle");
  const [images, setImages] = useState<CapturedImage[]>([]);
  const [hint, setHint] = useState("");
  const [result, setResult] = useState<AnalyzeResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [copiedField, setCopiedField] = useState<"title" | "listing" | null>(
    null,
  );
  const [totalScans, setTotalScans] = useState<number | null>(null);
  // Set when the backend returns 429. Blocks further scanning until the cap
  // resets at UTC midnight. Deliberately NOT persisted: on a fresh launch the
  // next scan asks the server again, which either succeeds because the day
  // rolled over or returns 429 and sets this straight back. That keeps the
  // reset honest without the app having to track a clock the server owns.
  const [limitReached, setLimitReached] = useState(false);

  // Global all-time scan counter (just for fun). Best-effort; ignore failures.
  async function fetchStats() {
    try {
      const res = await fetch(`${BACKEND_URL}/api/stats`);
      if (!res.ok) return;
      const data = (await res.json()) as { totalScans: number | null };
      if (typeof data.totalScans === "number") setTotalScans(data.totalScans);
    } catch {
      // no-op — the counter is cosmetic
    }
  }

  useEffect(() => {
    void fetchStats();
  }, []);

  async function copyText(text: string, field: "title" | "listing") {
    await Clipboard.setStringAsync(text);
    setCopiedField(field);
    setTimeout(() => setCopiedField(null), 2000);
  }

  async function addPhoto(source: "camera" | "library") {
    setError(null);

    const permission =
      source === "camera"
        ? await ImagePicker.requestCameraPermissionsAsync()
        : await ImagePicker.requestMediaLibraryPermissionsAsync();
    if (!permission.granted) {
      setError(
        source === "camera"
          ? "Camera permission is needed to take a photo."
          : "Photo library permission is needed to pick a photo.",
      );
      return;
    }

    const picked =
      source === "camera"
        ? await ImagePicker.launchCameraAsync({ quality: 1 })
        : await ImagePicker.launchImageLibraryAsync({
            quality: 1,
            allowsMultipleSelection: true,
            selectionLimit: MAX_IMAGES - images.length,
          });
    if (picked.canceled || !picked.assets?.length) return;

    const room = MAX_IMAGES - images.length;
    const assets = picked.assets.slice(0, room);

    try {
      const shrunk = await Promise.all(
        assets.map(async (asset) => {
          const s = await manipulateAsync(
            asset.uri,
            [{ resize: { width: 1024 } }],
            { compress: 0.7, format: SaveFormat.JPEG, base64: true },
          );
          if (!s.base64) throw new Error("Could not read the image data.");
          return { uri: s.uri, base64: s.base64 };
        }),
      );
      setImages((prev) => [...prev, ...shrunk].slice(0, MAX_IMAGES));
    } catch (e) {
      setError(
        e instanceof Error ? e.message : "Couldn't process that photo.",
      );
    }
  }

  function removeImage(index: number) {
    setImages((prev) => prev.filter((_, i) => i !== index));
  }

  async function identify() {
    if (images.length === 0) return;
    setError(null);
    setResult(null);
    setStatus("working");

    try {
      const res = await fetch(`${BACKEND_URL}/api/analyze`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-device-id": await getDeviceId(),
        },
        body: JSON.stringify({
          images: images.map((img) => ({
            image: img.base64,
            mediaType: "image/jpeg",
          })),
          hint: hint.trim() || undefined,
        }),
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as { error?: string };
        // 429 is the daily scan cap. Remember it, so the UI stops offering a
        // retry that cannot succeed — every further attempt would just be a
        // round trip to the same refusal.
        if (res.status === 429) setLimitReached(true);
        throw new Error(body.error ?? `Server returned ${res.status}`);
      }

      const data = (await res.json()) as AnalyzeResult;
      setResult(data);
      setStatus("done");
      void fetchStats(); // the global counter just ticked up

    } catch (e) {
      setError(
        e instanceof Error ? e.message : "Something went wrong. Try again.",
      );
      setStatus("error");
    }
  }

  // Back to the compose screen, KEEPING the current photos + hint so the user
  // can add a logo/label shot and identify again. Used by the "generic" nudge.
  function refine() {
    setStatus("idle");
    setResult(null);
    setError(null);
    setCopiedField(null);
  }

  // Full reset — clear everything for a brand-new item.
  function reset() {
    setStatus("idle");
    setImages([]);
    setHint("");
    setResult(null);
    setError(null);
    setCopiedField(null);
  }

  // The price is the model's estimate from the analyze call — no second request.
  // The backend may have refined it with a web search before responding; that
  // shows up as priceBasis "verified", not as extra work here.
  const price = result ? toPrice(result.estimatedValueUSD) : null;

  // One-of-a-kind pieces are priced as a first sale, so the whole card reads
  // differently — see the price block below.
  const isOriginal = result?.valuationBasis === "original";

  const comparison =
    price && result
      ? buildComparison(price.median, result.recommendedPlatform)
      : null;

  return (
    <SafeAreaView style={styles.safe}>
      <StatusBar barStyle="light-content" />
      <ScrollView contentContainerStyle={styles.container}>
        <Text style={styles.brand}>Loot Check</Text>
        <Text style={styles.tagline}>
          Snap something you want to sell. We'll tell you what it is, what it's
          worth, and where to sell it.
        </Text>

        {totalScans !== null && (
          <Text style={styles.counter}>
            🛍️ {totalScans.toLocaleString()} items scanned globally
          </Text>
        )}

        {/* Stays up across "Start over", which clears the error text — without
            it the Identify button would sit disabled with nothing saying why. */}
        {limitReached && (
          <View style={styles.limitBox}>
            <Text style={styles.limitText}>
              You've reached today's scan limit. Try again tomorrow.
            </Text>
          </View>
        )}

        {/* Compose: thumbnails + hint (idle only) */}
        {status === "idle" && images.length > 0 && (
          <>
            <ScrollView
              horizontal
              showsHorizontalScrollIndicator={false}
              contentContainerStyle={styles.thumbRow}
            >
              {images.map((img, i) => (
                <View key={img.uri} style={styles.thumbWrap}>
                  <Image source={{ uri: img.uri }} style={styles.thumb} />
                  <Pressable
                    onPress={() => removeImage(i)}
                    style={styles.thumbRemove}
                    hitSlop={8}
                  >
                    <Text style={styles.thumbRemoveText}>×</Text>
                  </Pressable>
                </View>
              ))}
            </ScrollView>

            <View style={styles.hintWrap}>
              <Text style={styles.hintLabel}>Add a detail (optional)</Text>
              <TextInput
                style={styles.hintInput}
                placeholder="e.g. Beats, size 10, model number…"
                placeholderTextColor="#6A6A76"
                value={hint}
                onChangeText={setHint}
                returnKeyType="done"
              />
              <Text style={styles.hintTip}>
                Tip: include a close-up of the brand logo or label for the best
                match.
              </Text>
            </View>
          </>
        )}

        {status === "working" && (
          <>
            {images[0] && (
              <Image source={{ uri: images[0].uri }} style={styles.preview} />
            )}
            <View style={styles.center}>
              <ActivityIndicator size="large" color="#fff" />
              <Text style={styles.muted}>Identifying…</Text>
            </View>
          </>
        )}

        {status === "error" && error && (
          <View style={styles.errorBox}>
            <Text style={styles.errorText}>{error}</Text>
          </View>
        )}

        {status === "done" && result && (
          <>
            {/* The scanned photo(s), shown above the result */}
            {images[0] && (
              <Image source={{ uri: images[0].uri }} style={styles.preview} />
            )}
            {images.length > 1 && (
              <ScrollView
                horizontal
                showsHorizontalScrollIndicator={false}
                contentContainerStyle={styles.thumbRow}
              >
                {images.map((img) => (
                  <Image
                    key={img.uri}
                    source={{ uri: img.uri }}
                    style={styles.thumb}
                  />
                ))}
              </ScrollView>
            )}

            {/* Item */}
            <View style={styles.card}>
              <Text style={styles.title}>{result.title}</Text>
              <View style={styles.badgeRow}>
                <Badge label={prettyCategory(result.category)} />
                <Badge
                  label={CONDITION_LABELS[result.condition] ?? result.condition}
                />
                {result.specificity === "generic" && (
                  <Badge label="best guess" subtle />
                )}
              </View>
              {result.brand ? (
                <Text style={styles.brandLine}>Brand: {result.brand}</Text>
              ) : null}
              {result.keywords.length > 0 && (
                <Text style={styles.keywords}>{result.keywords.join(" · ")}</Text>
              )}
            </View>

            {/* Reshoot nudge when the match is only generic */}
            {result.specificity === "generic" && (
              <View style={styles.nudge}>
                <Text style={styles.nudgeTitle}>Not sure of the exact product</Text>
                <Text style={styles.nudgeBody}>
                  This looks like a generic match. Add a close-up of the brand
                  logo or label — or type the brand in the detail field — and
                  identify again for a more accurate result and price.
                </Text>
                <SecondaryButton
                  label="Add a photo & retry"
                  onPress={refine}
                />
              </View>
            )}

            {/* Price. An original piece has never been sold, so "resale" is
                the wrong frame for it — the number is what the maker could
                ask, not what a used one fetches. */}
            <View style={styles.card}>
              <Text style={styles.sectionLabel}>
                {isOriginal ? "Estimated value" : "Estimated resale value"}
              </Text>
              {price && (
                <>
                  <Text style={styles.price}>${price.median}</Text>
                  <Text style={styles.priceRange}>
                    {isOriginal ? "could ask" : "resells for"} ${price.low}–$
                    {price.high}
                  </Text>
                  {/* Green tick only when listings actually backed the number.
                      A failed lookup still gets its line, in muted grey — it
                      explains the extra wait without dressing up as evidence. */}
                  {result.priceNote ? (
                    <Text
                      style={
                        result.priceBasis === "verified"
                          ? styles.priceNote
                          : styles.priceNoteMuted
                      }
                    >
                      {result.priceBasis === "verified" ? "✓ " : ""}
                      {result.priceNote}
                    </Text>
                  ) : null}
                </>
              )}
            </View>

            {/* Where to sell */}
            {comparison && (
              <View style={styles.card}>
                <Text style={styles.sectionLabel}>Where to sell</Text>
                <Text style={styles.recLead}>
                  Best bet: {result.recommendedPlatform}
                </Text>
                {result.recommendationReason ? (
                  <Text style={styles.reason}>
                    {result.recommendationReason}
                  </Text>
                ) : null}
                <Text style={styles.speed}>
                  {speedLabel(result.expectedSpeed)}
                </Text>
                {comparison.map((row) => (
                  <View
                    key={row.name}
                    style={[styles.row, row.recommended && styles.rowBest]}
                  >
                    <View style={styles.rowLeft}>
                      <View style={styles.rowNameWrap}>
                        <Text style={styles.rowName}>{row.name}</Text>
                        {row.recommended && (
                          <View style={styles.bestTag}>
                            <Text style={styles.bestTagText}>BEST</Text>
                          </View>
                        )}
                      </View>
                      <Text style={styles.rowMeta}>
                        {row.feeNote} · {row.shipping} · {row.speed}
                      </Text>
                    </View>
                    <Text style={styles.rowNet}>${row.net}</Text>
                  </View>
                ))}
                <Text style={styles.netNote}>
                  Amounts are roughly what you'd pocket after fees.
                </Text>
              </View>
            )}

            {/* Ready-to-post listing */}
            <View style={styles.card}>
              <Text style={styles.sectionLabel}>Ready-to-post listing</Text>

              <Text style={styles.listingFieldLabel}>Title</Text>
              <Text style={styles.listingTitle}>{result.title}</Text>
              <Pressable
                onPress={() => copyText(result.title, "title")}
                style={({ pressed }) => [
                  styles.copyBtn,
                  pressed && styles.pressed,
                ]}
              >
                <Text style={styles.copyBtnText}>
                  {copiedField === "title" ? "Copied ✓" : "Copy title"}
                </Text>
              </Pressable>

              {result.listingDescription ? (
                <>
                  <Text style={styles.listingFieldLabel}>Description</Text>
                  <Text style={styles.listingBody}>
                    {result.listingDescription}
                  </Text>
                  <Pressable
                    onPress={() => copyText(result.listingDescription, "listing")}
                    style={({ pressed }) => [
                      styles.copyBtn,
                      pressed && styles.pressed,
                    ]}
                  >
                    <Text style={styles.copyBtnText}>
                      {copiedField === "listing"
                        ? "Copied ✓"
                        : "Copy description"}
                    </Text>
                  </Pressable>
                </>
              ) : null}
            </View>
          </>
        )}

        <View style={styles.actions}>
          {status === "idle" &&
            (images.length === 0 ? (
              <>
                <PrimaryButton
                  label="Take a photo"
                  onPress={() => addPhoto("camera")}
                />
                <SecondaryButton
                  label="Choose from library"
                  onPress={() => addPhoto("library")}
                />
              </>
            ) : (
              <>
                <PrimaryButton
                  label={
                    limitReached
                      ? "Daily limit reached"
                      : images.length > 1
                        ? `Identify · ${images.length} photos`
                        : "Identify"
                  }
                  onPress={identify}
                  disabled={limitReached}
                />
                {images.length < MAX_IMAGES && (
                  <>
                    <SecondaryButton
                      label="Add another photo"
                      onPress={() => addPhoto("camera")}
                    />
                    <SecondaryButton
                      label="Add from library"
                      onPress={() => addPhoto("library")}
                    />
                  </>
                )}
                <SecondaryButton label="Start over" onPress={reset} />
              </>
            ))}

          {status === "error" && (
            <>
              {/* No retry once the cap is hit — it cannot succeed until the
                  limit resets, and offering the button implies otherwise. */}
              {images.length > 0 && !limitReached && (
                <PrimaryButton label="Try again" onPress={identify} />
              )}
              <SecondaryButton label="Start over" onPress={reset} />
            </>
          )}

          {status === "done" && (
            <PrimaryButton label="Scan another" onPress={reset} />
          )}
        </View>
      </ScrollView>
    </SafeAreaView>
  );
}

function Badge({ label, subtle }: { label: string; subtle?: boolean }) {
  return (
    <View style={[styles.badge, subtle && styles.badgeSubtle]}>
      <Text style={[styles.badgeText, subtle && styles.badgeTextSubtle]}>
        {label}
      </Text>
    </View>
  );
}

function PrimaryButton({
  label,
  onPress,
  disabled,
}: {
  label: string;
  onPress: () => void;
  disabled?: boolean;
}) {
  return (
    <Pressable
      onPress={onPress}
      disabled={disabled}
      style={({ pressed }) => [
        styles.primaryBtn,
        pressed && styles.pressed,
        disabled && styles.disabled,
      ]}
    >
      <Text style={styles.primaryBtnText}>{label}</Text>
    </Pressable>
  );
}

function SecondaryButton({
  label,
  onPress,
  disabled,
}: {
  label: string;
  onPress: () => void;
  disabled?: boolean;
}) {
  return (
    <Pressable
      onPress={onPress}
      disabled={disabled}
      style={({ pressed }) => [
        styles.secondaryBtn,
        pressed && styles.pressed,
        disabled && styles.disabled,
      ]}
    >
      <Text style={styles.secondaryBtnText}>{label}</Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: "#0E0E10" },
  container: { padding: 24, paddingTop: 32, gap: 16, flexGrow: 1 },
  brand: { color: "#fff", fontSize: 40, fontWeight: "800", letterSpacing: -1 },
  tagline: { color: "#A8A8B0", fontSize: 15, lineHeight: 21 },
  counter: {
    color: "#6EE7B7",
    fontSize: 13,
    fontWeight: "600",
    backgroundColor: "#16241B",
    borderRadius: 999,
    paddingHorizontal: 12,
    paddingVertical: 7,
    overflow: "hidden",
    alignSelf: "flex-start",
  },
  preview: {
    width: "100%",
    height: 220,
    borderRadius: 16,
    backgroundColor: "#1A1A1F",
  },
  thumbRow: { gap: 10, paddingVertical: 2 },
  thumbWrap: { position: "relative" },
  thumb: {
    width: 96,
    height: 96,
    borderRadius: 12,
    backgroundColor: "#1A1A1F",
  },
  thumbRemove: {
    position: "absolute",
    top: -6,
    right: -6,
    width: 24,
    height: 24,
    borderRadius: 12,
    backgroundColor: "#0E0E10",
    borderWidth: 1,
    borderColor: "#3A3A44",
    alignItems: "center",
    justifyContent: "center",
  },
  thumbRemoveText: { color: "#fff", fontSize: 16, lineHeight: 18, fontWeight: "700" },
  hintWrap: { gap: 6 },
  hintLabel: {
    color: "#8A8A96",
    fontSize: 12,
    fontWeight: "700",
    letterSpacing: 0.5,
    textTransform: "uppercase",
  },
  hintInput: {
    backgroundColor: "#17171C",
    borderRadius: 12,
    borderWidth: 1,
    borderColor: "#2E2E38",
    paddingHorizontal: 14,
    paddingVertical: 12,
    color: "#fff",
    fontSize: 15,
  },
  hintTip: { color: "#7A7A86", fontSize: 12, lineHeight: 17 },
  center: { alignItems: "center", gap: 12, paddingVertical: 24 },
  muted: { color: "#A8A8B0", fontSize: 15 },
  card: { backgroundColor: "#17171C", borderRadius: 20, padding: 20, gap: 10 },
  title: { color: "#fff", fontSize: 22, fontWeight: "700", lineHeight: 28 },
  badgeRow: { flexDirection: "row", flexWrap: "wrap", gap: 8 },
  badge: {
    backgroundColor: "#2A2A33",
    borderRadius: 999,
    paddingHorizontal: 12,
    paddingVertical: 6,
  },
  badgeSubtle: {
    backgroundColor: "#1C1A12",
    borderWidth: 1,
    borderColor: "#3A3320",
  },
  badgeText: {
    color: "#fff",
    fontSize: 13,
    fontWeight: "600",
    textTransform: "capitalize",
  },
  badgeTextSubtle: { color: "#F5D88A" },
  brandLine: { color: "#C8C8D0", fontSize: 15 },
  keywords: { color: "#7A7A86", fontSize: 13 },
  nudge: {
    backgroundColor: "#1C1A12",
    borderRadius: 16,
    borderWidth: 1,
    borderColor: "#3A3320",
    padding: 18,
    gap: 12,
  },
  nudgeTitle: { color: "#F5D88A", fontSize: 16, fontWeight: "700" },
  nudgeBody: { color: "#C8C8D0", fontSize: 14, lineHeight: 20 },
  sectionLabel: {
    color: "#8A8A96",
    fontSize: 12,
    fontWeight: "700",
    letterSpacing: 0.5,
    textTransform: "uppercase",
  },
  price: { color: "#fff", fontSize: 38, fontWeight: "800" },
  priceRange: { color: "#A8A8B0", fontSize: 15 },
  // Same green as the "best platform" lead — this line means "we checked".
  priceNote: { color: "#4ADE80", fontSize: 13, marginTop: 8 },
  priceNoteMuted: { color: "#8A8A93", fontSize: 13, marginTop: 8 },
  recLead: { color: "#4ADE80", fontSize: 17, fontWeight: "700" },
  reason: { color: "#C8C8D0", fontSize: 14, lineHeight: 20 },
  speed: { color: "#A8A8B0", fontSize: 13, marginBottom: 6 },
  row: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingVertical: 12,
    paddingHorizontal: 14,
    borderRadius: 12,
    backgroundColor: "#1E1E24",
  },
  rowBest: { borderWidth: 1.5, borderColor: "#4ADE80", backgroundColor: "#16241B" },
  rowLeft: { flex: 1, gap: 3 },
  rowNameWrap: { flexDirection: "row", alignItems: "center", gap: 8 },
  rowName: { color: "#fff", fontSize: 16, fontWeight: "600" },
  bestTag: {
    backgroundColor: "#4ADE80",
    borderRadius: 6,
    paddingHorizontal: 6,
    paddingVertical: 2,
  },
  bestTagText: { color: "#0E0E10", fontSize: 10, fontWeight: "800" },
  rowMeta: { color: "#7A7A86", fontSize: 12 },
  rowNet: { color: "#fff", fontSize: 18, fontWeight: "700", marginLeft: 10 },
  netNote: { color: "#6A6A76", fontSize: 12, fontStyle: "italic", marginTop: 4 },
  listingFieldLabel: { color: "#8A8A96", fontSize: 13, fontWeight: "600", marginTop: 4 },
  listingTitle: { color: "#fff", fontSize: 16, fontWeight: "700", lineHeight: 22 },
  listingBody: { color: "#C8C8D0", fontSize: 14, lineHeight: 21 },
  copyBtn: {
    backgroundColor: "#2A2A33",
    borderRadius: 12,
    paddingVertical: 13,
    alignItems: "center",
    marginTop: 4,
  },
  copyBtnText: { color: "#fff", fontSize: 15, fontWeight: "600" },
  errorBox: { backgroundColor: "#2A1416", borderRadius: 14, padding: 16 },
  errorText: { color: "#FFB4B4", fontSize: 15, lineHeight: 21 },
  // Amber, not red: hitting the cap is a limit, not a failure.
  limitBox: { backgroundColor: "#2A2416", borderRadius: 14, padding: 16 },
  limitText: { color: "#F5D68A", fontSize: 15, lineHeight: 21 },
  actions: { gap: 12, marginTop: 8 },
  primaryBtn: {
    backgroundColor: "#fff",
    borderRadius: 16,
    paddingVertical: 16,
    alignItems: "center",
  },
  primaryBtnText: { color: "#0E0E10", fontSize: 17, fontWeight: "700" },
  secondaryBtn: {
    backgroundColor: "transparent",
    borderColor: "#2E2E38",
    borderWidth: 1,
    borderRadius: 16,
    paddingVertical: 16,
    alignItems: "center",
  },
  secondaryBtnText: { color: "#fff", fontSize: 17, fontWeight: "600" },
  pressed: { opacity: 0.7 },
  disabled: { opacity: 0.4 },
});
