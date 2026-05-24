import { GameState } from "../schema/GameState.js";
import { Player } from "../schema/Player.js";
import { Card } from "../schema/Card.js";
import { getFirstNonLivingDead, getNextConvincer } from "./LivingPhase.js";

function makeCard(submittedBy: string, faceUp = false): Card {
  const c = new Card();
  c.id = `card-${submittedBy}`;
  c.text = `card from ${submittedBy}`;
  c.deck = "living";
  c.faceUp = faceUp;
  c.submittedBy = submittedBy;
  return c;
}

function makeState(playerIds: string[], livingDead: string): GameState {
  const state = new GameState();
  for (const id of playerIds) {
    const p = new Player();
    p.sessionId = id;
    p.name = id;
    state.players.set(id, p);
    state.turnOrder.push(id);
  }
  state.currentLivingDead = livingDead;
  // Every non-LD player has submitted a face-down card
  for (const id of playerIds) {
    if (id === livingDead) continue;
    state.submittedCards.push(makeCard(id, false));
  }
  return state;
}

describe("pitch order rotation", () => {
  describe("getFirstNonLivingDead", () => {
    it("returns the player immediately after the Living Dead (LD = p1)", () => {
      const state = makeState(["p1", "p2", "p3", "p4"], "p1");
      expect(getFirstNonLivingDead(state)).toBe("p2");
    });

    it("returns the player immediately after the Living Dead (LD = p2)", () => {
      const state = makeState(["p1", "p2", "p3", "p4"], "p2");
      expect(getFirstNonLivingDead(state)).toBe("p3");
    });

    it("returns the player immediately after the Living Dead (LD = p3)", () => {
      const state = makeState(["p1", "p2", "p3", "p4"], "p3");
      expect(getFirstNonLivingDead(state)).toBe("p4");
    });

    it("wraps to the start when the Living Dead is last (LD = p4)", () => {
      const state = makeState(["p1", "p2", "p3", "p4"], "p4");
      expect(getFirstNonLivingDead(state)).toBe("p1");
    });

    it("returns null when no non-LD player has submitted a card", () => {
      const state = new GameState();
      ["p1", "p2"].forEach((id) => {
        const p = new Player();
        p.sessionId = id;
        state.players.set(id, p);
        state.turnOrder.push(id);
      });
      state.currentLivingDead = "p1";
      // No submitted cards
      expect(getFirstNonLivingDead(state)).toBeNull();
    });
  });

  describe("getNextConvincer", () => {
    it("walks clockwise and wraps past the Living Dead (LD = p2)", () => {
      // LD = p2; pitch order should be p3 → p4 → p1
      const state = makeState(["p1", "p2", "p3", "p4"], "p2");

      // First pitcher is p3
      state.convincingTurn = "p3";
      // Mark p3 revealed before asking who's next
      state.submittedCards.find((c) => c.submittedBy === "p3")!.faceUp = true;
      expect(getNextConvincer(state)).toBe("p4");

      // p4 next
      state.convincingTurn = "p4";
      state.submittedCards.find((c) => c.submittedBy === "p4")!.faceUp = true;
      expect(getNextConvincer(state)).toBe("p1");

      // p1 last — wraps past LD
      state.convincingTurn = "p1";
      state.submittedCards.find((c) => c.submittedBy === "p1")!.faceUp = true;
      // Everyone revealed → no next convincer
      expect(getNextConvincer(state)).toBeNull();
    });

    it("walks clockwise and wraps when Living Dead is last (LD = p4)", () => {
      // LD = p4; pitch order should be p1 → p2 → p3
      const state = makeState(["p1", "p2", "p3", "p4"], "p4");

      state.convincingTurn = "p1";
      state.submittedCards.find((c) => c.submittedBy === "p1")!.faceUp = true;
      expect(getNextConvincer(state)).toBe("p2");

      state.convincingTurn = "p2";
      state.submittedCards.find((c) => c.submittedBy === "p2")!.faceUp = true;
      expect(getNextConvincer(state)).toBe("p3");

      state.convincingTurn = "p3";
      state.submittedCards.find((c) => c.submittedBy === "p3")!.faceUp = true;
      expect(getNextConvincer(state)).toBeNull();
    });
  });
});
