import { Room, Client } from "colyseus";
import { GameState } from "../schema/GameState";
import { Player } from "../schema/Player";
import { Card } from "../schema/Card";

const MIN_PLAYERS = 2;
const CARDS_PER_PLAYER = 5;

function createDeck(): Card[] {
  const types = ["attack", "defend", "heal", "boost", "wild"];
  const values = ["1", "2", "3", "4", "5"];
  const cards: Card[] = [];

  for (const cardType of types) {
    for (const value of values) {
      const card = new Card();
      card.id = `${cardType}-${value}-${cards.length}`;
      card.value = value;
      card.cardType = cardType;
      card.faceUp = false;
      cards.push(card);
    }
  }

  return cards;
}

const ROOM_CODE_CHARS = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";

function generateRoomCode(): string {
  return Array.from({ length: 4 }, () =>
    ROOM_CODE_CHARS[Math.floor(Math.random() * ROOM_CODE_CHARS.length)]
  ).join("");
}

function shuffle<T>(array: T[]): T[] {
  const shuffled = [...array];
  for (let i = shuffled.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
  }
  return shuffled;
}

export class GameRoom extends Room<{ state: GameState }> {
  maxClients = 10;

  async onCreate(options: any) {
    this.setState(new GameState());

    if (options.private) {
      this.state.isPrivate = true;
      this.state.roomCode = generateRoomCode();
      await this.setPrivate(true);
      await this.setMetadata({ roomCode: this.state.roomCode });
    }

    this.onMessage("ready", (client) => {
      this.handleReady(client);
    });

    this.onMessage("flip", (client, data: { cardIndex: number }) => {
      this.handleFlip(client, data.cardIndex);
    });

    this.onMessage("play", (client, data: { cardIndex: number }) => {
      this.handlePlay(client, data.cardIndex);
    });

    this.onMessage("set_name", (client, data: { name: string }) => {
      const player = this.state.players.get(client.sessionId);
      if (player) {
        player.name = data.name;
      }
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

  onLeave(client: Client, code?: number) {
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
    this.state.phase = "dealing";
    console.log(`[GameRoom] Game starting — dealing cards`);

    const deck = shuffle(createDeck());

    const playerIds = Array.from(this.state.players.keys());

    let cardIndex = 0;
    for (const playerId of playerIds) {
      const player = this.state.players.get(playerId);
      if (!player) continue;

      for (let i = 0; i < CARDS_PER_PLAYER; i++) {
        if (cardIndex < deck.length) {
          player.hand.push(deck[cardIndex]);
          cardIndex++;
        }
      }
    }

    for (let i = cardIndex; i < deck.length; i++) {
      this.state.deck.push(deck[i]);
    }

    this.state.currentTurn = playerIds[0];
    this.state.round = 1;

    this.clock.setTimeout(() => {
      this.state.phase = "playing";
      console.log(`[GameRoom] Phase: playing — ${this.state.currentTurn}'s turn`);
    }, 1000);
  }

  private handleFlip(client: Client, cardIndex: number) {
    if (this.state.phase !== "playing") return;
    if (this.state.currentTurn !== client.sessionId) return;

    const player = this.state.players.get(client.sessionId);
    if (!player) return;

    const card = player.hand[cardIndex];
    if (!card) return;

    card.faceUp = !card.faceUp;
    console.log(`[GameRoom] ${player.name} flipped card ${card.id} (faceUp: ${card.faceUp})`);
  }

  private handlePlay(client: Client, cardIndex: number) {
    if (this.state.phase !== "playing") return;
    if (this.state.currentTurn !== client.sessionId) return;

    const player = this.state.players.get(client.sessionId);
    if (!player) return;

    const card = player.hand[cardIndex];
    if (!card) return;

    card.faceUp = true;
    const played = player.hand.splice(cardIndex, 1);
    if (played.length > 0) {
      this.state.discard.push(played[0]);
    }

    console.log(`[GameRoom] ${player.name} played ${card.cardType}-${card.value}`);

    this.advanceTurn();
  }

  private advanceTurn() {
    const playerIds = Array.from(this.state.players.keys());
    const currentIndex = playerIds.indexOf(this.state.currentTurn);
    const nextIndex = (currentIndex + 1) % playerIds.length;

    if (nextIndex === 0) {
      this.state.round++;
    }

    this.state.currentTurn = playerIds[nextIndex];
    console.log(`[GameRoom] Turn: ${this.state.currentTurn}`);
  }
}
