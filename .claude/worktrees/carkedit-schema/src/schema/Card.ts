import { Schema, type } from "@colyseus/schema";

export class Card extends Schema {
  @type("string") id: string = "";
  @type("string") text: string = "";        // Card content (replaces value)
  @type("string") deck: string = "";        // "die", "living", or "bye" (replaces cardType)
  @type("boolean") faceUp: boolean = false;
  @type("string") submittedBy: string = ""; // Session ID of submitter (empty if not submitted)
}
