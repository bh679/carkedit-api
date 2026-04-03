import { Room, Client } from "colyseus";
import { GameState } from "../schema/GameState.js";
import { Player } from "../schema/Player.js";
import { shuffle, createDeck } from "../utils/deck.js";
import { computeDodTurnOrder } from "../utils/turnOrder.js";
import { DIE_CARDS, LIVING_CARDS, BYE_CARDS } from "../data/cards.js";
import { handleRevealDie, handleEndDieTurn } from "../phases/DiePhase.js";
import { handleSubmitCard, handleRevealSubmission, handleEndConvinceTurn, handleSelectWinner, handleNextRound } from "../phases/LivingPhase.js";
import { handleStartEulogyRound, handleSelectEulogist, handleConfirmEulogists, handleDoneEulogy, handlePickBestEulogy, handleNextWildcard, handleRevealWinner } from "../phases/EulogyPhase.js";
import { ROOM_CODE_WORDS } from "./roomWords.js";
import { saveGameResult } from "../db/database.js";
import type { GameResult } from "../db/types.js";

const MIN_PLAYERS = 2;

function generateRoomCode(): string {
  return ROOM_CODE_WORDS[Math.floor(Math.random() * ROOM_CODE_WORDS.length)];
}

export class GameRoom extends Room<{ state: GameState }> {
  maxClients = 10;
  private _gameResultSaved = false;
  private _gameStartedAt: string | null = null;

  async onCreate(options: any) {
    this.setState(new GameState());

    // Poll for game completion to persist results
    this.clock.setInterval(() => {
      if (this.state.phase === "winner" && !this._gameResultSaved) {
        this._gameResultSaved = true;
        this.persistGameResults();
      }
    }, 1000);

    if (options.private) {
      const roomCode = generateRoomCode();
      this.state.isPrivate = true;
      this.state.roomCode = roomCode;
      await this.setPrivate(true);
      await this.setMetadata({ roomCode });
    }

    this.onMessage("ready", (client) => {
      this.handleReady(client);
    });

    this.onMessage("set_name", (client, data: { name: string }) => {
      const player = this.state.players.get(client.sessionId);
      if (player) {
        player.name = data.name;
      }
    });

    this.onMessage("reveal_die", (client) => {
      handleRevealDie(this.state, client);
    });

    this.onMessage("end_die_turn", (client) => {
      handleEndDieTurn(this.state, client);
    });

    this.onMessage("submit_card", (client, data: { cardIndex: number }) => {
      handleSubmitCard(this.state, client, data.cardIndex);
    });

    this.onMessage("reveal_submission", (client) => {
      handleRevealSubmission(this.state, client);
    });

    this.onMessage("end_convince_turn", (client) => {
      handleEndConvinceTurn(this.state, client);
    });

    this.onMessage("select_winner", (client, data: { cardIndex: number }) => {
      handleSelectWinner(this.state, client, data.cardIndex);
      // Auto-advance after winner phase (shorter for 1-round games)
      if (this.state.phase === "living_winner" || this.state.phase === "bye_winner") {
        const winnerDelay = this.state.rounds === 1 ? 2500 : 5000;
        this.clock.setTimeout(() => {
          handleNextRound(this.state);
        }, winnerDelay);
      }
    });

    this.onMessage("setting", (client, data: { key: string; value: any }) => {
      // Only the host (room creator) can change settings during lobby
      if (this.state.hostId && this.state.hostId !== client.sessionId) return;
      if (this.state.phase !== "lobby") return;
      this.applySetting(data.key, data.value);
    });

    this.onMessage("game_settings", (client, data: Record<string, any>) => {
      // Bulk update — used for game mode presets
      if (this.state.hostId && this.state.hostId !== client.sessionId) return;
      if (this.state.phase !== "lobby") return;
      for (const [key, value] of Object.entries(data)) {
        this.applySetting(key, value);
      }
    });

    // Eulogy (Phase 4) message handlers
    this.onMessage("start_eulogy_round", (client) => {
      handleStartEulogyRound(this.state, client);
    });

    this.onMessage("select_eulogist", (client, data: { sessionId: string }) => {
      handleSelectEulogist(this.state, client, data.sessionId);
    });

    this.onMessage("confirm_eulogists", (client) => {
      handleConfirmEulogists(this.state, client);
    });

    this.onMessage("done_eulogy", (client) => {
      handleDoneEulogy(this.state, client);
    });

    this.onMessage("pick_best_eulogy", (client, data: { sessionId: string }) => {
      handlePickBestEulogy(this.state, client, data.sessionId);
      // Auto-advance after points phase (shorter for 1-round games)
      if (this.state.phase === "eulogy_points") {
        const winnerDelay = this.state.rounds === 1 ? 2500 : 5000;
        this.clock.setTimeout(() => {
          handleNextWildcard(this.state);
        }, winnerDelay);
      }
    });

    this.onMessage("reveal_winner", (client) => {
      handleRevealWinner(this.state, client);
    });

    this.onMessage("start_game", (client) => {
      if (this.state.phase !== "lobby") return;
      if (this.state.players.size < MIN_PLAYERS) return;
      // Only the host (room creator) can start the game
      if (this.state.hostId && this.state.hostId !== client.sessionId) return;
      this.startGame();
    });

    console.log(`[GameRoom] Room created`);
  }

  onJoin(client: Client, options: any) {
    const player = new Player();
    player.sessionId = client.sessionId;
    player.name = options.name || `Player ${this.state.players.size + 1}`;
    player.connected = true;

    const month = parseInt(options.birthMonth, 10);
    const day = parseInt(options.birthDay, 10);
    player.birthMonth = (month >= 1 && month <= 12) ? month : 0;
    player.birthDay = (day >= 1 && day <= 31) ? day : 0;
    this.state.players.set(client.sessionId, player);

    // First player to join becomes the host
    if (!this.state.hostId) {
      this.state.hostId = client.sessionId;
    }

    // Recalculate DoD turn order on every join so late joiners are incorporated
    const newOrder = computeDodTurnOrder(this.state.players);
    this.state.turnOrder.splice(0, this.state.turnOrder.length);
    newOrder.forEach((id) => this.state.turnOrder.push(id));

    console.log(`[GameRoom] ${player.name} joined (${client.sessionId})`);
  }

  async onLeave(client: Client, _code?: number) {
    const player = this.state.players.get(client.sessionId);
    if (!player) return;

    console.log(`[GameRoom] ${player.name} left`);
    player.connected = false;

    if (this.state.phase === "lobby") {
      this.state.players.delete(client.sessionId);
      return;
    }

    // Allow reconnection for 2 minutes during active game phases
    try {
      await this.allowReconnection(client, 120);
      player.connected = true;
      console.log(`[GameRoom] ${player.name} reconnected`);
    } catch {
      console.log(`[GameRoom] ${player.name} reconnection timed out`);
      // Player stays in game state as disconnected — don't remove during active game
    }
  }

  onDispose() {
    console.log(`[GameRoom] Room disposed`);
  }

  private applySetting(key: string, value: any) {
    // Boolean settings
    const boolKeys = [
      "autoStartOnReady", "enableDie", "enableLive", "enableBye", "enableEulogy",
      "forceWildcards", "playableWildcards", "optionalCardPlay", "ultraQuickMode",
      "timerEnabled", "pitchTimerEnabled", "playCardTimerEnabled",
      "timerCountUp", "timerVisible", "timerAutoAdvance",
    ];
    if (boolKeys.includes(key) && typeof value === "boolean") {
      (this.state as any)[key] = value;
      return;
    }

    // Numeric settings with ranges
    const numRanges: Record<string, [number, number]> = {
      rounds: [1, 10],
      handSize: [1, 68],
      wildcardCount: [0, 10],
      eulogistCount: [1, 10],
      pitchDuration: [30, 3600],
    };
    if (key in numRanges && typeof value === "number") {
      const [min, max] = numRanges[key];
      (this.state as any)[key] = Math.max(min, Math.min(max, Math.floor(value)));
      return;
    }

    // String settings with allowed values
    if (key === "handRedraws") {
      const allowed = ["off", "once_per_phase", "once_per_round", "unlimited"];
      if (typeof value === "string" && allowed.includes(value)) {
        this.state.handRedraws = value;
      }
    }
  }

  private handleReady(client: Client) {
    if (this.state.phase !== "lobby") return;

    const player = this.state.players.get(client.sessionId);
    if (!player) return;

    player.ready = !player.ready;

    const allReady = this.checkAllReady();
    if (allReady && this.state.autoStartOnReady && this.state.players.size >= MIN_PLAYERS) {
      this.startGame();
    }
  }

  private checkAllReady(): boolean {
    let allReady = true;
    this.state.players.forEach((player) => {
      if (!player.ready) allReady = false;
    });
    return allReady;
  }

  private persistGameResults() {
    try {
      const players: { name: string; score: number }[] = [];
      this.state.players.forEach((player) => {
        players.push({ name: player.name, score: player.score });
      });

      const sorted = [...players].sort((a, b) => b.score - a.score);
      const now = new Date().toISOString();
      let durationSeconds: number | undefined;
      if (this._gameStartedAt) {
        durationSeconds = Math.round(
          (Date.now() - new Date(this._gameStartedAt).getTime()) / 1000
        );
      }

      const settings: Record<string, any> = {};
      const settingKeys = [
        "rounds", "handSize", "enableDie", "enableLive", "enableBye", "enableEulogy",
        "forceWildcards", "playableWildcards", "wildcardCount", "eulogistCount",
        "optionalCardPlay", "ultraQuickMode", "timerEnabled", "pitchDuration",
      ];
      for (const key of settingKeys) {
        settings[key] = (this.state as any)[key];
      }

      const result: GameResult = {
        id: crypto.randomUUID(),
        finished_at: now,
        mode: "online",
        room_code: this.state.roomCode || undefined,
        rounds: this.state.rounds,
        player_count: sorted.length,
        winner_name: sorted[0]?.name || "Unknown",
        winner_score: sorted[0]?.score || 0,
        duration_seconds: durationSeconds,
        settings_json: JSON.stringify(settings),
        players: sorted.map((p, i) => ({
          player_name: p.name,
          score: p.score,
          rank: i + 1,
        })),
      };

      const id = saveGameResult(result);
      console.log(`[GameRoom] Game result saved: ${id}`);
    } catch (err) {
      console.error("[GameRoom] Failed to save game result:", err);
    }
  }

  private startGame() {
    console.log(`[GameRoom] Game starting — creating decks`);
    this._gameStartedAt = new Date().toISOString();

    const shuffledDieDeck = shuffle(createDeck(DIE_CARDS, "die"));
    const shuffledLivingDeck = shuffle(createDeck(LIVING_CARDS, "living"));
    const shuffledByeDeck = shuffle(createDeck(BYE_CARDS, "bye"));

    shuffledDieDeck.forEach((card) => this.state.dieDeck.push(card));
    shuffledLivingDeck.forEach((card) => this.state.livingDeck.push(card));
    shuffledByeDeck.forEach((card) => this.state.byeDeck.push(card));

    // Recompute DoD turn order at game start (handles any last-second joins)
    const finalOrder = computeDodTurnOrder(this.state.players);
    this.state.turnOrder.splice(0, this.state.turnOrder.length);
    finalOrder.forEach((id) => this.state.turnOrder.push(id));

    // Deal 1 Die card per player from the dieDeck
    for (const playerId of finalOrder) {
      const player = this.state.players.get(playerId);
      if (!player) continue;

      if (this.state.dieDeck.length > 0) {
        const card = this.state.dieDeck.splice(0, 1)[0];
        player.hand.push(card);
      }
    }

    this.state.currentTurn = finalOrder[0];
    this.state.round = 1;
    this.state.phase = "die_phase";

    console.log(`[GameRoom] Phase: die_phase — ${this.state.currentTurn}'s turn`);
  }
}
