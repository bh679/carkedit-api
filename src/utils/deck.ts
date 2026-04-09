import { ArraySchema } from "@colyseus/schema";
import { Card } from "../schema/Card.js";
import { CardData } from "../data/cards.js";
import type { ExpansionCard } from "../db/types.js";

export function shuffle<T>(array: T[]): T[] {
  const shuffled = [...array];
  for (let i = shuffled.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
  }
  return shuffled;
}

export function createDeck(cards: CardData[], deckType: string): Card[] {
  return cards.map((data) => {
    const card = new Card();
    card.id = String(data.id);
    card.text = data.text;
    card.deck = deckType;
    card.faceUp = false;
    card.submittedBy = "";
    if (data.special) card.special = data.special;
    if (data.packId) card.packId = data.packId;
    if (data.prompt) card.prompt = data.prompt;
    if (data.image_url) card.image_url = data.image_url;
    if (Array.isArray(data.options) && data.options.length > 0) {
      card.options = new ArraySchema<string>(...data.options);
    }
    return card;
  });
}

/**
 * Convert expansion_cards DB rows to CardData buckets keyed by the game's
 * deck type names. Note DB uses 'live' while the game engine uses 'living'.
 */
export function expansionCardsToCardData(cards: ExpansionCard[]): {
  die: CardData[];
  living: CardData[];
  bye: CardData[];
} {
  const result: { die: CardData[]; living: CardData[]; bye: CardData[] } = {
    die: [],
    living: [],
    bye: [],
  };
  for (const c of cards) {
    const bucket: "die" | "living" | "bye" =
      c.deck_type === "live" ? "living" : (c.deck_type as "die" | "bye");
    let parsedOptions: string[] | undefined;
    if (c.options_json) {
      try {
        const parsed = JSON.parse(c.options_json);
        if (Array.isArray(parsed) && parsed.every((o) => typeof o === "string")) {
          parsedOptions = parsed;
        }
      } catch { /* ignore malformed json */ }
    }
    result[bucket].push({
      id: c.id,
      text: c.text,
      packId: c.pack_id,
      prompt: c.prompt ?? null,
      special: c.card_special ?? undefined,
      options: parsedOptions,
      image_url: c.image_url ?? null,
    });
  }
  return result;
}

/**
 * Merge base-game card arrays with expansion card arrays.
 */
export function mergeDecks(
  baseDie: CardData[],
  baseLiving: CardData[],
  baseBye: CardData[],
  ext: { die: CardData[]; living: CardData[]; bye: CardData[] }
): { die: CardData[]; living: CardData[]; bye: CardData[] } {
  return {
    die: [...baseDie, ...ext.die],
    living: [...baseLiving, ...ext.living],
    bye: [...baseBye, ...ext.bye],
  };
}
