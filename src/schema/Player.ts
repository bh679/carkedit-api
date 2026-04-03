import { Schema, ArraySchema, type } from "@colyseus/schema";
import { Card } from "./Card.js";

export class Player extends Schema {
  @type("string") sessionId: string = "";
  @type("string") name: string = "";
  @type("boolean") ready: boolean = false;
  @type("boolean") connected: boolean = true;
  @type("number") score: number = 0;
  @type("number") birthMonth: number = 0;
  @type("number") birthDay: number = 0;
  @type([Card]) hand = new ArraySchema<Card>();
  @type("boolean") hasSubmitted: boolean = false;
  @type("boolean") hasBeenLivingDead: boolean = false;
  @type("boolean") hasWildcard: boolean = false;
  @type("boolean") isDevName: boolean = false;
}
