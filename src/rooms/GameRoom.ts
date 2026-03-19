import { Room, Client } from "colyseus";
import { GameState } from "../schema/GameState";
import { Player } from "../schema/Player";
import { shuffle, createDeck } from "../utils/deck";
import { DIE_CARDS, LIVING_CARDS, BYE_CARDS } from "../data/cards";

const MIN_PLAYERS = 2;

const ROOM_CODE_CHARS = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";

function generateRoomCode(): string {
  return Array.from({ length: 4 }, () =>
    ROOM_CODE_CHARS[Math.floor(Math.random() * ROOM_CODE_CHARS.length)]
  ).join("");
}

export class GameRoom extends Room<{ state: GameState }> {
  maxClients = 10;

  async onCreate(options: any) {
    this.setState(new GameState());

    if (options.private) {
      const roomCode = generateRoomCode();
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

    this.onMessage("reveal_die", (client, _data: unknown) => {
      console.log(`[GameRoom] reveal_die from ${client.sessionId}`);
    });

    this.onMessage("end_die_turn", (client, _data: unknown) => {
      console.log(`[GameRoom] end_die_turn from ${client.sessionId}`);
    });

    this.onMessage("submit_card", (client, data: { cardIndex: number }) => {
      console.log(`[GameRoom] submit_card from ${client.sessionId}, cardIndex: ${data.cardIndex}`);
    });

    this.onMessage("reveal_submission", (client, _data: unknown) => {
      console.log(`[GameRoom] reveal_submission from ${client.sessionId}`);
    });

    this.onMessage("end_convince_turn", (client, _data: unknown) => {
      console.log(`[GameRoom] end_convince_turn from ${client.sessionId}`);
    });

    this.onMessage("select_winner", (client, data: { cardIndex: number }) => {
      console.log(`[GameRoom] select_winner from ${client.sessionId}, cardIndex: ${data.cardIndex}`);
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
    if (allReady && this.state.players.size >= MIN_PLAYERS) {
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

    const shuffledDieDeck = shuffle(createDeck(DIE_CARDS, "die"));
    const shuffledLivingDeck = shuffle(createDeck(LIVING_CARDS, "living"));
    const shuffledByeDeck = shuffle(createDeck(BYE_CARDS, "bye"));

    shuffledDieDeck.forEach((card) => this.state.dieDeck.push(card));
    shuffledLivingDeck.forEach((card) => this.state.livingDeck.push(card));
    shuffledByeDeck.forEach((card) => this.state.byeDeck.push(card));

    const playerKeys = Array.from(this.state.players.keys());
    const shuffledOrder = shuffle(playerKeys);
    shuffledOrder.forEach((id) => this.state.turnOrder.push(id));

    // Deal 1 Die card per player from the dieDeck
    for (const playerId of shuffledOrder) {
      const player = this.state.players.get(playerId);
      if (!player) continue;

      if (this.state.dieDeck.length > 0) {
        const card = this.state.dieDeck.splice(0, 1)[0];
        player.hand.push(card);
      }
    }

    this.state.currentTurn = shuffledOrder[0];
    this.state.round = 1;
    this.state.phase = "die_phase";

    console.log(`[GameRoom] Phase: die_phase — ${this.state.currentTurn}'s turn`);
  }
}
