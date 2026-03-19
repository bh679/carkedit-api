import { Schema, MapSchema, ArraySchema, type } from "@colyseus/schema";
import { Player } from "./Player";
import { Card } from "./Card";

export type GamePhase = "lobby" | "dealing" | "playing" | "round_end" | "game_over";

export class GameState extends Schema {
  @type("string") phase: string = "lobby";
  @type("string") currentTurn: string = "";
  @type("number") round: number = 0;
  @type("string") roomCode: string = "";
  @type("boolean") isPrivate: boolean = false;
  @type({ map: Player }) players = new MapSchema<Player>();
  @type([Card]) deck = new ArraySchema<Card>();
  @type([Card]) discard = new ArraySchema<Card>();
}
