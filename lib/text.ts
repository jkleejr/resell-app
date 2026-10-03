// Cleanup for every model-written string that reaches the app's UI.
//
// Both functions here exist because of the same user-visible failure — a
// listing that LOOKS cut off — reached by two different routes.

/**
 * Characters that are invisible, or that a text layout engine treats as a line
 * break, but that JS `\s` does NOT match — so a plain `\s+` collapse leaves
 * them in place.
 *
 * U+0085 (NEL) is the dangerous one. It sits just past the end of a control
 * strip written as the C0 range, and `\s` does not cover it, yet iOS breaks a
 * line on it. A single trailing NEL renders an empty final line in the app,
 * which reads to the seller as text that got chopped off.
 *
 * Written as codepoint ranges rather than a regex character class because the
 * escapes involved are exactly the kind that get mangled in transit.
 */
function isInvisible(code: number): boolean {
  return (
    code <= 0x1f || // C0 controls
    (code >= 0x7f && code <= 0x9f) || // DEL and the C1 controls, incl. NEL
    (code >= 0x200b && code <= 0x200f) || // zero-width spaces and bidi marks
    code === 0x2028 || // line separator
    code === 0x2029 || // paragraph separator
    code === 0x2060 || // word joiner
    code === 0xfeff // byte-order mark
  );
}

/** Strip control/invisible characters and tag-like fragments, then collapse. */
export function cleanText(value: unknown): string {
  if (typeof value !== "string") return "";
  const visible = Array.from(value, (ch) =>
    isInvisible(ch.codePointAt(0) ?? 0) ? " " : ch,
  ).join("");
  return visible
    .replace(/<[^>]*>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Drop a trailing half-sentence.
 *
 * The seller pastes this text into a listing without reading it first, so a
 * description that stops mid-clause ("Keyboard and trackpad visible and") goes
 * out to buyers exactly like that. The only thing worse than a short
 * description is a broken one, so an unterminated tail is cut rather than
 * shipped. Returning "" is a valid outcome — the app then omits the
 * description block entirely, which is honest.
 *
 * This is a backstop, not the fix: a response truncated by the token cap is
 * caught upstream in analyze.ts. It stays because this is the last place that
 * can tell, and it costs nothing when everything is well.
 */
export function completeSentences(text: string): string {
  if (!text) return "";
  // Already ends on a terminator, possibly inside a closing quote or bracket.
  if (/[.!?]["'’)\]]?$/.test(text)) return text;
  const cut = Math.max(
    text.lastIndexOf("."),
    text.lastIndexOf("!"),
    text.lastIndexOf("?"),
  );
  return cut === -1 ? "" : text.slice(0, cut + 1).trim();
}

/**
 * Sentences that report what the model could not work out, or that hand the
 * question to the buyer. Both are the same move — the model has run out of
 * facts and reaches for the one thing it always has left.
 *
 * The prompt forbids all of this at length and mostly obeys, but "mostly" is
 * not a guarantee, and adding a worked WRONG example made one photo reproduce
 * it verbatim. So the rule is enforced here instead, where it cannot drift.
 *
 * Deliberately narrow. "Charger not included" and "No saucer included" are
 * real, useful listing facts and must survive; what is caught is uncertainty
 * about the IDENTIFICATION ("model year not visible") and instructions to the
 * buyer ("please verify before purchasing").
 */
const HEDGE_PATTERNS: RegExp[] = [
  /\bnot (?:visible|listed|confirmed|verified|specified|identifiable|discernible|legible)\b/i,
  /\b(?:cannot|can't|could not|couldn't|unable to) (?:be )?(?:confirm|verify|determine|identify|read)/i,
  /\bplease (?:verify|confirm|inquire|ask|contact|message|check)\b/i,
  /\b(?:inquire|message me|contact me|ask before (?:buying|purchasing)|ask for details)\b/i,
  /\b(?:exact|specific) (?:year|model|make|specs?|specifications?|size)\b[^.!?]*\bnot\b/i,
  /\b(?:unknown|unclear|undetermined|unverified)\b/i,
  // The model explaining how it identified the item, or grading its own
  // evidence: "The slim form factor is identifiable by its rounded top." Its
  // reasoning, not a fact about the item, and the prompt's ban alone kept
  // letting it through.
  /\b(?:identifiable|recogni[sz]able|distinguishable) (?:by|from|as)\b/i,
  /\bconsistent with\b[^.!?]*\b(?:use|wear|age)\b/i,
  // Reporting the absence of flaws: "shows no visible wear", "no signs of
  // damage". General condition, which the prompt keeps out of the copy; a
  // real flaw is disclosed on its own. "No band included" does not match.
  /\bno (?:visible |obvious |noticeable )?(?:signs? of )?(?:wear|damage|scratches|scuffs|cracks|chips|dents|stains|flaws)\b/i,
  // General wear, which the prompt also keeps out: "shows general use wear",
  // "light signs of wear". A specific flaw ("One knob cap is missing.") is its
  // own sentence and does not match.
  /\b(?:general|normal|light|minor|typical|everyday|some|surface) (?:use |signs of )?wear\b/i,
];

/**
 * Drop whole sentences that hedge, keeping the ones that state facts.
 *
 * Works at sentence granularity because that is the unit the failure arrives
 * in — the model finishes its real description and then appends a caveat. An
 * empty result is fine and means every sentence was a caveat.
 */
export function dropHedges(text: string): string {
  if (!text) return "";
  const kept = text
    .split(/(?<=[.!?])\s+/)
    .filter((sentence) => !HEDGE_PATTERNS.some((re) => re.test(sentence)));
  return kept.join(" ").trim();
}

/**
 * The title's version of dropHedges: remove a segment that hedges the model
 * ("— Series 3 or Later", ", or similar"). The prompt forbids it, but a title
 * is the first thing a buyer reads, so it is enforced here too. Only whole
 * trailing segments go — the part before the dash or comma is the name.
 */
const TITLE_HEDGE = /\bor (?:later|newer|earlier|older|similar)\b/i;

export function dropTitleHedges(title: string): string {
  const parts = title.split(/(\s+[—–-]\s+|,\s+)/);
  // parts alternates text, separator, text, …; walk back from the end.
  while (parts.length > 2 && TITLE_HEDGE.test(parts[parts.length - 1]!)) {
    parts.splice(-2, 2);
  }
  return parts.join("").trim();
}

// A language name the app shows as a badge, so it must be one: a word or two of
// letters, never English (nothing was translated), never a sentence. Anything
// else is blank — a missing badge costs nothing, a wrong one is on screen.
export function cleanLanguage(value: unknown): string {
  if (typeof value !== "string") return "";
  const name = cleanText(value).replace(/\.$/, "");
  if (!/^[A-Za-z][A-Za-z'-]*( [A-Za-z][A-Za-z'-]*)?$/.test(name)) return "";
  if (/^(english|none|n\/?a|unknown)$/i.test(name)) return "";
  return name
    .split(" ")
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase())
    .join(" ");
}
