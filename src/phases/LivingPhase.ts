import { GameState } from "../schema/GameState.js";
import { Client } from "colyseus";
import { transitionToEulogy } from "./EulogyPhase.js";

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
    transitionToReveal(state);
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

  // Store winner info for announcement
  state.roundWinner = winnerId;
  state.roundWinnerCardIndex = cardIndex;

  // Transfer wildcard ownership to the Living Dead (chooser) if a wildcard was chosen
  if (state.phase === "bye_select" && winningCard.special === "Wildcard") {
    const livingDead = state.players.get(state.currentLivingDead);
    if (livingDead) {
      livingDead.hasWildcard = true;
      console.log(`[LivingPhase] Wildcard chosen — transferring ownership to ${livingDead.name}`);
    }
    // Remove from submitter if they have no other wildcards in hand
    if (winner && winnerId !== state.currentLivingDead) {
      let hasOtherWildcard = false;
      for (let i = 0; i < winner.hand.length; i++) {
        if (winner.hand[i].special === "Wildcard") {
          hasOtherWildcard = true;
          break;
        }
      }
      winner.hasWildcard = hasOtherWildcard;
    }
  }

  // Transition to winner announcement phase
  if (state.phase === "living_select") {
    state.phase = "living_winner";
  } else {
    state.phase = "bye_winner";
  }
}

export function handleNextRound(state: GameState, _client?: Client): void {
  // Validate phase
  const validPhases = ["living_winner", "bye_winner"];
  if (!validPhases.includes(state.phase)) return;

  const wasLiving = state.phase === "living_winner";

  // Log player states for late-join debugging
  state.players.forEach((p, sid) => {
    console.log(`[LivingPhase] handleNextRound: ${p.name} — hasBeenLD=${p.hasBeenLivingDead}, needsDie=${p.needsDieCard}, hand=${p.hand.length}, submitted=${p.hasSubmitted}`);
  });

  // Capture winning card index before clearing
  const winningIdx = state.roundWinnerCardIndex;

  // Clear winner info
  state.roundWinner = "";
  state.roundWinnerCardIndex = -1;

  // Mark current Living Dead as having been Living Dead
  const livingDead = state.players.get(state.currentLivingDead);
  if (livingDead) {
    livingDead.hasBeenLivingDead = true;
  }

  // Return non-winning submitted cards to the bottom of the deck
  const deck = wasLiving ? state.livingDeck : state.byeDeck;
  for (let i = 0; i < state.submittedCards.length; i++) {
    if (i === winningIdx) continue; // winning card is consumed
    const card = state.submittedCards[i];
    card.faceUp = false;
    card.submittedBy = "";
    deck.push(card);
  }

  // Clear submitted cards
  state.submittedCards.clear();

  // Reset hasSubmitted for all players
  state.players.forEach((p) => {
    p.hasSubmitted = false;
  });

  // Refill each player's hand up to handSize from the deck
  const refillDeck = wasLiving ? state.livingDeck : state.byeDeck;
  state.players.forEach((player, sessionId) => {
    if (sessionId === state.currentLivingDead) return; // Living Dead doesn't submit
    if (player.needsDieCard) return; // skip late joiners awaiting die card
    while (player.hand.length < state.handSize && refillDeck.length > 0) {
      const card = refillDeck.splice(0, 1)[0];
      card.faceUp = true;
      player.hand.push(card);
    }
  });

  console.log(`[LivingPhase] Hands refilled — deck has ${refillDeck.length} cards remaining`);

  // Find next Living Dead (next player in turnOrder who hasn't been Living Dead)
  const nextLivingDead = getNextLivingDead(state);

  if (nextLivingDead) {
    const nextLDPlayer = state.players.get(nextLivingDead);

    // Late joiner needs a mini die phase before becoming Living Dead
    if (nextLDPlayer?.needsDieCard && state.dieDeck.length > 0) {
      state.pendingPhase = wasLiving ? "living_submit" : "bye_submit";

      // Clear their current hand and deal a die card
      nextLDPlayer.hand.clear();
      const dieCard = state.dieDeck.splice(0, 1)[0];
      nextLDPlayer.hand.push(dieCard);

      state.currentTurn = nextLivingDead;
      state.currentLivingDead = nextLivingDead;
      state.phase = "die_phase";
      console.log(`[LivingPhase] Mini die phase for late joiner ${nextLDPlayer.name}`);
      return;
    }

    // Late joiner but die deck empty — skip mini die phase, clear flag
    if (nextLDPlayer?.needsDieCard) {
      nextLDPlayer.needsDieCard = false;
    }

    // Continue with next Living Dead (same round)
    state.currentLivingDead = nextLivingDead;
    state.currentTurn = nextLivingDead;

    if (wasLiving) {
      state.phase = "living_submit";
    } else {
      state.phase = "bye_submit";
    }

    console.log(`[LivingPhase] Next Living Dead: ${nextLivingDead}`);
  } else {
    // All players have been Living Dead — round complete
    state.round++;
    console.log(`[LivingPhase] Round ${state.round} of ${state.rounds} complete`);

    if (state.round >= state.rounds) {
      // All rounds done — transition to next phase
      if (wasLiving) {
        transitionAfterLiving(state);
      } else {
        transitionAfterBye(state);
      }
    } else {
      // More rounds remain — reset Living Dead tracking and start next round
      state.players.forEach((p) => {
        p.hasBeenLivingDead = false;
      });

      const firstLD = state.turnOrder[0];
      const firstLDPlayer = state.players.get(firstLD);

      // Check if first player in new round needs mini die phase
      if (firstLDPlayer?.needsDieCard && state.dieDeck.length > 0) {
        state.pendingPhase = wasLiving ? "living_submit" : "bye_submit";
        firstLDPlayer.hand.clear();
        const dieCard = state.dieDeck.splice(0, 1)[0];
        firstLDPlayer.hand.push(dieCard);
        state.currentTurn = firstLD;
        state.currentLivingDead = firstLD;
        state.phase = "die_phase";
        console.log(`[LivingPhase] Mini die phase for late joiner ${firstLDPlayer.name} at round start`);
      } else {
        if (firstLDPlayer?.needsDieCard) {
          firstLDPlayer.needsDieCard = false;
        }
        state.currentLivingDead = firstLD;
        state.currentTurn = firstLD;

        if (wasLiving) {
          state.phase = "living_submit";
        } else {
          state.phase = "bye_submit";
        }

        console.log(`[LivingPhase] Starting round ${state.round + 1} — ${state.currentLivingDead} is The Living Dead`);
      }
    }
  }
}

/**
 * After living phase, transition to the first enabled of: bye → eulogy → winner
 */
export function transitionAfterLiving(state: GameState): void {
  if (state.enableBye) {
    transitionToByeSetup(state);
  } else if (state.enableEulogy) {
    transitionToEulogy(state);
  } else {
    state.phase = "winner";
    console.log(`[LivingPhase] Bye+Eulogy disabled — going to winner`);
  }
}

/**
 * After bye phase, transition to eulogy or winner based on settings
 */
function transitionAfterBye(state: GameState): void {
  if (state.enableEulogy) {
    transitionToEulogy(state);
  } else {
    state.phase = "winner";
    console.log(`[ByePhase] Eulogy disabled — going to winner`);
  }
}

// --- Helper functions ---

function allPlayersSubmitted(state: GameState): boolean {
  let allSubmitted = true;
  state.players.forEach((player, sessionId) => {
    if (sessionId === state.currentLivingDead) return; // Skip Living Dead
    if (player.needsDieCard) {
      console.log(`[LivingPhase] allPlayersSubmitted: skipping ${player.name} (needsDieCard)`);
      return;
    }
    if (player.hand.length === 0) {
      console.log(`[LivingPhase] allPlayersSubmitted: skipping ${player.name} (empty hand)`);
      return;
    }
    if (!player.hasSubmitted) allSubmitted = false;
  });
  return allSubmitted;
}

function transitionToReveal(state: GameState): void {
  console.log(`[LivingPhase] All cards submitted — entering reveal phase`);

  if (state.phase === "living_submit") {
    state.phase = "living_reveal";
  } else {
    state.phase = "bye_reveal";
  }
}

export function handleRevealComplete(state: GameState, client: Client): void {
  // Validate phase — idempotent guard (multiple clients may send this)
  const validPhases = ["living_reveal", "bye_reveal"];
  if (!validPhases.includes(state.phase)) return;

  transitionToConvince(state);
}

function transitionToConvince(state: GameState): void {
  const isLiving = state.phase === "living_reveal";
  const isBye = state.phase === "bye_reveal";
  if (!isLiving && !isBye) return; // safety net — only valid from reveal phases

  console.log(`[LivingPhase] Entering convincing phase`);

  // Find first non-Living-Dead player in turnOrder
  const firstConvincer = getFirstNonLivingDead(state);
  if (!firstConvincer) return;

  state.convincingTurn = firstConvincer;
  state.phase = isLiving ? "living_convince" : "bye_convince";
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
    const playerId = state.turnOrder[i];
    if (playerId === state.currentLivingDead) continue;
    // Skip late joiners who haven't submitted (no card to convince with)
    const hasSubmittedCard = state.submittedCards.some(
      (card) => card.submittedBy === playerId
    );
    if (hasSubmittedCard) {
      return playerId;
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

export function transitionToByeSetup(state: GameState): void {
  console.log(`[LivingPhase] Living phase complete — transitioning to Bye phase`);

  // Clear hands and reset Living Dead tracking
  state.players.forEach((player) => {
    player.hand.clear();
    player.hasBeenLivingDead = false;
    player.hasSubmitted = false;
  });

  // Guarantee at least one wildcard is dealt when setting is "atLeastOne"
  const playerIds = Array.from(state.turnOrder);
  if (state.forceWildcards === "atLeastOne") {
    const dealZoneSize = playerIds.length * state.handSize;
    const dealZone = state.byeDeck.slice(0, Math.min(dealZoneSize, state.byeDeck.length));
    const hasWildcardInZone = dealZone.some((card) => card.special === "Wildcard");
    if (!hasWildcardInZone) {
      // Find a wildcard deeper in the deck and swap it into the deal zone
      for (let i = dealZoneSize; i < state.byeDeck.length; i++) {
        if (state.byeDeck[i].special === "Wildcard") {
          const swapIdx = Math.floor(Math.random() * dealZoneSize);
          const temp = state.byeDeck[swapIdx];
          state.byeDeck[swapIdx] = state.byeDeck[i];
          state.byeDeck[i] = temp;
          console.log(`[ByePhase] Wildcard guarantee: swapped wildcard from position ${i} to ${swapIdx}`);
          break;
        }
      }
    }
  }

  // Deal handSize Bye cards per player (using state.handSize)
  for (const playerId of playerIds) {
    const player = state.players.get(playerId);
    if (!player) continue;

    for (let i = 0; i < state.handSize; i++) {
      if (state.byeDeck.length > 0) {
        const card = state.byeDeck.splice(0, 1)[0];
        card.faceUp = true;
        player.hand.push(card);
      }
    }

    // Check if this player received any wildcard cards
    let hasWildcard = false;
    for (let i = 0; i < player.hand.length; i++) {
      if (player.hand[i].special === "Wildcard") {
        hasWildcard = true;
        break;
      }
    }
    player.hasWildcard = hasWildcard;
  }

  // Set first player as Living Dead for Bye phase
  const firstLD = state.turnOrder[0];
  const firstLDPlayer = state.players.get(firstLD);

  state.currentLivingDead = firstLD;
  state.currentTurn = firstLD;
  state.round = 0;

  // Check if first Living Dead is a late joiner needing a mini die phase
  if (firstLDPlayer?.needsDieCard && state.dieDeck.length > 0) {
    state.pendingPhase = "bye_submit";
    firstLDPlayer.hand.clear();
    const dieCard = state.dieDeck.splice(0, 1)[0];
    firstLDPlayer.hand.push(dieCard);
    state.phase = "die_phase";
    console.log(`[ByePhase] Mini die phase for late joiner ${firstLDPlayer.name} before Bye setup`);
  } else {
    if (firstLDPlayer?.needsDieCard) {
      firstLDPlayer.needsDieCard = false;
    }
    state.phase = "bye_submit";
    console.log(`[ByePhase] Setup complete — ${firstLD} is The Living Dead`);
  }
}
