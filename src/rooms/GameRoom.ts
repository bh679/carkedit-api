import { randomUUID } from "node:crypto";
import { Room, Client } from "colyseus";
import { GameState } from "../schema/GameState.js";
import { Player } from "../schema/Player.js";
import { shuffle, createDeck, expansionCardsToCardData, mergeDecks } from "../utils/deck.js";
import { getCardsByPackIds, recordPackUsage } from "../db/packs.js";
import { computeDodTurnOrder } from "../utils/turnOrder.js";
import { DIE_CARDS, LIVING_CARDS, BYE_CARDS } from "../data/cards.js";
import { handleRevealDie, handleEndDieTurn } from "../phases/DiePhase.js";
import { handleSubmitCard, handleSwapCard, handleRevealComplete, handleRevealSubmission, handleEndConvinceTurn, handleSelectWinner, handleNextRound } from "../phases/LivingPhase.js";
import { handleStartEulogyRound, handleSelectEulogist, handleConfirmEulogists, handleDoneEulogy, handlePickBestEulogy, handleNextWildcard, handleRevealWinner } from "../phases/EulogyPhase.js";
import { ROOM_CODE_WORDS } from "./roomWords.js";
import { verifyHostAuthorization } from "./hostAuth.js";
import { VideoCallEntry } from "../schema/VideoCall.js";
import { sanitizeVideoCall } from "../utils/videoCall.js";
import { saveGameResult, saveCardPlays, saveCardDraws, saveGameEvent, backfillGameId, createLiveGame, updateLiveGame, completeLiveGame, abandonGame, syncLivePlayers } from "../db/database.js";
import { getScheduledById, isCodeReserved, setScheduledRoom, markScheduledStarted, markScheduledEnded } from "../db/scheduledGames.js";
import type { GameResult, CardPlay, CardDraw, GameEvent } from "../db/types.js";
import { postWebhookEmbed, buildGameStartEmbed, buildGameFinishEmbed } from "../services/discord/webhook.js";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirnameGR = path.dirname(fileURLToPath(import.meta.url));
const apiPkg = JSON.parse(fs.readFileSync(path.join(__dirnameGR, "../../package.json"), "utf-8"));

const MIN_PLAYERS = 2;

const CODE_DRAW_ATTEMPTS = 25;

/**
 * Draw a code for a walk-up room. Codes held by an active scheduled reservation
 * are skipped so a spontaneous game can never steal a shared scheduled link;
 * beyond that the historical behaviour (random word, collisions tolerated) is
 * unchanged. Falls through to a plain draw if the pool lookup fails so room
 * creation never depends on the DB.
 */
function generateRoomCode(): string {
  for (let i = 0; i < CODE_DRAW_ATTEMPTS; i++) {
    const code = ROOM_CODE_WORDS[Math.floor(Math.random() * ROOM_CODE_WORDS.length)];
    try {
      if (isCodeReserved(code)) continue;
    } catch {
      return code;
    }
    return code;
  }
  return ROOM_CODE_WORDS[Math.floor(Math.random() * ROOM_CODE_WORDS.length)];
}

export class GameRoom extends Room<{ state: GameState }> {
  maxClients = 10;
  private _gameResultSaved = false;
  private _gameStartedAt: string | null = null;
  private _cardPlays: CardPlay[] = [];
  private _previousPhase: string = "lobby";
  private _gameId: string | null = null;
  private _hostUserId: string | null = null;
  private _scheduledId: string | null = null;

  async onCreate(options: any) {
    // A scheduled lobby's room is spun up server-side (see routes/scheduled-games.ts)
    // when anyone opens the join link — including guests, who could never call
    // client.create() themselves. The reservation row is the host's standing
    // authorization, so host verification is satisfied by loading it. options
    // .scheduledId is therefore only ever passed by our own matchMaker call.
    const scheduled = options.scheduledId ? getScheduledById(options.scheduledId) : null;
    if (options.scheduledId && !scheduled) {
      throw new Error("That scheduled game no longer exists");
    }

    let hostUser = null;
    if (scheduled) {
      this._scheduledId = scheduled.id;
      this._hostUserId = scheduled.host_user_id;
    } else {
      // Hosting requires a signed-up account (joining does not). Runs before
      // any state/DB setup so a rejected create persists nothing; throwing
      // here rejects the client's create() call with the error message.
      hostUser = await verifyHostAuthorization(options.authToken);
      this._hostUserId = hostUser?.id ?? null;
    }

    this.setState(new GameState());
    // Default to the base CarkedIt deck enabled (sentinel pack id "base")
    this.state.selectedPackIds.push("base");

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
        // Capture card draws when hands are dealt (phase just transitioned to submit)
        if (this._gameId && (this.state.phase === "die_phase" || this.state.phase === "living_submit" || this.state.phase === "bye_submit")) {
          this.captureCardDraws();
        }
        if (this._gameId) {
          try { updateLiveGame(this._gameId, { status: this.state.phase }); } catch {}
        }
        // Leaving the lobby means the scheduled game genuinely ran — this is
        // what makes its link die on dispose instead of staying joinable.
        if (this._scheduledId && this.state.phase !== "lobby") {
          try { markScheduledStarted(this._scheduledId); } catch {}
        }
      }
    }, 1000);

    // Set dev mode if requested (must be set at room creation time)
    if (options.devMode) {
      this.state.devMode = true;
    }

    if (scheduled) {
      // Reuse the reserved code rather than drawing a new one: the link the
      // host shared days ago has to keep resolving across every room this
      // reservation spins up.
      this.state.isPrivate = true;
      this.state.roomCode = scheduled.room_code;
      this.state.scheduledAt = scheduled.scheduled_at;
      this.state.scheduledTitle = scheduled.title ?? "";
      this.state.scheduledVideoUrl = scheduled.video_url ?? "";
      if (scheduled.is_dev) this.state.devMode = true;
      await this.setPrivate(true);
      await this.setMetadata({ roomCode: scheduled.room_code, devMode: this.state.devMode, scheduledId: scheduled.id });
    } else if (options.private) {
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
        brand_id: scheduled ? scheduled.brand_id : options?.brandId,  // play attribution (brand URL host created on); validated in createLiveGame
        host_user_id: scheduled ? scheduled.host_user_id : undefined,
        scheduled_game_id: scheduled ? scheduled.id : undefined,
      });
      // A reservation can outlive many rooms; always point it at the current one.
      if (scheduled) setScheduledRoom(scheduled.id, this.roomId, this._gameId);
      console.log(`[GameRoom] Live game created in DB: ${this._gameId}`);
    } catch (err) {
      console.error(`[GameRoom] Failed to create live game:`, err);
    }

    this.logEvent(undefined, "room_created", {
      isPrivate: this.state.isPrivate,
      roomCode: this.state.roomCode || null,
      devMode: this.state.devMode,
      hostAuthBypassed: !scheduled && hostUser === null,
      scheduledId: this._scheduledId,
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
        this.persistLivePlayers();
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

    this.onMessage("swap_card", (client, data: { cardIndex: number }) => {
      this.logEvent(client, "card_swapped", { cardIndex: data.cardIndex });
      handleSwapCard(this.state, client, data.cardIndex);
    });

    this.onMessage("reveal_complete", (client) => {
      this.logEvent(client, "reveal_complete");
      handleRevealComplete(this.state, client);
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

    // Host's video-call details. Deliberately NOT phase-gated like the game
    // settings above: a call can drop or change mid-game, and the details are
    // reachable from the in-game header, so the host must be able to fix them
    // after the lobby.
    this.onMessage("set_video_call", (client, data: unknown) => {
      if (this.state.hostId && this.state.hostId !== client.sessionId) return;
      const { entries, notes } = sanitizeVideoCall(data);
      this.state.videoCall.clear();
      for (const e of entries) {
        const entry = new VideoCallEntry();
        entry.kind = e.kind;
        entry.platform = e.platform;
        entry.value = e.value;
        entry.label = e.label;
        this.state.videoCall.push(entry);
      }
      this.state.videoCallNotes = notes;
      this.logEvent(client, "video_call_set", {
        count: entries.length,
        platforms: Array.from(new Set(entries.map((e) => e.platform))),
        hasNotes: notes.length > 0,
      });
    });

    this.onMessage("select_packs", (client, data: { packIds: string[] }) => {
      if (this.state.hostId && this.state.hostId !== client.sessionId) return;
      if (this.state.phase !== "lobby") return;
      const ids = Array.isArray(data?.packIds) ? data.packIds.filter((x) => typeof x === "string") : [];
      this.state.selectedPackIds.clear();
      for (const id of ids) this.state.selectedPackIds.push(id);
      // Drop any disabled-deck entries belonging to packs no longer selected.
      const allowed = new Set(ids);
      const kept = Array.from(this.state.disabledPackDecks).filter((key) => {
        const idx = key.lastIndexOf(":");
        if (idx < 0) return false;
        return allowed.has(key.slice(0, idx));
      });
      this.state.disabledPackDecks.clear();
      for (const k of kept) this.state.disabledPackDecks.push(k);
      this.logEvent(client, "packs_selected", { packIds: ids });
    });

    this.onMessage("set_pack_decks", (client, data: { packId: string; decks: ("die" | "live" | "bye")[] }) => {
      if (this.state.hostId && this.state.hostId !== client.sessionId) return;
      if (this.state.phase !== "lobby") return;
      const packId = typeof data?.packId === "string" ? data.packId : "";
      if (!packId) return;
      // Pack must currently be selected
      if (!Array.from(this.state.selectedPackIds).includes(packId)) return;
      const valid = new Set(["die", "live", "bye"]);
      const enabled = new Set(
        Array.isArray(data?.decks)
          ? data.decks.filter((d) => typeof d === "string" && valid.has(d))
          : []
      );
      // Rebuild disabledPackDecks: keep entries for other packs, replace this pack's entries.
      const kept = Array.from(this.state.disabledPackDecks).filter((key) => {
        const idx = key.lastIndexOf(":");
        return idx > 0 && key.slice(0, idx) !== packId;
      });
      const newDisabled = (["die", "live", "bye"] as const)
        .filter((d) => !enabled.has(d))
        .map((d) => `${packId}:${d}`);
      this.state.disabledPackDecks.clear();
      for (const k of [...kept, ...newDisabled]) this.state.disabledPackDecks.push(k);
      this.logEvent(client, "pack_decks_set", { packId, decks: Array.from(enabled) });
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

  /**
   * Snapshot the current roster into game_players so the player/users stats
   * (incl. the brand admin panel) reflect this LIVE game, not only completed
   * ones. Best-effort: never throws into the game loop.
   */
  private persistLivePlayers(): void {
    if (!this._gameId) return;
    try {
      const names: string[] = [];
      this.state.players.forEach((p) => { if (p?.name) names.push(p.name); });
      syncLivePlayers(this._gameId, names);
    } catch (err) {
      console.error('[GameRoom] persistLivePlayers failed:', err);
    }
  }

  async onJoin(client: Client, options: any) {
    const player = new Player();
    player.sessionId = client.sessionId;
    player.name = options.name || `Player ${this.state.players.size + 1}`;
    player.connected = true;

    const month = parseInt(options.birthMonth, 10);
    const day = parseInt(options.birthDay, 10);
    player.birthMonth = (month >= 1 && month <= 12) ? month : 0;
    player.birthDay = (day >= 1 && day <= 31) ? day : 0;
    player.isDevName = !!options.isDevName;

    // A scheduled room is created by whoever opens the link first — often a
    // guest — so the scheduler has to be able to claim the host seat whenever
    // they turn up. Only a verified Firebase token proves that; client-supplied
    // userId is not trusted here, since Player.userId is synced to every client
    // and would otherwise be trivially replayable.
    const isScheduler = this._scheduledId ? await this.verifyScheduler(options.authToken) : false;
    const isHost = isScheduler || !this.state.hostId;
    // The host's identity comes from the token verified in onCreate — never
    // from client-supplied options. Joiners keep the existing trust model.
    player.userId = (isHost && this._hostUserId) ? this._hostUserId : (options.userId || "");
    this.state.players.set(client.sessionId, player);

    // First player to join becomes the host — but in a scheduled room they only
    // hold the seat until the scheduler arrives and takes it back.
    if (isScheduler || !this.state.hostId) {
      this.state.hostId = client.sessionId;
    }

    // Recalculate DoD turn order on every join so late joiners are incorporated
    const newOrder = computeDodTurnOrder(this.state.players);
    this.state.turnOrder.splice(0, this.state.turnOrder.length);
    newOrder.forEach((id) => this.state.turnOrder.push(id));

    // Late join: if game is past lobby, mark for deferred die card.
    // Cards are NOT dealt here — the mini die completion handler (DiePhase.ts)
    // deals the correct phase cards after the late joiner's die reveal.
    // Dealing here would waste deck cards (cleared then re-dealt in mini die).
    const isLateJoin = this.state.phase !== "lobby";
    if (isLateJoin) {
      player.needsDieCard = true;
      console.log(`[GameRoom] Late join: ${player.name} joined during ${this.state.phase} — needsDieCard=true, hand=${player.hand.length}, dieDeck=${this.state.dieDeck.length}, livingDeck=${this.state.livingDeck.length}, byeDeck=${this.state.byeDeck.length}`);
    }

    this.logEvent(client, "player_joined", {
      name: player.name,
      birthMonth: player.birthMonth,
      birthDay: player.birthDay,
      isHost,
      isLateJoin,
      playerCount: this.state.players.size,
    });

    // Update live game record with player count, and (on host join) host name + host user id.
    if (this._gameId) {
      try {
        updateLiveGame(this._gameId, {
          playerCount: this.state.players.size,
          ...(isHost ? { hostName: player.name, hostUserId: player.userId || undefined } : {}),
        });
      } catch {}
    }
    // Reflect the new roster in player stats while the game is still live.
    this.persistLivePlayers();

    console.log(`[GameRoom] ${player.name} joined (${client.sessionId})`);
  }

  /**
   * True when this joiner's token resolves to the account that scheduled the
   * game. Never throws — a bad or missing token just means "not the scheduler",
   * so a failed check can't block someone from joining.
   */
  private async verifyScheduler(authToken: unknown): Promise<boolean> {
    if (!this._hostUserId || typeof authToken !== "string" || authToken.length === 0) return false;
    try {
      const user = await verifyHostAuthorization(authToken);
      return user !== null && user.id === this._hostUserId;
    } catch {
      return false;
    }
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
      this.persistLivePlayers();
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
        let durationSeconds: number | undefined;
        if (this._gameStartedAt) {
          durationSeconds = Math.round(
            (Date.now() - new Date(this._gameStartedAt).getTime()) / 1000
          );
        }
        abandonGame(this._gameId, durationSeconds);
        console.log(`[GameRoom] Game marked as abandoned: ${this._gameId}`);
      } catch (err) {
        console.error(`[GameRoom] Failed to mark game as abandoned:`, err);
      }
    }

    // A scheduled lobby's room comes and goes freely before the start: clearing
    // room_id just means "nobody is here right now", and the next visitor spins
    // a fresh room up on the same code. Once the game has actually started,
    // though, the room going away ends it — and the link with it.
    if (this._scheduledId) {
      try {
        const scheduled = getScheduledById(this._scheduledId);
        if (scheduled?.started_at) {
          markScheduledEnded(this._scheduledId);
        } else {
          setScheduledRoom(this._scheduledId, null);
        }
      } catch (err) {
        console.error(`[GameRoom] Failed to update scheduled game on dispose:`, err);
      }
    }

    console.log(`[GameRoom] Room disposed`);
  }

  private applySetting(key: string, value: any) {
    // Boolean settings
    const boolKeys = [
      "autoStartOnReady", "enableDie", "enableLive", "enableBye", "enableEulogy",
      "playableWildcards", "optionalCardPlay", "ultraQuickMode",
      "timerEnabled", "pitchTimerEnabled", "playCardTimerEnabled",
      "timerCountUp", "timerVisible", "timerAutoAdvance", "showCardReveal",
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

    if (key === "forceWildcards") {
      const allowed = ["off", "atLeastOne", "everyone"];
      if (typeof value === "string" && allowed.includes(value)) {
        this.state.forceWildcards = value;
      }
      // Legacy boolean support
      if (typeof value === "boolean") {
        this.state.forceWildcards = value ? "everyone" : "off";
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
        "optionalCardPlay", "ultraQuickMode", "timerEnabled", "pitchDuration", "showCardReveal",
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
        host_user_id: hostPlayer?.userId || undefined,
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

      if (!this.state.devMode) {
        try {
          const embed = buildGameFinishEmbed({
            mode: "online",
            roomCode: this.state.roomCode || null,
            hostName: hostPlayer?.name || null,
            winnerName: sorted[0]?.name || null,
            winnerScore: sorted[0]?.score ?? null,
            playerCount: sorted.length,
            rounds: this.state.rounds,
            durationSeconds: durationSeconds ?? null,
            apiVersion: apiPkg.version,
          });
          postWebhookEmbed(embed).catch(() => { /* never throws, defensive */ });
        } catch (err) {
          console.warn(`[GameRoom] discord notify (finish) failed:`, err);
        }
      }
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

  private captureCardDraws() {
    try {
      const phase = this.state.phase === "die_phase" ? "die"
        : this.state.phase === "living_submit" ? "living"
        : "bye";
      const draws: CardDraw[] = [];

      this.state.players.forEach((player) => {
        for (let i = 0; i < player.hand.length; i++) {
          const card = player.hand[i];
          draws.push({
            game_id: this._gameId!,
            phase,
            card_id: String(card.id),
            card_deck: card.deck,
          });
        }
      });

      if (draws.length > 0) {
        saveCardDraws(draws);
      }
    } catch (err) {
      console.error("[GameRoom] Failed to capture card draws:", err);
    }
  }

  private startGame() {
    console.log(`[GameRoom] Game starting — creating decks`);
    this._gameStartedAt = new Date().toISOString();
    this._previousPhase = "lobby"; // ensure phase_changed fires for die_phase

    // Merge any selected expansion packs with the base-game cards.
    // The base game is represented by the sentinel pack id "base" — if it's
    // not in selectedPackIds the host has chosen an expansion-only game.
    const selectedPackIds = Array.from(this.state.selectedPackIds);
    const disabledSet = new Set(Array.from(this.state.disabledPackDecks));
    const isDeckEnabled = (packId: string, deck: "die" | "live" | "bye") =>
      !disabledSet.has(`${packId}:${deck}`);

    const useBase = selectedPackIds.includes("base");
    const baseDie    = useBase && isDeckEnabled("base", "die")  ? DIE_CARDS    : [];
    const baseLiving = useBase && isDeckEnabled("base", "live") ? LIVING_CARDS : [];
    const baseBye    = useBase && isDeckEnabled("base", "bye")  ? BYE_CARDS    : [];

    // Record pack usage for marketplace analytics (non-base packs only).
    // Wrapped in try/catch so analytics failures don't break room creation.
    if (this._gameId) {
      const gameId = this._gameId;
      for (const packId of selectedPackIds) {
        if (packId && packId !== "base") {
          try { recordPackUsage(packId, gameId); }
          catch (err) { console.warn(`[GameRoom] recordPackUsage failed for ${packId}:`, err); }
        }
      }
    }

    const expansionRaw = getCardsByPackIds(selectedPackIds).filter((c) =>
      isDeckEnabled(c.pack_id, c.deck_type as "die" | "live" | "bye")
    );
    const expansion = expansionCardsToCardData(expansionRaw);
    const merged = mergeDecks(baseDie, baseLiving, baseBye, expansion);
    console.log(
      `[GameRoom] Packs: ${selectedPackIds.join(',') || 'none'}; ` +
      `disabledDecks: ${Array.from(disabledSet).join(',') || 'none'}; ` +
      `deck sizes die=${merged.die.length} living=${merged.living.length} bye=${merged.bye.length}`
    );

    const shuffledDieDeck = shuffle(createDeck(merged.die, "die"));
    const shuffledLivingDeck = shuffle(createDeck(merged.living, "living"));
    const shuffledByeDeck = shuffle(createDeck(merged.bye, "bye"));

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

    if (!this.state.devMode) {
      try {
        const hostPlayer = this.state.hostId ? this.state.players.get(this.state.hostId) : null;
        const embed = buildGameStartEmbed({
          mode: "online",
          roomCode: this.state.roomCode || null,
          hostName: hostPlayer?.name || null,
          playerCount: this.state.players.size,
          apiVersion: apiPkg.version,
        });
        postWebhookEmbed(embed).catch(() => { /* never throws, defensive */ });
      } catch (err) {
        console.warn(`[GameRoom] discord notify (start) failed:`, err);
      }
    }

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
