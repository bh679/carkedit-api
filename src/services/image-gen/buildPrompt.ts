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
 *   "<cardText>. <cardPrompt>. (<deckType> card for a board game).
 *    Style: renderStyle: ...; lineWork: ...; ..."
 *
 * Empty/whitespace fields are dropped so the result never has dangling
 * punctuation. The order of style fields follows the order of the input
 * object, which is stable in modern JS engines.
 */
export function buildPrompt(input: BuildPromptInput): string {
  const { cardText, cardPrompt, deckType, style } = input;

  const cardParts: string[] = [];
  if (cardText && cardText.trim()) cardParts.push(cardText.trim());
  if (cardPrompt && cardPrompt.trim()) cardParts.push(cardPrompt.trim());
  if (deckType && deckType.trim()) {
    cardParts.push(`(${deckType.trim()} card for a board game)`);
  }
  const cardSection = cardParts.join(". ");

  let styleSection = "";
  if (style && typeof style === "object") {
    const styleParts = Object.entries(style)
      .filter(([, v]) => typeof v === "string" && v.trim().length > 0)
      .map(([k, v]) => `${humanizeKey(k)}: ${v.trim()}`);
    if (styleParts.length > 0) {
      styleSection = `Style: ${styleParts.join("; ")}.`;
    }
  }

  if (cardSection && styleSection) return `${cardSection}. ${styleSection}`;
  if (cardSection) return `${cardSection}.`;
  return styleSection;
}
