import { Schema, type } from "@colyseus/schema";

/**
 * One piece of the host's video-call details, synced to every player in the
 * room. The host pastes a raw invite client-side; the client splits it into
 * these entries and sends them up, where sanitizeVideoCall (src/utils/videoCall.ts)
 * re-validates every field before it reaches the room state.
 */
export class VideoCallEntry extends Schema {
  @type("string") kind: string = "";      // "link" | "phone" | "code"
  @type("string") platform: string = "";  // slug from PLATFORM_SLUGS, else "other"
  @type("string") value: string = "";     // http(s) URL | dial string | meeting id/passcode
  @type("string") label: string = "";     // display label, e.g. "Dial-in (AU)" / "Passcode"
}
