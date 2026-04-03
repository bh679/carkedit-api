import { Card } from "../schema/Card.js";
import { CardData } from "../data/cards.js";

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
    return card;
  });
}
