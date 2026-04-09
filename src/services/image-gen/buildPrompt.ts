// CarkedIt API — prompt assembly from card data + style JSON
//
// The admin test page sends the user's structured style JSON plus the card
// context (text/prompt/deck). This module flattens them into a single prompt
// string that most image-gen providers accept as-is.

import type { StyleJson } from "./types.js";

export interface BuildPromptInput {
  cardText: string;
  cardPrompt?: string | null;
  deckType?: string | null;
  style?: StyleJson | null;
}

/**
 * Convert a camelCase or snake_case style key into a human-friendly phrase.
 *   "renderStyle"   -> "render style"
 *   "brandAesthetic" -> "brand aesthetic"
 */
export function humanizeKey(key: string): string {
  return key
    .replace(/_/g, " ")
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .toLowerCase();
}

/**
 * Deterministic assembly of a prompt from card + style data.
 *
 * Shape:
 *   "<deckPrefix>: <cardText>. <cardPrompt>. (<deckAnnotation>).
 *    Style: renderStyle: ...; lineWork: ...; ..."
 *
 * Per-deck config is pulled from `style.decks[deckType]` which is a
 * nested `{ prefix, annotation }` object:
 *   - `prefix`     — prepended to the card section as `"<prefix>: <cardText>…"`
 *   - `annotation` — parenthesized and appended to the card sentences
 *                    ("<cardText>. (<annotation>)")
 * Either or both can be empty; empty = nothing inserted. The nested
 * `decks` object is filtered out of the style iteration so it never
 * appears verbatim in the style clause.
 *
 * Empty/whitespace fields are dropped so the result never has dangling
 * punctuation. The order of style fields follows the order of the input
 * object, which is stable in modern JS engines.
 */
export function buildPrompt(input: BuildPromptInput): string {
  const { cardText, cardPrompt, deckType, style } = input;

  // Extract per-deck config from the nested `decks` sub-object.
  let deckPrefix = "";
  let deckAnnotation = "";
  if (style && typeof style === "object") {
    const nested = (style as Record<string, any>).decks;
    if (nested && typeof nested === "object" && deckType) {
      const cfg = nested[deckType];
      if (cfg && typeof cfg === "object") {
        if (typeof cfg.prefix === "string" && cfg.prefix.trim()) {
          deckPrefix = cfg.prefix.trim();
        }
        if (typeof cfg.annotation === "string" && cfg.annotation.trim()) {
          deckAnnotation = cfg.annotation.trim();
        }
      }
    }
  }

  const cardParts: string[] = [];
  if (cardText && cardText.trim()) cardParts.push(cardText.trim());
  if (cardPrompt && cardPrompt.trim()) cardParts.push(cardPrompt.trim());
  if (deckAnnotation) cardParts.push(`(${deckAnnotation})`);
  const cardBody = cardParts.join(". ");
  const cardSection = deckPrefix && cardBody
    ? `${deckPrefix}: ${cardBody}`
    : (deckPrefix || cardBody);

  let styleSection = "";
  if (style && typeof style === "object") {
    const styleParts = Object.entries(style)
      // Skip the nested `decks` object — its prefix/annotation are used
      // above, not as flat style fields.
      .filter(([k, v]) => k !== "decks" && typeof v === "string" && v.trim().length > 0)
      .map(([k, v]) => `${humanizeKey(k)}: ${(v as string).trim()}`);
    if (styleParts.length > 0) {
      styleSection = `Style: ${styleParts.join("; ")}.`;
    }
  }

  if (cardSection && styleSection) return `${cardSection}. ${styleSection}`;
  if (cardSection) return `${cardSection}.`;
  return styleSection;
}
