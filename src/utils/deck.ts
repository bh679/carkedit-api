import { Card } from "../schema/Card.js";
import { DieCardData } from "../data/cards.js";

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

const WILDCARD_COUNT = 2;

export function createByeDeckWithWildcards(texts: string[]): Card[] {
  const deck = createDeck(texts, "bye");
  for (let i = 0; i < WILDCARD_COUNT; i++) {
    const card = new Card();
    card.id = `wildcard-${i}`;
    card.text = "Wildcard Eulogy";
    card.deck = "bye";
    card.faceUp = false;
    card.submittedBy = "";
    card.special = "Wildcard";
    deck.push(card);
  }
  return deck;
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
