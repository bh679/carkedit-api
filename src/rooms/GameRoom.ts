import { randomUUID } from "node:crypto";
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
import { saveGameResult, saveCardPlays, saveGameEvent, backfillGameId, createLiveGame, updateLiveGame, completeLiveGame, abandonGame } from "../db/database.js";
import type { GameResult, CardPlay, GameEvent } from "../db/types.js";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirnameGR = path.dirname(fileURLToPath(import.meta.url));
const apiPkg = JSON.parse(fs.readFileSync(path.join(__dirnameGR, "../../package.json"), "utf-8"));

const MIN_PLAYERS = 2;

function generateRoomCode(): string {
  return ROOM_CODE_WORDS[Math.floor(Math.random() * ROOM_CODE_WORDS.length)];
}

export class GameRoom extends Room<{ state: GameState }> {
  maxClients = 10;
  private _gameResultSaved = false;
  private _gameStartedAt: string | null = null;
  private _cardPlays: CardPlay[] = [];
  private _previousPhase: string = "lobby";
  private _gameId: string | null = null;

  async onCreate(options: any) {
    this.setState(new GameState());

    // Generate game ID early so all events are linked from the start
    this._gameId = randomUUID();
    this._gameStartedAt = new Date().toISOString();

    // Poll for game completion and phase changes
    this.clock.setInterval(() => {
      if (this.state.phase === "winner" && !this._gameResultSaved) {
        this._gameResultSaved = true;
        this.persistGameResults();
      }
      // Track phase changes and update live game record
      if (this.state.phase !== this._previousPhase) {
        this.logEvent(undefined, "phase_changed", {
          from: this._previousPhase,
          to: this.state.phase,
        });
        this._previousPhase = this.state.phase;
        if (this._gameId) {
          try { updateLiveGame(this._gameId, { status: this.state.phase }); } catch {}
        }
      }
    }, 1000);

    // Set dev mode if requested (must be set at room creation time)
    if (options.devMode) {
      this.state.devMode = true;
    }

    if (options.private) {
      const roomCode = generateRoomCode();
      this.state.isPrivate = true;
      this.state.roomCode = roomCode;
      await this.setPrivate(true);
      await this.setMetadata({ roomCode, devMode: !!options.devMode });
    }

    // Create live game record in DB
    try {
      createLiveGame({
        id: this._gameId,
        started_at: this._gameStartedAt,
        mode: 'online',
        room_code: this.state.roomCode || undefined,
        host_name: undefined, // Host joins after creation
        player_count: 0,
        is_dev: this.state.devMode,
        api_version: apiPkg.version,
      });
      console.log(`[GameRoom] Live game created in DB: ${this._gameId}`);
    } catch (err) {
      console.error(`[GameRoom] Failed to create live game:`, err);
    }

    this.logEvent(undefined, "room_created", {
      isPrivate: this.state.isPrivate,
      roomCode: this.state.roomCode || null,
      devMode: this.state.devMode,
    });

    this.onMessage("ready", (client) => {
      this.handleReady(client);
    });

    this.onMessage("set_name", (client, data: { name: string }) => {
      const player = this.state.players.get(client.sessionId);
      if (player) {
        const oldName = player.name;
        player.name = data.name;
        this.logEvent(client, "name_changed", { oldName, newName: data.name });
      }
    });

    this.onMessage("reveal_die", (client) => {
      const player = this.state.players.get(client.sessionId);
      const card = player?.hand?.[0];
      this.logEvent(client, "die_revealed", {
        cardId: card?.id,
        cardText: card?.text,
      });
      // Save die card to card_plays for dashboard visibility
      if (card && this._gameId) {
        saveCardPlays([{
          game_id: this._gameId,
          round: this.state.round,
          phase: "die",
          card_id: String(card.id),
          card_text: card.text,
          card_deck: "die",
          player_name: player?.name || "Unknown",
          is_winner: false,
        }]);
      }
      handleRevealDie(this.state, client);
    });

    this.onMessage("end_die_turn", (client) => {
      this.logEvent(client, "die_turn_ended");
      handleEndDieTurn(this.state, client);
    });

    this.onMessage("submit_card", (client, data: { cardIndex: number }) => {
      this.logEvent(client, "card_submitted", { cardIndex: data.cardIndex });
      handleSubmitCard(this.state, client, data.cardIndex);
    });

    this.onMessage("reveal_submission", (client) => {
      this.logEvent(client, "submission_revealed");
      handleRevealSubmission(this.state, client);
    });

    this.onMessage("end_convince_turn", (client) => {
      this.logEvent(client, "convince_turn_ended");
      handleEndConvinceTurn(this.state, client);
    });

    this.onMessage("select_winner", (client, data: { cardIndex: number }) => {
      const winnerCard = this.state.submittedCards[data.cardIndex];
      const winnerPlayer = winnerCard?.submittedBy ? this.state.players.get(winnerCard.submittedBy) : null;
      this.logEvent(client, "winner_selected", {
        cardIndex: data.cardIndex,
        winnerName: winnerPlayer?.name,
        winnerSessionId: winnerCard?.submittedBy,
      });
      // Capture card plays before handleSelectWinner processes them
      this.captureCardPlays(data.cardIndex);
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
      this.logEvent(client, "setting_changed", { key: data.key, value: data.value });
      this.applySetting(data.key, data.value);
    });

    this.onMessage("game_settings", (client, data: Record<string, any>) => {
      // Bulk update — used for game mode presets
      if (this.state.hostId && this.state.hostId !== client.sessionId) return;
      if (this.state.phase !== "lobby") return;
      this.logEvent(client, "settings_bulk_changed", { settings: data });
      for (const [key, value] of Object.entries(data)) {
        this.applySetting(key, value);
      }
    });

    // Eulogy (Phase 4) message handlers
    this.onMessage("start_eulogy_round", (client) => {
      this.logEvent(client, "eulogy_round_started");
      handleStartEulogyRound(this.state, client);
    });

    this.onMessage("select_eulogist", (client, data: { sessionId: string }) => {
      const eulogist = this.state.players.get(data.sessionId);
      this.logEvent(client, "eulogist_selected", {
        sessionId: data.sessionId,
        eulogistName: eulogist?.name,
      });
      handleSelectEulogist(this.state, client, data.sessionId);
    });

    this.onMessage("confirm_eulogists", (client) => {
      const eulogists = Array.from(this.state.selectedEulogists).map(sid => {
        const p = this.state.players.get(sid);
        return { sessionId: sid, name: p?.name };
      });
      this.logEvent(client, "eulogists_confirmed", { eulogists });
      handleConfirmEulogists(this.state, client);
    });

    this.onMessage("done_eulogy", (client) => {
      this.logEvent(client, "eulogy_done");
      handleDoneEulogy(this.state, client);
    });

    this.onMessage("pick_best_eulogy", (client, data: { sessionId: string }) => {
      const bestPlayer = this.state.players.get(data.sessionId);
      this.logEvent(client, "best_eulogy_picked", {
        sessionId: data.sessionId,
        bestEulogistName: bestPlayer?.name,
      });
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
      this.logEvent(client, "winner_revealed");
      handleRevealWinner(this.state, client);
    });

    this.onMessage("start_game", (client) => {
      if (this.state.phase !== "lobby") return;
      if (this.state.players.size < MIN_PLAYERS) return;
      // Only the host (room creator) can start the game
      if (this.state.hostId && this.state.hostId !== client.sessionId) return;
      this.logEvent(client, "game_start_requested");
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
    player.isDevName = !!options.isDevName;
    this.state.players.set(client.sessionId, player);

    const isHost = !this.state.hostId;
    // First player to join becomes the host
    if (!this.state.hostId) {
      this.state.hostId = client.sessionId;
    }

    // Recalculate DoD turn order on every join so late joiners are incorporated
    const newOrder = computeDodTurnOrder(this.state.players);
    this.state.turnOrder.splice(0, this.state.turnOrder.length);
    newOrder.forEach((id) => this.state.turnOrder.push(id));

    this.logEvent(client, "player_joined", {
      name: player.name,
      birthMonth: player.birthMonth,
      birthDay: player.birthDay,
      isHost,
      playerCount: this.state.players.size,
    });

    // Update live game record with player count and host name
    if (this._gameId) {
      try {
        updateLiveGame(this._gameId, {
          playerCount: this.state.players.size,
          ...(isHost ? { hostName: player.name } : {}),
        });
      } catch {}
    }

    console.log(`[GameRoom] ${player.name} joined (${client.sessionId})`);
  }

  async onLeave(client: Client, _code?: number) {
    const player = this.state.players.get(client.sessionId);
    if (!player) return;

    console.log(`[GameRoom] ${player.name} left`);
    player.connected = false;

    this.logEvent(client, "player_left", {
      name: player.name,
      phase: this.state.phase,
    });

    if (this.state.phase === "lobby") {
      this.state.players.delete(client.sessionId);
      return;
    }

    // Allow reconnection for 2 minutes during active game phases
    try {
      await this.allowReconnection(client, 120);
      player.connected = true;
      this.logEvent(client, "player_reconnected", { name: player.name });
      console.log(`[GameRoom] ${player.name} reconnected`);
    } catch {
      this.logEvent(client, "player_reconnect_timeout", { name: player.name });
      console.log(`[GameRoom] ${player.name} reconnection timed out`);
      // Player stays in game state as disconnected — don't remove during active game
    }
  }

  onDispose() {
    this.logEvent(undefined, "room_disposed");

    // Mark game as abandoned if it wasn't completed
    if (this._gameId && !this._gameResultSaved) {
      try {
        abandonGame(this._gameId);
        console.log(`[GameRoom] Game marked as abandoned: ${this._gameId}`);
      } catch (err) {
        console.error(`[GameRoom] Failed to mark game as abandoned:`, err);
      }
    }

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
    this.logEvent(client, "player_ready", { ready: player.ready });

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
      const players: { name: string; score: number; isDevName: boolean }[] = [];
      this.state.players.forEach((player) => {
        players.push({ name: player.name, score: player.score, isDevName: player.isDevName });
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

      // Get host name
      const hostPlayer = this.state.hostId ? this.state.players.get(this.state.hostId) : null;

      const id = this._gameId!;

      completeLiveGame(id, {
        finished_at: now,
        rounds: this.state.rounds,
        player_count: sorted.length,
        winner_name: sorted[0]?.name || "Unknown",
        winner_score: sorted[0]?.score || 0,
        duration_seconds: durationSeconds,
        has_error: false,
        is_dev: this.state.devMode,
        settings_json: JSON.stringify(settings),
        players: sorted.map((p, i) => ({
          player_name: p.name,
          score: p.score,
          rank: i + 1,
        })),
      });

      console.log(`[GameRoom] Game result completed: ${id}`);

      // Backfill game_id on all events collected during this room's lifetime
      backfillGameId(this.roomId, id);

      // Card plays are now saved in real-time by captureCardPlays()
      // No bulk save needed here — plays already have correct game_id

      this.logEvent(undefined, "game_finished", {
        winnerName: sorted[0]?.name,
        winnerScore: sorted[0]?.score,
        durationSeconds,
        playerCount: sorted.length,
      });
    } catch (err) {
      console.error("[GameRoom] Failed to save game result:", err);
    }
  }

  private captureCardPlays(winnerCardIndex: number) {
    try {
      const phase = this.state.phase.startsWith("bye") ? "bye" : "living";
      const round = this.state.round;
      const plays: CardPlay[] = [];

      for (let i = 0; i < this.state.submittedCards.length; i++) {
        const card = this.state.submittedCards[i];
        const player = card.submittedBy ? this.state.players.get(card.submittedBy) : null;
        const play: CardPlay = {
          game_id: this._gameId!,
          round,
          phase,
          card_id: String(card.id),
          card_text: card.text,
          card_deck: card.deck,
          player_name: player?.name || "Unknown",
          is_winner: i === winnerCardIndex,
        };
        this._cardPlays.push(play);
        plays.push(play);
      }

      // Save card plays to DB immediately so dashboard can show them for live games
      if (plays.length > 0) {
        saveCardPlays(plays);
      }
    } catch (err) {
      console.error("[GameRoom] Failed to capture card plays:", err);
    }
  }

  private startGame() {
    console.log(`[GameRoom] Game starting — creating decks`);
    this._gameStartedAt = new Date().toISOString();
    this._previousPhase = "lobby"; // ensure phase_changed fires for die_phase

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

    const playerNames: string[] = [];
    this.state.players.forEach(p => playerNames.push(p.name));
    this.logEvent(undefined, "game_started", {
      playerCount: this.state.players.size,
      turnOrder: finalOrder,
      playerNames,
      settings: {
        rounds: this.state.rounds,
        handSize: this.state.handSize,
        enableDie: this.state.enableDie,
        enableLive: this.state.enableLive,
        enableBye: this.state.enableBye,
        enableEulogy: this.state.enableEulogy,
      },
    });

    console.log(`[GameRoom] Phase: die_phase — ${this.state.currentTurn}'s turn`);
  }

  private logEvent(client: Client | undefined, eventType: string, data?: Record<string, any>) {
    try {
      const player = client ? this.state.players.get(client.sessionId) : null;
      const event: GameEvent = {
        room_id: this.roomId,
        game_id: this._gameId || undefined,
        event_type: eventType,
        actor_session_id: client?.sessionId,
        actor_name: player?.name,
        phase: this.state.phase,
        round: this.state.round || undefined,
        data_json: data ? JSON.stringify(data) : undefined,
        created_at: new Date().toISOString(),
      };
      saveGameEvent(event);
    } catch (err) {
      console.error(`[GameRoom] Failed to log event ${eventType}:`, err);
    }
  }
}
