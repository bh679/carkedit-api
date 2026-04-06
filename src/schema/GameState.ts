import { Schema, MapSchema, ArraySchema, type } from "@colyseus/schema";
import { Player } from "./Player.js";
import { Card } from "./Card.js";

export type GamePhase =
  | "lobby"
  | "die_phase"
  | "living_setup" | "living_submit" | "living_reveal" | "living_convince" | "living_select" | "living_winner"
  | "bye_setup" | "bye_submit" | "bye_reveal" | "bye_convince" | "bye_select" | "bye_winner"
  | "eulogy_intro" | "eulogy_pick" | "eulogy_speech" | "eulogy_judge" | "eulogy_points"
  | "winner"
  | "game_over";

export class GameState extends Schema {
  @type("string") phase: string = "lobby";
  @type("string") currentTurn: string = "";
  @type("string") currentLivingDead: string = "";
  @type("string") convincingTurn: string = "";
  @type("number") round: number = 0;
  @type("string") roundWinner: string = "";
  @type("number") roundWinnerCardIndex: number = -1;
  @type("string") roomCode: string = "";
  @type("boolean") isPrivate: boolean = false;
  @type("boolean") devMode: boolean = false;
  @type("boolean") autoStartOnReady: boolean = true;
  @type("string") hostId: string = "";
  @type({ map: Player }) players = new MapSchema<Player>();
  @type([Card]) dieDeck = new ArraySchema<Card>();
  @type([Card]) livingDeck = new ArraySchema<Card>();
  @type([Card]) byeDeck = new ArraySchema<Card>();
  @type([Card]) submittedCards = new ArraySchema<Card>();
  @type(["string"]) turnOrder = new ArraySchema<string>();

  // Game settings (synced to all clients, host-editable during lobby)
  @type("number") rounds: number = 2;
  @type("number") handSize: number = 5;
  @type("boolean") enableDie: boolean = true;
  @type("boolean") enableLive: boolean = true;
  @type("boolean") enableBye: boolean = true;
  @type("boolean") enableEulogy: boolean = true;
  @type("boolean") forceWildcards: boolean = false;
  @type("boolean") playableWildcards: boolean = true;
  @type("number") wildcardCount: number = 2;
  @type("number") eulogistCount: number = 2;
  @type("string") handRedraws: string = "once_per_phase";
  @type("boolean") timerEnabled: boolean = false;
  @type("boolean") pitchTimerEnabled: boolean = true;
  @type("boolean") playCardTimerEnabled: boolean = true;
  @type("boolean") timerCountUp: boolean = false;
  @type("number") pitchDuration: number = 120;
  @type("boolean") timerVisible: boolean = true;
  @type("boolean") timerAutoAdvance: boolean = true;
  @type("boolean") ultraQuickMode: boolean = false;
  @type("boolean") optionalCardPlay: boolean = false;

  // Eulogy (Phase 4) state
  @type("string") currentWildcardPlayer: string = "";
  @type("number") currentWildcardIndex: number = 0;
  @type(["string"]) wildcardPlayerIds = new ArraySchema<string>();
  @type(["string"]) selectedEulogists = new ArraySchema<string>();
  @type("number") currentEulogistIndex: number = 0;
  @type("string") bestEulogist: string = "";

  // Late-join: tracks which phase to resume after a mini die phase
  @type("string") pendingPhase: string = "";
}
