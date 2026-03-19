import { Schema, MapSchema, ArraySchema, type } from "@colyseus/schema";
import { Player } from "./Player";
import { Card } from "./Card";

export type GamePhase =
  | "lobby"
  | "die_phase"
  | "living_setup" | "living_submit" | "living_convince" | "living_select"
  | "bye_setup" | "bye_submit" | "bye_convince" | "bye_select"
  | "game_over";

export class GameState extends Schema {
  @type("string") phase: string = "lobby";
  @type("string") currentTurn: string = "";
  @type("string") currentLivingDead: string = "";
  @type("string") convincingTurn: string = "";
  @type("number") round: number = 0;
  @type({ map: Player }) players = new MapSchema<Player>();
  @type([Card]) dieDeck = new ArraySchema<Card>();
  @type([Card]) livingDeck = new ArraySchema<Card>();
  @type([Card]) byeDeck = new ArraySchema<Card>();
  @type([Card]) submittedCards = new ArraySchema<Card>();
  @type(["string"]) turnOrder = new ArraySchema<string>();
}
