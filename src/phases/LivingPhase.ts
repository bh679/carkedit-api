import { GameState } from "../schema/GameState.js";
import { Client } from "colyseus";

export function handleSubmitCard(state: GameState, client: Client, cardIndex: number): void {
  // Validate phase is living_submit or bye_submit
  const validPhases = ["living_submit", "bye_submit"];
  if (!validPhases.includes(state.phase)) return;

  // Cannot submit if you ARE The Living Dead
  if (state.currentLivingDead === client.sessionId) return;

  const player = state.players.get(client.sessionId);
  if (!player) return;

  // Cannot submit twice
  if (player.hasSubmitted) return;

  // Validate cardIndex
  if (cardIndex < 0 || cardIndex >= player.hand.length) return;

  // Remove card from hand
  const card = player.hand.splice(cardIndex, 1)[0];
  if (!card) return;

  // Add to submitted cards (face-down, with submitter tracking)
  card.faceUp = false;
  card.submittedBy = client.sessionId;
  state.submittedCards.push(card);

  player.hasSubmitted = true;

  console.log(`[LivingPhase] ${player.name} submitted a card`);

  // Check if all non-Living-Dead players have submitted
  if (allPlayersSubmitted(state)) {
    transitionToConvince(state);
  }
}

export function handleRevealSubmission(state: GameState, client: Client): void {
  // Validate phase
  const validPhases = ["living_convince", "bye_convince"];
  if (!validPhases.includes(state.phase)) return;

  // Must be this player's convincing turn
  if (state.convincingTurn !== client.sessionId) return;

  // Find this player's submitted card and flip it face-up
  for (let i = 0; i < state.submittedCards.length; i++) {
    const card = state.submittedCards[i];
    if (card.submittedBy === client.sessionId) {
      card.faceUp = true;
      const player = state.players.get(client.sessionId);
      console.log(`[LivingPhase] ${player?.name} revealed: "${card.text}"`);
      break;
    }
  }
}

export function handleEndConvinceTurn(state: GameState, client: Client): void {
  // Validate phase
  const validPhases = ["living_convince", "bye_convince"];
  if (!validPhases.includes(state.phase)) return;

  // Must be this player's convincing turn
  if (state.convincingTurn !== client.sessionId) return;

  // Their card must already be revealed
  const hasRevealed = state.submittedCards.some(
    (card) => card.submittedBy === client.sessionId && card.faceUp
  );
  if (!hasRevealed) return;

  const player = state.players.get(client.sessionId);
  console.log(`[LivingPhase] ${player?.name} finished convincing`);

  // Find next convincer (next non-Living-Dead player in turnOrder who hasn't convinced yet)
  const nextConvincer = getNextConvincer(state);

  if (nextConvincer) {
    state.convincingTurn = nextConvincer;
    console.log(`[LivingPhase] Next convincer: ${nextConvincer}`);
  } else {
    // All have convinced — transition to selection
    transitionToSelect(state);
  }
}

export function handleSelectWinner(state: GameState, client: Client, cardIndex: number): void {
  // Validate phase
  const validPhases = ["living_select", "bye_select"];
  if (!validPhases.includes(state.phase)) return;

  // Must be The Living Dead selecting
  if (state.currentLivingDead !== client.sessionId) return;

  // Validate cardIndex into submittedCards
  if (cardIndex < 0 || cardIndex >= state.submittedCards.length) return;

  const winningCard = state.submittedCards[cardIndex];
  const winnerId = winningCard.submittedBy;
  const winner = state.players.get(winnerId);

  if (winner) {
    winner.score += 1;
    console.log(`[LivingPhase] ${winner.name} wins this round! Score: ${winner.score}`);
  }

  // Mark current Living Dead as having been Living Dead
  const livingDead = state.players.get(state.currentLivingDead);
  if (livingDead) {
    livingDead.hasBeenLivingDead = true;
  }

  // Clear submitted cards
  state.submittedCards.clear();

  // Reset hasSubmitted for all players
  state.players.forEach((p) => {
    p.hasSubmitted = false;
  });

  // Find next Living Dead (next player in turnOrder who hasn't been Living Dead)
  const nextLivingDead = getNextLivingDead(state);

  if (nextLivingDead) {
    // Continue with next Living Dead
    state.currentLivingDead = nextLivingDead;
    state.currentTurn = nextLivingDead;
    state.round++;

    // Determine if we're in living or bye phase and go back to submit
    if (state.phase === "living_select") {
      state.phase = "living_submit";
    } else {
      state.phase = "bye_submit";
    }

    console.log(`[LivingPhase] Next Living Dead: ${nextLivingDead}`);
  } else {
    // All players have been Living Dead
    if (state.phase === "living_select") {
      // Transition to Bye phase
      transitionToByeSetup(state);
    } else {
      // Bye phase complete — game over
      state.phase = "game_over";
      console.log(`[GameOver] Game finished!`);
      // Log final scores
      state.players.forEach((p) => {
        console.log(`  ${p.name}: ${p.score} points`);
      });
    }
  }
}

// --- Helper functions ---

function allPlayersSubmitted(state: GameState): boolean {
  let allSubmitted = true;
  state.players.forEach((player, sessionId) => {
    if (sessionId === state.currentLivingDead) return; // Skip Living Dead
    if (!player.hasSubmitted) allSubmitted = false;
  });
  return allSubmitted;
}

function transitionToConvince(state: GameState): void {
  console.log(`[LivingPhase] All cards submitted — entering convincing phase`);

  // Find first non-Living-Dead player in turnOrder
  const firstConvincer = getFirstNonLivingDead(state);
  if (!firstConvincer) return;

  state.convincingTurn = firstConvincer;

  if (state.phase === "living_submit") {
    state.phase = "living_convince";
  } else {
    state.phase = "bye_convince";
  }
}

function transitionToSelect(state: GameState): void {
  console.log(`[LivingPhase] All players convinced — Living Dead selects winner`);

  if (state.phase === "living_convince") {
    state.phase = "living_select";
  } else {
    state.phase = "bye_select";
  }

  // currentTurn stays as Living Dead (they're the one selecting)
  state.currentTurn = state.currentLivingDead;
}

function getFirstNonLivingDead(state: GameState): string | null {
  for (let i = 0; i < state.turnOrder.length; i++) {
    if (state.turnOrder[i] !== state.currentLivingDead) {
      return state.turnOrder[i];
    }
  }
  return null;
}

function getNextConvincer(state: GameState): string | null {
  // Find current convincer's index, then look for next non-Living-Dead player
  // whose card hasn't been revealed yet
  const currentIndex = state.turnOrder.indexOf(state.convincingTurn);

  for (let i = currentIndex + 1; i < state.turnOrder.length; i++) {
    const playerId = state.turnOrder[i];
    if (playerId === state.currentLivingDead) continue;

    // Check if they have an unrevealed submitted card
    const hasUnrevealedCard = state.submittedCards.some(
      (card) => card.submittedBy === playerId && !card.faceUp
    );
    if (hasUnrevealedCard) {
      return playerId;
    }
  }

  return null;
}

function getNextLivingDead(state: GameState): string | null {
  for (let i = 0; i < state.turnOrder.length; i++) {
    const playerId = state.turnOrder[i];
    const player = state.players.get(playerId);
    if (player && !player.hasBeenLivingDead) {
      return playerId;
    }
  }
  return null;
}

function transitionToByeSetup(state: GameState): void {
  console.log(`[LivingPhase] Living phase complete — transitioning to Bye phase`);

  const CARDS_PER_PLAYER = 5;

  // Clear hands and reset Living Dead tracking
  state.players.forEach((player) => {
    player.hand.clear();
    player.hasBeenLivingDead = false;
    player.hasSubmitted = false;
  });

  // Deal 5 Bye cards per player
  const playerIds = Array.from(state.turnOrder);
  for (const playerId of playerIds) {
    const player = state.players.get(playerId);
    if (!player) continue;

    for (let i = 0; i < CARDS_PER_PLAYER; i++) {
      if (state.byeDeck.length > 0) {
        const card = state.byeDeck.splice(0, 1)[0];
        card.faceUp = true;
        player.hand.push(card);
      }
    }
  }

  // Set first player as Living Dead for Bye phase
  state.currentLivingDead = state.turnOrder[0];
  state.currentTurn = state.turnOrder[0];
  state.round = 1;
  state.phase = "bye_submit";

  console.log(`[ByePhase] Setup complete — ${state.currentLivingDead} is The Living Dead`);
}
