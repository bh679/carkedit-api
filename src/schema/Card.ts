import { ArraySchema, Schema, type } from "@colyseus/schema";

export class Card extends Schema {
  @type("string") id: string = "";
  @type("string") text: string = "";        // Card content (replaces value)
  @type("string") deck: string = "";        // "die", "living", or "bye" (replaces cardType)
  @type("boolean") faceUp: boolean = false;
  @type("string") submittedBy: string = ""; // Session ID of submitter (empty if not submitted)
  @type("string") special: string = "";     // "Wildcard" / "?" / "Split"
  @type("string") packId: string = "";      // Source expansion pack id, empty for base cards
  @type("string") prompt: string = "";      // Optional follow-up prompt rendered under the card text
  @type("string") image_url: string = "";   // Optional custom-card illustration (served from /api/carkedit/uploads/card-images/)
  @type("string") text_position: string = "";  // 'top' | 'bottom' — title overlay position (standard die only)
  @type("string") text_color: string = "";     // 'black' | 'white' — title text color (standard die only)
  @type(["string"]) options = new ArraySchema<string>(); // Two choices for "Split" die cards
}
