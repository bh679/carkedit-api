import { GameState } from "../schema/GameState.js";
import { Client } from "colyseus";
import { transitionToByeSetup, transitionAfterLiving } from "./LivingPhase.js";
import { transitionToEulogy } from "./EulogyPhase.js";

export function handleRevealDie(state: GameState, client: Client): void {
  if (state.phase !== "die_phase") return;
  if (state.currentTurn !== client.sessionId) return;

  const player = state.players.get(client.sessionId);
  if (!player) return;

  const dieCard = player.hand[0];
  if (!dieCard) return;

  dieCard.faceUp = true;
  console.log(`[DiePhase] ${player.name} revealed: "${dieCard.text}"`);
}

export function handleEndDieTurn(state: GameState, client: Client): void {
  if (state.phase !== "die_phase") return;
  if (state.currentTurn !== client.sessionId) return;

  const player = state.players.get(client.sessionId);
  if (!player) return;

  const dieCard = player.hand[0];
  if (!dieCard || !dieCard.faceUp) return;

  console.log(`[DiePhase] ${player.name} ended their turn`);

  // Mini die phase for a late joiner — resume the pending phase
  if (state.pendingPhase) {
    player.needsDieCard = false;
    const resumePhase = state.pendingPhase;
    state.pendingPhase = "";

    // Clear die card from hand before resuming (living/bye cards already dealt)
    player.hand.clear();

    // Re-deal the appropriate phase cards for this player
    if (resumePhase === "living_submit") {
      for (let i = 0; i < state.handSize; i++) {
        if (state.livingDeck.length > 0) {
          const card = state.livingDeck.splice(0, 1)[0];
          card.faceUp = true;
          player.hand.push(card);
        }
      }
    } else if (resumePhase === "bye_submit") {
      for (let i = 0; i < state.handSize; i++) {
        if (state.byeDeck.length > 0) {
          const card = state.byeDeck.splice(0, 1)[0];
          card.faceUp = true;
          player.hand.push(card);
        }
      }
      let hasWildcard = false;
      for (let i = 0; i < player.hand.length; i++) {
        if (player.hand[i].special === "Wildcard") {
          hasWildcard = true;
          break;
        }
      }
      player.hasWildcard = hasWildcard;
    }

    state.currentLivingDead = client.sessionId;
    state.currentTurn = client.sessionId;
    state.phase = resumePhase;
    console.log(`[DiePhase] Mini die phase complete — resuming ${resumePhase} with ${player.name} as Living Dead`);
    return;
  }

  const currentIndex = state.turnOrder.indexOf(client.sessionId);

  // Find next player who has a die card (skip late joiners with empty hands)
  let nextIndex = currentIndex + 1;
  while (nextIndex < state.turnOrder.length) {
    const nextPlayer = state.players.get(state.turnOrder[nextIndex]);
    if (nextPlayer && nextPlayer.hand.length > 0) break;
    nextIndex++;
  }

  if (nextIndex < state.turnOrder.length) {
    state.currentTurn = state.turnOrder[nextIndex];
    console.log(`[DiePhase] Next turn: ${state.currentTurn}`);
  } else {
    transitionAfterDie(state);
  }
}

/**
 * After die phase, transition to the first enabled phase: living → bye → eulogy → winner
 */
function transitionAfterDie(state: GameState): void {
  if (state.enableLive) {
    transitionToLivingSetup(state);
  } else if (state.enableBye) {
    transitionToByeSetup(state);
  } else if (state.enableEulogy) {
    transitionToEulogy(state);
  } else {
    state.phase = "winner";
    console.log(`[DiePhase] All phases disabled — going to winner`);
  }
}

function transitionToLivingSetup(state: GameState): void {
  console.log(`[DiePhase] All players revealed — transitioning to Living phase`);

  state.players.forEach((player) => {
    player.hand.clear();
    player.hasBeenLivingDead = false;
  });

  const playerIds = Array.from(state.turnOrder);
  for (const playerId of playerIds) {
    const player = state.players.get(playerId);
    if (!player) continue;

    for (let i = 0; i < state.handSize; i++) {
      if (state.livingDeck.length > 0) {
        const card = state.livingDeck.splice(0, 1)[0];
        card.faceUp = true;
        player.hand.push(card);
      }
    }
  }

  state.currentLivingDead = state.turnOrder[0];
  state.currentTurn = state.turnOrder[0];
  state.round = 0;
  state.phase = "living_submit";

  console.log(`[LivingPhase] Setup complete — ${state.currentLivingDead} is The Living Dead`);
}
