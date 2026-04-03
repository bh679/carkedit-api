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

  const currentIndex = state.turnOrder.indexOf(client.sessionId);
  const nextIndex = currentIndex + 1;

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
  state.round = 1;
  state.phase = "living_submit";

  console.log(`[LivingPhase] Setup complete — ${state.currentLivingDead} is The Living Dead`);
}
