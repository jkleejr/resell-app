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
