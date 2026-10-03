import assert from "node:assert/strict";
import { test } from "node:test";
import {
  cleanLanguage,
  completeSentences,
  dropHedges,
  dropTitleHedges,
} from "../lib/text.js";

test("drops a sentence explaining how the item was identified", () => {
  assert.equal(
    dropHedges(
      "Sony PlayStation 4 Slim console in black. The slim form factor is identifiable by its rounded, compact profile.",
    ),
    "Sony PlayStation 4 Slim console in black.",
  );
});

test("drops a wear sentence that grades the photo", () => {
  assert.equal(
    dropHedges(
      "GoPro action camera in black. The body shows light wear consistent with normal use.",
    ),
    "GoPro action camera in black.",
  );
});

test("keeps disclosed flaws and plain facts", () => {
  const text =
    "Akai Professional MPK Mini 25-key USB MIDI keyboard controller in black. One knob cap is missing. Charger not included.";
  assert.equal(dropHedges(text), text);
});

test("drops a hedged tail from a title", () => {
  assert.equal(
    dropTitleHedges("Apple Watch Space Gray Aluminum Case — Series 3 or Later"),
    "Apple Watch Space Gray Aluminum Case",
  );
  assert.equal(
    dropTitleHedges("Leather Tote Bag, Brown, Coach or Similar"),
    "Leather Tote Bag, Brown",
  );
  assert.equal(
    dropTitleHedges("Canon EF 50mm f/1.8 STM Lens, Black"),
    "Canon EF 50mm f/1.8 STM Lens, Black",
  );
});

test("drops a sentence reporting no flaws, keeps what is included", () => {
  assert.equal(
    dropHedges(
      "Nintendo Switch OLED model in white. The console and dock show no visible wear. No band included.",
    ),
    "Nintendo Switch OLED model in white. No band included.",
  );
});

test("drops general wear, keeps the specific flaw", () => {
  assert.equal(
    dropHedges(
      "Akai MPK Mini USB MIDI keyboard controller in black. The unit shows general use wear including dust and light scuffing on the control surface. One knob cap (K5) is missing.",
    ),
    "Akai MPK Mini USB MIDI keyboard controller in black. One knob cap (K5) is missing.",
  );
});

test("drops wear explained away as use", () => {
  assert.equal(
    dropHedges(
      "Akai MPK Mini 25-key USB MIDI keyboard controller in black. The knob section shows surface wear and dust consistent with regular studio use.",
    ),
    "Akai MPK Mini 25-key USB MIDI keyboard controller in black.",
  );
});

test("keeps a language name for the translated-from badge", () => {
  assert.equal(cleanLanguage("Japanese"), "Japanese");
  assert.equal(cleanLanguage("traditional chinese"), "Traditional Chinese");
  assert.equal(cleanLanguage(" Korean. "), "Korean");
});

test("blanks the badge when nothing was translated or the value isn't a language", () => {
  assert.equal(cleanLanguage(""), "");
  assert.equal(cleanLanguage("English"), "");
  assert.equal(cleanLanguage("none"), "");
  assert.equal(cleanLanguage("N/A"), "");
  assert.equal(cleanLanguage("The label is in Japanese"), "");
  assert.equal(cleanLanguage(42), "");
});

test("keeps a sentence about what the item is made for", () => {
  const text =
    "Nike Air Max 90 sneakers in white. Comfortable cushioning made for everyday wear.";
  assert.equal(dropHedges(text), text);
});

test("keeps a product name that contains a hedge word", () => {
  const text = "Joy Division Unknown Pleasures vinyl LP.";
  assert.equal(dropHedges(text), text);
});

test("still drops a sentence that opens on a hedge word", () => {
  assert.equal(
    dropHedges("Vintage brass desk lamp. Unknown maker."),
    "Vintage brass desk lamp.",
  );
});

test("cuts an unfinished tail at a sentence end, not a decimal point", () => {
  assert.equal(
    completeSentences("Bose SoundLink speaker. It has a 3.5mm aux input and"),
    "Bose SoundLink speaker.",
  );
  assert.equal(
    completeSentences("Apple iPhone 13 with a 6.1-inch display and"),
    "",
  );
});

test("keeps text that already ends a sentence", () => {
  const text = "Apple iPhone 13 with a 6.1-inch display.";
  assert.equal(completeSentences(text), text);
});
