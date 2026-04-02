import { Card } from "../schema/Card";
import { DieCardData } from "../data/cards";

export function shuffle<T>(array: T[]): T[] {
  const shuffled = [...array];
  for (let i = shuffled.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
  }
  return shuffled;
}

export function createDeck(texts: string[], deckType: string): Card[] {
  return texts.map((text, index) => {
    const card = new Card();
    card.id = `${deckType}-${index}`;
    card.text = text;
    card.deck = deckType;
    card.faceUp = false;
    card.submittedBy = "";
    return card;
  });
}

export function createDieDeck(cards: DieCardData[]): Card[] {
  return cards.map((data) => {
    const card = new Card();
    card.id = String(data.id);
    card.text = data.text;
    card.deck = "die";
    card.faceUp = false;
    card.submittedBy = "";
    return card;
  });
}
