import { Room, Client } from "colyseus";
import { GameState } from "../schema/GameState.js";
import { Player } from "../schema/Player.js";
import { shuffle, createDeck, createDieDeck } from "../utils/deck.js";
import { computeDodTurnOrder } from "../utils/turnOrder.js";
import { DIE_CARDS, LIVING_CARDS, BYE_CARDS } from "../data/cards.js";
import { handleRevealDie, handleEndDieTurn } from "../phases/DiePhase.js";
import { handleSubmitCard, handleRevealSubmission, handleEndConvinceTurn, handleSelectWinner, handleNextRound } from "../phases/LivingPhase.js";
import { ROOM_CODE_WORDS } from "./roomWords.js";

const MIN_PLAYERS = 2;

function generateRoomCode(): string {
  return ROOM_CODE_WORDS[Math.floor(Math.random() * ROOM_CODE_WORDS.length)];
}

export class GameRoom extends Room<{ state: GameState }> {
  maxClients = 10;

  async onCreate(options: any) {
    this.setState(new GameState());

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
      // Auto-advance after 5 seconds if still in winner phase
      if (this.state.phase === "living_winner" || this.state.phase === "bye_winner") {
        this.clock.setTimeout(() => {
          handleNextRound(this.state);
        }, 5000);
      }
    });

    this.onMessage("setting", (client, data: { key: string; value: any }) => {
      // Only the host (room creator) can change settings
      if (this.state.hostId && this.state.hostId !== client.sessionId) return;
      if (this.state.phase !== "lobby") return;
      if (data.key === "autoStartOnReady" && typeof data.value === "boolean") {
        this.state.autoStartOnReady = data.value;
      }
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

  onLeave(client: Client, _code?: number) {
    const player = this.state.players.get(client.sessionId);
    if (player) {
      console.log(`[GameRoom] ${player.name} left`);
      player.connected = false;

      if (this.state.phase === "lobby") {
        this.state.players.delete(client.sessionId);
      }
    }
  }

  onDispose() {
    console.log(`[GameRoom] Room disposed`);
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

  private startGame() {
    console.log(`[GameRoom] Game starting — creating decks`);

    const shuffledDieDeck = shuffle(createDieDeck(DIE_CARDS));
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
