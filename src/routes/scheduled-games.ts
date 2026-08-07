// CarkedIt API — Scheduled lobby endpoints.
//
// The join link for a scheduled game has to work at any point in its life, and
// the people opening it are usually guests who cannot create a Colyseus room
// themselves (hosting is Host-role gated). So room creation happens HERE,
// server-side: /:code/room spins a room up on demand from the reservation,
// which is the host's standing authorization. Only this file ever passes
// `scheduledId` into matchMaker — a client can never hand it to GameRoom.
import { Router } from "express";
import { matchMaker } from "colyseus";
import { requireAuth, requireRole } from "../middleware/auth.js";
import { publicWriteLimiter, publicBodyLimit } from "../middleware/rate-limit.js";
import { isGuestHostingAllowed } from "../rooms/hostAuth.js";
import {
  reserveRoomCode,
  createScheduledGame,
  getScheduledByCode,
  getScheduledById,
  listScheduledForHost,
  updateScheduledGame,
  cancelScheduledGame,
  scheduledStatus,
  isJoinable,
  parseVideoCall,
  validateScheduledAt,
  ScheduleValidationError,
  CodePoolExhaustedError,
} from "../db/scheduledGames.js";
import type { ScheduledGame } from "../db/types.js";

/**
 * Local-dev identity when ALLOW_GUEST_HOSTING=1 lets un-Firebased environments
 * host. Mirrors the bypass in verifyHostAuthorization; never set on staging/prod.
 */
const GUEST_HOST_USER_ID = "guest-host";

const MAX_TITLE_LENGTH = 60;

/**
 * Auth for the host-only endpoints, with the same dev bypass hosting itself
 * uses — otherwise a reservation made in an un-Firebased local environment
 * could be created but never listed or cancelled.
 */
function requireHost(gate: (req: any, res: any, next: any) => void) {
  return (req: any, res: any, next: any) => (isGuestHostingAllowed() ? next() : gate(req, res, next));
}

/** The account a request acts as. Falls back to the dev identity under the bypass. */
function hostIdentity(req: any): string {
  return req.localUser?.id ?? GUEST_HOST_USER_ID;
}

/** Shape returned to clients — never leaks host_user_id or internal ids to joiners. */
function publicView(row: ScheduledGame) {
  return {
    status: scheduledStatus(row),
    code: row.room_code,
    scheduledAt: row.scheduled_at,
    expiresAt: row.expires_at,
    title: row.title,
    // Public on purpose: everyone holding the join code needs the call details.
    videoCall: parseVideoCall(row.video_call_json).entries,
    videoCallNotes: parseVideoCall(row.video_call_json).notes,
    roomId: row.room_id,
  };
}

/** Fuller view for the host's own management list. */
function ownerView(row: ScheduledGame) {
  return { ...publicView(row), id: row.id, createdAt: row.created_at };
}

function normaliseTitle(input: unknown): string | null {
  if (typeof input !== "string") return null;
  const trimmed = input.trim().slice(0, MAX_TITLE_LENGTH);
  return trimmed === "" ? null : trimmed;
}

/** True when a Colyseus room with this id is still running. */
async function isRoomAlive(roomId: string): Promise<boolean> {
  const rooms = await matchMaker.query({ name: "game" });
  return rooms.some((r: any) => r.roomId === roomId);
}

/**
 * Mirror a saved schedule edit into the lobby that is already running for it,
 * so everyone sitting there sees the new name and time at once rather than the
 * stale ones the room was created with. Best-effort by design: most edits
 * happen days ahead with no room alive, and a room that disposed mid-request
 * must not turn a successful save into an error.
 */
async function pushScheduleToRoom(roomId: string | null, updated: ScheduledGame): Promise<void> {
  if (!roomId) return;
  try {
    if (!(await isRoomAlive(roomId))) return;
    await matchMaker.remoteRoomCall(roomId, "applyScheduleUpdate", [
      { scheduledAt: updated.scheduled_at, title: updated.title },
    ]);
  } catch (err) {
    console.error("[CarkedIt API] Failed to push schedule update to room:", err);
  }
}

/** True when a live room already holds this code (walk-up rooms aren't in the DB). */
async function isCodeLive(code: string): Promise<boolean> {
  const rooms = await matchMaker.query({ name: "game" });
  return rooms.some((r: any) => r.metadata?.roomCode === code);
}

/**
 * In-flight room creations, keyed by code. Two people opening the same link at
 * once must land in the SAME room — without this they would each create one and
 * the code would resolve to whichever won the race.
 */
const roomCreationsInFlight = new Map<string, Promise<string>>();

async function ensureRoom(row: ScheduledGame): Promise<string> {
  if (row.room_id && (await isRoomAlive(row.room_id))) return row.room_id;

  const pending = roomCreationsInFlight.get(row.room_code);
  if (pending) return pending;

  const creation = (async () => {
    // Re-read inside the guard: an earlier waiter may have just created the room.
    const fresh = getScheduledById(row.id);
    if (fresh?.room_id && (await isRoomAlive(fresh.room_id))) return fresh.room_id;
    const room = await matchMaker.createRoom("game", {
      scheduledId: row.id,
      private: true,
      devMode: !!row.is_dev,
    });
    return room.roomId;
  })().finally(() => {
    roomCreationsInFlight.delete(row.room_code);
  });

  roomCreationsInFlight.set(row.room_code, creation);
  return creation;
}

const router = Router();

/**
 * Create a reservation. Host-role gated — this is the hosting decision; every
 * later room spun up from the row inherits that authorization.
 */
router.post(
  "/",
  publicBodyLimit,
  requireHost(requireRole("Host")),
  async (req: any, res: any) => {
    try {
      const scheduledAt = validateScheduledAt(req.body?.scheduledAt);
      const hostUserId = hostIdentity(req);
      const code = await reserveRoomCode(isCodeLive);
      const row = createScheduledGame({
        room_code: code,
        scheduled_at: scheduledAt,
        host_user_id: hostUserId,
        title: normaliseTitle(req.body?.title),
        video_call: { entries: req.body?.videoCall, notes: req.body?.videoCallNotes },
        brand_id: typeof req.body?.brandId === "string" ? req.body.brandId : null,
        is_dev: !!req.body?.devMode,
      });
      res.json(ownerView(row));
    } catch (err: any) {
      if (err instanceof ScheduleValidationError) return res.status(400).json({ error: err.message });
      if (err instanceof CodePoolExhaustedError) return res.status(503).json({ error: err.message });
      console.error("[CarkedIt API] Create scheduled game error:", err);
      res.status(500).json({ error: "Failed to schedule game" });
    }
  },
);

/** The signed-in host's own upcoming games. */
router.get("/", requireHost(requireAuth()), (req: any, res: any) => {
  try {
    res.json({ games: listScheduledForHost(hostIdentity(req)).map(ownerView) });
  } catch (err) {
    console.error("[CarkedIt API] List scheduled games error:", err);
    res.status(500).json({ error: "Failed to load scheduled games" });
  }
});

/**
 * Resolve a join code. Public and unauthenticated — this is what the join link
 * hits, often long before anyone signs in. Expiry is derived, so a stale row
 * reads as 'expired' even if the sweeper hasn't run.
 */
router.get("/:code", (req: any, res: any) => {
  try {
    const row = getScheduledByCode(String(req.params.code || ""));
    if (!row) return res.status(404).json({ status: "notfound", error: "No scheduled game with that code" });
    res.json(publicView(row));
  } catch (err) {
    console.error("[CarkedIt API] Scheduled lookup error:", err);
    res.status(500).json({ error: "Server error" });
  }
});

/**
 * Ensure a room exists for this code and return its id to join. Public: guests
 * arriving before the host must be able to open the waiting room.
 */
router.post("/:code/room", publicWriteLimiter, async (req: any, res: any) => {
  try {
    const row = getScheduledByCode(String(req.params.code || ""));
    if (!row) return res.status(404).json({ status: "notfound", error: "No scheduled game with that code" });
    if (!isJoinable(row)) {
      return res.status(409).json({ status: scheduledStatus(row), error: messageFor(scheduledStatus(row)) });
    }
    const roomId = await ensureRoom(row);
    res.json({ roomId, code: row.room_code, scheduledAt: row.scheduled_at, title: row.title });
  } catch (err) {
    console.error("[CarkedIt API] Scheduled room open error:", err);
    res.status(500).json({ error: "Could not open the game room" });
  }
});

function messageFor(status: string): string {
  switch (status) {
    case "cancelled": return "This game was cancelled by the host";
    case "ended": return "This game has already finished";
    case "expired": return "This game link has expired";
    default: return "This game is not available";
  }
}

/** Reschedule / rename — owner only. */
router.patch("/:id", requireHost(requireAuth()), publicBodyLimit, async (req: any, res: any) => {
  try {
    const row = getScheduledById(String(req.params.id || ""));
    if (!row || row.host_user_id !== hostIdentity(req)) {
      return res.status(404).json({ error: "Scheduled game not found" });
    }
    if (row.cancelled_at || row.ended_at) {
      return res.status(409).json({ error: "This game can no longer be changed" });
    }
    const fields: { scheduled_at?: string; title?: string | null; video_call?: unknown } = {};
    if (req.body?.scheduledAt !== undefined) fields.scheduled_at = validateScheduledAt(req.body.scheduledAt);
    if (req.body?.title !== undefined) fields.title = normaliseTitle(req.body.title);
    if (req.body?.videoCall !== undefined || req.body?.videoCallNotes !== undefined) {
      fields.video_call = { entries: req.body?.videoCall, notes: req.body?.videoCallNotes };
    }
    const updated = updateScheduledGame(row.id, fields);
    await pushScheduleToRoom(row.room_id, updated!);
    res.json(ownerView(updated!));
  } catch (err: any) {
    if (err instanceof ScheduleValidationError) return res.status(400).json({ error: err.message });
    console.error("[CarkedIt API] Update scheduled game error:", err);
    res.status(500).json({ error: "Failed to update scheduled game" });
  }
});

/** Cancel — owner only. Releases the code back to the pool immediately. */
router.delete("/:id", requireHost(requireAuth()), (req: any, res: any) => {
  try {
    const row = getScheduledById(String(req.params.id || ""));
    if (!row || row.host_user_id !== hostIdentity(req)) {
      return res.status(404).json({ error: "Scheduled game not found" });
    }
    cancelScheduledGame(row.id);
    res.json({ status: "cancelled" });
  } catch (err) {
    console.error("[CarkedIt API] Cancel scheduled game error:", err);
    res.status(500).json({ error: "Failed to cancel scheduled game" });
  }
});

export default router;
