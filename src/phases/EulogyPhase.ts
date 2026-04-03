import { GameState } from "../schema/GameState.js";
import { Client } from "colyseus";

// Eulogist count is now read from state.eulogistCount

/**
 * Transition from bye phase to eulogy. Detects wildcard holders.
 * If none have wildcards, goes straight to "winner".
 */
export function transitionToEulogy(state: GameState): void {
  console.log(`[EulogyPhase] Checking for wildcard holders...`);

  // Detect wildcard holders from the hasWildcard flag set during bye setup
  const wildcardIds: string[] = [];
  for (const sessionId of Array.from(state.turnOrder)) {
    const player = state.players.get(sessionId);
    if (player?.hasWildcard) {
      wildcardIds.push(sessionId);
      console.log(`[EulogyPhase] ${player.name} has a wildcard`);
    }
  }

  // Clear eulogy state
  state.wildcardPlayerIds.splice(0, state.wildcardPlayerIds.length);
  state.selectedEulogists.splice(0, state.selectedEulogists.length);
  state.currentWildcardIndex = 0;
  state.currentEulogistIndex = 0;
  state.bestEulogist = "";
  state.currentWildcardPlayer = "";

  if (wildcardIds.length === 0) {
    console.log(`[EulogyPhase] No wildcards — going to winner`);
    state.phase = "winner";
    return;
  }

  wildcardIds.forEach((id) => state.wildcardPlayerIds.push(id));
  state.currentWildcardPlayer = wildcardIds[0];
  state.phase = "eulogy_intro";

  console.log(`[EulogyPhase] ${wildcardIds.length} wildcard holder(s) — entering eulogy intro`);
}

/**
 * Start the eulogy round for the current wildcard holder.
 * Transitions from eulogy_intro to eulogy_pick.
 */
export function handleStartEulogyRound(state: GameState, client: Client): void {
  if (state.phase !== "eulogy_intro") return;

  // Only host or wildcard holder can start
  const isWildcardPlayer = state.currentWildcardPlayer === client.sessionId;
  const isHost = state.hostId === client.sessionId;
  if (!isWildcardPlayer && !isHost) return;

  state.selectedEulogists.splice(0, state.selectedEulogists.length);
  state.currentEulogistIndex = 0;
  state.bestEulogist = "";

  // If only eulogistCount players exist (excluding wildcard holder), auto-select all
  const otherPlayers: string[] = [];
  state.turnOrder.forEach((id) => {
    if (id !== state.currentWildcardPlayer) otherPlayers.push(id);
  });

  const requiredCount = Math.min(state.eulogistCount, otherPlayers.length);
  if (otherPlayers.length === requiredCount) {
    otherPlayers.forEach((id) => state.selectedEulogists.push(id));
    state.phase = "eulogy_speech";
    console.log(`[EulogyPhase] Auto-selected all ${requiredCount} eulogists — entering speeches`);
    return;
  }

  state.phase = "eulogy_pick";
  const player = state.players.get(state.currentWildcardPlayer);
  console.log(`[EulogyPhase] ${player?.name} picking ${requiredCount} eulogists`);
}

/**
 * Toggle eulogist selection. Only the current wildcard holder can select.
 */
export function handleSelectEulogist(state: GameState, client: Client, targetSessionId: string): void {
  if (state.phase !== "eulogy_pick") return;
  if (state.currentWildcardPlayer !== client.sessionId) return;

  // Can't select self
  if (targetSessionId === state.currentWildcardPlayer) return;

  // Validate target is a real player
  if (!state.players.get(targetSessionId)) return;

  // Toggle
  const idx = state.selectedEulogists.indexOf(targetSessionId);
  if (idx >= 0) {
    state.selectedEulogists.splice(idx, 1);
  } else {
    const otherCount = state.turnOrder.length - 1;
    const requiredCount = Math.min(state.eulogistCount, otherCount);
    if (state.selectedEulogists.length < requiredCount) {
      state.selectedEulogists.push(targetSessionId);
    } else {
      // Replace oldest
      state.selectedEulogists.splice(0, 1);
      state.selectedEulogists.push(targetSessionId);
    }
  }
}

/**
 * Confirm eulogist selection and start speeches.
 */
export function handleConfirmEulogists(state: GameState, client: Client): void {
  if (state.phase !== "eulogy_pick") return;
  if (state.currentWildcardPlayer !== client.sessionId) return;

  const otherCount = state.turnOrder.length - 1;
  const requiredCount = Math.min(state.eulogistCount, otherCount);
  if (state.selectedEulogists.length !== requiredCount) return;

  state.currentEulogistIndex = 0;
  state.phase = "eulogy_speech";

  const eulogist = state.players.get(state.selectedEulogists[0]);
  console.log(`[EulogyPhase] Eulogists confirmed — ${eulogist?.name} speaks first`);
}

/**
 * Current eulogist finishes their speech. Advance to next or judging.
 */
export function handleDoneEulogy(state: GameState, client: Client): void {
  if (state.phase !== "eulogy_speech") return;

  // Must be current eulogist
  const currentEulogistId = state.selectedEulogists[state.currentEulogistIndex];
  if (client.sessionId !== currentEulogistId) return;

  const nextIndex = state.currentEulogistIndex + 1;
  if (nextIndex >= state.selectedEulogists.length) {
    // All eulogies done — time to judge
    state.currentEulogistIndex = 0;
    state.phase = "eulogy_judge";
    console.log(`[EulogyPhase] All eulogies done — wildcard holder judges`);
  } else {
    state.currentEulogistIndex = nextIndex;
    const next = state.players.get(state.selectedEulogists[nextIndex]);
    console.log(`[EulogyPhase] Next eulogist: ${next?.name}`);
  }
}

/**
 * Wildcard holder picks the best eulogy. Awards points.
 */
export function handlePickBestEulogy(state: GameState, client: Client, winnerSessionId: string): void {
  if (state.phase !== "eulogy_judge") return;
  if (state.currentWildcardPlayer !== client.sessionId) return;

  // Validate winner is one of the selected eulogists
  if (state.selectedEulogists.indexOf(winnerSessionId) < 0) return;

  state.bestEulogist = winnerSessionId;

  // Award points: best eulogist +2, runner-up +1, wildcard holder +1
  const bestPlayer = state.players.get(winnerSessionId);
  if (bestPlayer) {
    bestPlayer.score += 2;
    console.log(`[EulogyPhase] ${bestPlayer.name} wins best eulogy (+2). Score: ${bestPlayer.score}`);
  }

  // Runner-up: first eulogist that isn't the winner
  for (let i = 0; i < state.selectedEulogists.length; i++) {
    const eid = state.selectedEulogists[i];
    if (eid !== winnerSessionId) {
      const runnerUp = state.players.get(eid);
      if (runnerUp) {
        runnerUp.score += 1;
        console.log(`[EulogyPhase] ${runnerUp.name} runner-up (+1). Score: ${runnerUp.score}`);
      }
      break;
    }
  }

  // Wildcard holder gets +1
  const wildcardPlayer = state.players.get(state.currentWildcardPlayer);
  if (wildcardPlayer) {
    wildcardPlayer.score += 1;
    console.log(`[EulogyPhase] ${wildcardPlayer.name} wildcard bonus (+1). Score: ${wildcardPlayer.score}`);
  }

  state.phase = "eulogy_points";
}

/**
 * Advance to next wildcard holder or show winner.
 */
export function handleNextWildcard(state: GameState): void {
  if (state.phase !== "eulogy_points") return;

  const nextIndex = state.currentWildcardIndex + 1;
  if (nextIndex >= state.wildcardPlayerIds.length) {
    // All wildcards done — show winner
    state.phase = "winner";
    console.log(`[EulogyPhase] All eulogy rounds complete — showing winner`);
  } else {
    // Next wildcard holder
    state.currentWildcardIndex = nextIndex;
    state.currentWildcardPlayer = state.wildcardPlayerIds[nextIndex];
    state.selectedEulogists.splice(0, state.selectedEulogists.length);
    state.currentEulogistIndex = 0;
    state.bestEulogist = "";
    state.phase = "eulogy_intro";

    const nextPlayer = state.players.get(state.currentWildcardPlayer);
    console.log(`[EulogyPhase] Next wildcard holder: ${nextPlayer?.name}`);
  }
}

/**
 * Skip eulogy and go straight to winner screen.
 * Used when no wildcards or user wants to skip.
 */
export function handleRevealWinner(state: GameState, client: Client): void {
  if (state.phase !== "eulogy_intro") return;

  // Only host can skip
  const isHost = state.hostId === client.sessionId;
  if (!isHost) return;

  state.phase = "winner";
  console.log(`[EulogyPhase] Host skipped to winner`);
}
