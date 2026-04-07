import { randomUUID } from "node:crypto";
import path from "path";
import fs from "fs";
import { fileURLToPath } from "url";
import express from "express";
import { defineServer, defineRoom, matchMaker } from "colyseus";
import { GameRoom } from "./rooms/GameRoom.js";
import { initDatabase, saveGameResult, createLiveGame, updateLiveGame, completeLiveGame, abandonGame, getRecentGames, getGameById, getStats, getStatsByPeriod, getCardStats, getGameEvents, saveIssueReport, getIssueReports } from "./db/database.js";
import { createUser, getUserById, updateUserProfile, linkAnonymousUserToFirebase, listUsers, hasAnyAdmin, setAdminFlag } from "./db/users.js";
import { createPack, getPackById, listPacks, updatePack, deletePack, addCards, updateCard, deleteCard, addFavorite, removeFavorite, listUserFavorites, setPackOfficial } from "./db/packs.js";
import { optionalAuth, requireAuth, requireAdmin, setFirebaseAvailable } from "./middleware/auth.js";
import type { GameResult, IssueReport } from "./db/types.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const port = parseInt(process.env.PORT || "4500", 10);
const clientDir = process.env.CLIENT_DIR || path.join(__dirname, "../../carkedit-client");

// Initialize Firebase Admin SDK
const serviceAccountPath = process.env.FIREBASE_SERVICE_ACCOUNT_PATH || path.join(__dirname, "../firebase-service-account.json");
try {
  if (fs.existsSync(serviceAccountPath)) {
    const { initializeApp, cert } = await import("firebase-admin/app");
    const serviceAccount = JSON.parse(fs.readFileSync(serviceAccountPath, "utf-8"));
    initializeApp({ credential: cert(serviceAccount) });
    setFirebaseAvailable(true);
    console.log("[CarkedIt API] Firebase Admin initialized");
  } else {
    console.warn("[CarkedIt API] Firebase service account not found — auth features disabled");
  }
} catch (err: any) {
  console.warn("[CarkedIt API] Firebase init failed:", err.message);
}

const serverStartedAt = new Date().toISOString();

const server = defineServer({
  rooms: {
    game: defineRoom(GameRoom),
  },
  express: (app) => {
    app.use(express.json());

    // Force browsers to revalidate HTML pages (picks up new versioned asset URLs)
    app.use((req, res, next) => {
      if (req.path.endsWith('.html') || req.path === '/' || !path.extname(req.path)) {
        res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
      }
      next();
    });

    app.use(express.static(clientDir, { extensions: ['html'] }));

    // Apply optional auth to pack and user routes
    app.use('/api/carkedit/packs', optionalAuth());
    app.use('/api/carkedit/users', optionalAuth());

    app.get("/api/carkedit/health", (_req: any, res: any) => {
      res.json({ status: "ok", timestamp: new Date().toISOString() });
    });

    app.get("/api/carkedit/version", (_req: any, res: any) => {
      const pkgPath = path.join(__dirname, "../package.json");
      const pkg = JSON.parse(fs.readFileSync(pkgPath, "utf-8"));
      res.json({ version: pkg.version, startedAt: serverStartedAt });
    });

    app.get("/api/carkedit/rooms/lookup", async (_req: any, res: any) => {
      const code = ((_req.query.code as string) || "").toUpperCase().trim();
      if (!code || code.length < 3 || code.length > 5) {
        return res.status(400).json({ error: "Invalid room code" });
      }

      try {
        const rooms = await matchMaker.query({ name: "game" });
        const match = rooms.find((r: any) => r.metadata?.roomCode === code);
        if (!match) {
          return res.status(404).json({ error: "Room not found" });
        }
        res.json({ roomId: match.roomId, devMode: !!match.metadata?.devMode });
      } catch (err) {
        console.error("[CarkedIt API] Room lookup error:", err);
        res.status(500).json({ error: "Server error" });
      }
    });

    // Game history endpoints
    app.post("/api/carkedit/games", (req: any, res: any) => {
      try {
        const { mode, rounds, players, settings, finishedAt, startedAt, hostName, status, clientVersion, isDev } = req.body;
        if (!players || !Array.isArray(players) || players.length === 0) {
          return res.status(400).json({ error: "players array is required" });
        }
        if (!rounds || rounds < 1) {
          return res.status(400).json({ error: "rounds must be >= 1" });
        }

        const pkgPath = path.join(__dirname, "../package.json");
        const pkg = JSON.parse(fs.readFileSync(pkgPath, "utf-8"));

        const sorted = [...players].sort((a: any, b: any) => b.score - a.score);
        const result: GameResult = {
          id: randomUUID(),
          started_at: startedAt,
          finished_at: finishedAt || new Date().toISOString(),
          mode: mode || "local",
          host_name: hostName,
          rounds,
          player_count: players.length,
          winner_name: sorted[0].name,
          winner_score: sorted[0].score,
          status: status || "finished",
          live_status: "completed",
          has_error: false,
          is_dev: isDev || false,
          api_version: pkg.version,
          client_version: clientVersion,
          settings_json: settings ? JSON.stringify(settings) : undefined,
          players: sorted.map((p: any, i: number) => ({
            player_name: p.name,
            score: p.score,
            rank: i + 1,
          })),
        };

        const id = saveGameResult(result);
        res.json({ id, status: "saved" });
      } catch (err) {
        console.error("[CarkedIt API] Save game error:", err);
        res.status(500).json({ error: "Failed to save game" });
      }
    });

    app.get("/api/carkedit/games/stats", requireAdmin(), (_req: any, res: any) => {
      try {
        const since = _req.query.since as string | undefined;
        res.json(since ? getStatsByPeriod(since) : getStats());
      } catch (err) {
        console.error("[CarkedIt API] Get stats error:", err);
        res.status(500).json({ error: "Failed to retrieve stats" });
      }
    });

    app.get("/api/carkedit/games/stats/live", requireAdmin(), async (_req: any, res: any) => {
      try {
        const rooms = await matchMaker.query({ name: "game" });
        const activeRooms = rooms.filter((r: any) => r.clients > 0);
        const activeGames = activeRooms.length;
        const activePlayers = activeRooms.reduce((sum: number, r: any) => sum + (r.clients || 0), 0);
        res.json({ activeGames, activePlayers });
      } catch (err) {
        console.error("[CarkedIt API] Get live stats error:", err);
        res.status(500).json({ error: "Failed to retrieve live stats" });
      }
    });

    app.get("/api/carkedit/cards/stats", requireAdmin(), (_req: any, res: any) => {
      try {
        const devFilter = (['all', 'dev', 'nodev'].includes(_req.query.dev) ? _req.query.dev : 'all') as 'all' | 'dev' | 'nodev';
        res.json(getCardStats(devFilter));
      } catch (err) {
        console.error("[CarkedIt API] Get card stats error:", err);
        res.status(500).json({ error: "Failed to retrieve card stats" });
      }
    });

    app.get("/api/carkedit/games", requireAdmin(), (_req: any, res: any) => {
      try {
        const result = getRecentGames({
          limit: Math.min(parseInt(_req.query.limit as string) || 20, 100),
          offset: parseInt(_req.query.offset as string) || 0,
          dateFrom: _req.query.dateFrom as string || undefined,
          dateTo: _req.query.dateTo as string || undefined,
          errorsOnly: _req.query.errorsOnly === 'true',
          devFilter: (['all', 'dev', 'nodev'].includes(_req.query.dev) ? _req.query.dev : 'all') as any,
          statusFilter: (['all', 'finished', 'abandoned', 'live'].includes(_req.query.status) ? _req.query.status : 'all') as any,
        });
        res.json(result);
      } catch (err) {
        console.error("[CarkedIt API] Get games error:", err);
        res.status(500).json({ error: "Failed to retrieve games" });
      }
    });

    app.get("/api/carkedit/games/:id", requireAdmin(), (req: any, res: any) => {
      try {
        const game = getGameById(req.params.id);
        if (!game) return res.status(404).json({ error: "Game not found" });
        res.json(game);
      } catch (err) {
        console.error("[CarkedIt API] Get game error:", err);
        res.status(500).json({ error: "Failed to retrieve game" });
      }
    });

    app.get("/api/carkedit/games/:id/events", requireAdmin(), (req: any, res: any) => {
      try {
        const events = getGameEvents(req.params.id);
        res.json({ game_id: req.params.id, events, total: events.length });
      } catch (err) {
        console.error("[CarkedIt API] Get game events error:", err);
        res.status(500).json({ error: "Failed to retrieve game events" });
      }
    });

    // Issue reporting endpoints
    app.post("/api/carkedit/issues", (req: any, res: any) => {
      try {
        const { category, description, game_mode, screen, phase, room_code,
                player_count, players_json, game_state_json, device_info,
                error_log, client_version } = req.body;

        if (!category || typeof category !== 'string' || category.trim().length === 0) {
          return res.status(400).json({ error: "At least one category is required" });
        }

        const report: IssueReport = {
          id: randomUUID(),
          created_at: new Date().toISOString(),
          category: category.trim(),
          description: description || undefined,
          game_mode: game_mode || undefined,
          screen: screen || undefined,
          phase: phase || undefined,
          room_code: room_code || undefined,
          player_count: typeof player_count === 'number' ? player_count : undefined,
          players_json: players_json || undefined,
          game_state_json: game_state_json || undefined,
          device_info: device_info || undefined,
          error_log: error_log || undefined,
          client_version: client_version || undefined,
        };

        const id = saveIssueReport(report);
        res.json({ id, status: "saved" });
      } catch (err) {
        console.error("[CarkedIt API] Save issue report error:", err);
        res.status(500).json({ error: "Failed to save issue report" });
      }
    });

    app.get("/api/carkedit/issues", requireAdmin(), (_req: any, res: any) => {
      try {
        const limit = Math.min(parseInt(_req.query.limit as string) || 50, 200);
        const offset = parseInt(_req.query.offset as string) || 0;
        res.json(getIssueReports(limit, offset));
      } catch (err) {
        console.error("[CarkedIt API] Get issue reports error:", err);
        res.status(500).json({ error: "Failed to retrieve issue reports" });
      }
    });

    // --- User endpoints ---

    app.get("/api/carkedit/users/me", requireAuth(), (req: any, res: any) => {
      try {
        res.json(req.localUser);
      } catch (err) {
        console.error("[CarkedIt API] Get current user error:", err);
        res.status(500).json({ error: "Failed to retrieve current user" });
      }
    });

    // Bootstrap: promote caller to admin if no admins exist yet
    app.post("/api/carkedit/admin/bootstrap", requireAuth(), (req: any, res: any) => {
      try {
        if (hasAnyAdmin()) {
          return res.status(403).json({ error: "Admin already exists. Use the admin panel to manage users." });
        }
        const user = setAdminFlag(req.localUser!.id, true);
        res.json(user);
      } catch (err) {
        console.error("[CarkedIt API] Bootstrap admin error:", err);
        res.status(500).json({ error: "Failed to bootstrap admin" });
      }
    });

    // List all users (admin only)
    app.get("/api/carkedit/users", requireAdmin(), (_req: any, res: any) => {
      try {
        res.json({ users: listUsers() });
      } catch (err) {
        console.error("[CarkedIt API] List users error:", err);
        res.status(500).json({ error: "Failed to list users" });
      }
    });

    // Toggle admin flag (admin only)
    app.patch("/api/carkedit/users/:id/admin", requireAdmin(), (req: any, res: any) => {
      try {
        const { is_admin } = req.body;
        if (typeof is_admin !== 'boolean' && typeof is_admin !== 'number') {
          return res.status(400).json({ error: "is_admin (boolean) is required" });
        }
        const user = setAdminFlag(req.params.id, !!is_admin);
        if (!user) return res.status(404).json({ error: "User not found" });
        res.json(user);
      } catch (err) {
        console.error("[CarkedIt API] Set admin error:", err);
        res.status(500).json({ error: "Failed to update admin status" });
      }
    });

    app.post("/api/carkedit/users", (req: any, res: any) => {
      try {
        const { display_name, firebase_uid, email, avatar_url, birth_month, birth_day } = req.body;
        if (!display_name || typeof display_name !== 'string' || display_name.trim().length === 0) {
          return res.status(400).json({ error: "display_name is required" });
        }
        const user = createUser({ display_name: display_name.trim(), firebase_uid, email, avatar_url, birth_month, birth_day });
        res.status(201).json(user);
      } catch (err) {
        console.error("[CarkedIt API] Create user error:", err);
        res.status(500).json({ error: "Failed to create user" });
      }
    });

    app.get("/api/carkedit/users/:id", (req: any, res: any) => {
      try {
        const user = getUserById(req.params.id);
        if (!user) return res.status(404).json({ error: "User not found" });
        res.json(user);
      } catch (err) {
        console.error("[CarkedIt API] Get user error:", err);
        res.status(500).json({ error: "Failed to retrieve user" });
      }
    });

    app.patch("/api/carkedit/users/:id", requireAuth(), (req: any, res: any) => {
      try {
        const existing = getUserById(req.params.id);
        if (!existing) return res.status(404).json({ error: "User not found" });
        if (existing.firebase_uid !== req.firebaseUser!.uid) {
          return res.status(403).json({ error: "Cannot update another user's profile" });
        }
        const { display_name, birth_month, birth_day } = req.body;
        const user = updateUserProfile(req.params.id, { display_name, birth_month, birth_day });
        res.json(user);
      } catch (err) {
        console.error("[CarkedIt API] Update user error:", err);
        res.status(500).json({ error: "Failed to update user" });
      }
    });

    // Link anonymous user to Firebase account (requires auth)
    app.post("/api/carkedit/users/link", requireAuth(), (req: any, res: any) => {
      try {
        const { anonymous_user_id } = req.body;
        if (!anonymous_user_id || typeof anonymous_user_id !== 'string') {
          return res.status(400).json({ error: "anonymous_user_id is required" });
        }
        const user = linkAnonymousUserToFirebase(anonymous_user_id, req.firebaseUser!.uid);
        if (!user) return res.status(404).json({ error: "Anonymous user not found" });
        res.json(user);
      } catch (err) {
        console.error("[CarkedIt API] Link user error:", err);
        res.status(500).json({ error: "Failed to link user" });
      }
    });

    // --- Expansion Pack endpoints ---

    app.post("/api/carkedit/packs", (req: any, res: any) => {
      try {
        const { creator_id, title, description } = req.body;
        if (!creator_id || typeof creator_id !== 'string') {
          return res.status(400).json({ error: "creator_id is required" });
        }
        if (!title || typeof title !== 'string' || title.trim().length === 0) {
          return res.status(400).json({ error: "title is required" });
        }
        const pack = createPack({ creator_id, title: title.trim(), description });
        res.status(201).json(pack);
      } catch (err) {
        console.error("[CarkedIt API] Create pack error:", err);
        res.status(500).json({ error: "Failed to create pack" });
      }
    });

    app.get("/api/carkedit/packs", (_req: any, res: any) => {
      try {
        const officialParam = _req.query.is_official as string | undefined;
        const result = listPacks({
          creator_id: _req.query.creator_id as string || undefined,
          visibility: _req.query.visibility as string || undefined,
          status: _req.query.status as string || undefined,
          is_official: officialParam === undefined ? undefined : officialParam === 'true' || officialParam === '1',
          viewer_id: _req.localUser?.id,
          limit: Math.min(parseInt(_req.query.limit as string) || 50, 100),
          offset: parseInt(_req.query.offset as string) || 0,
        });
        res.json(result);
      } catch (err) {
        console.error("[CarkedIt API] List packs error:", err);
        res.status(500).json({ error: "Failed to retrieve packs" });
      }
    });

    // Must be registered BEFORE /packs/:id so the literal path wins.
    app.get("/api/carkedit/packs/favorites", requireAuth(), (req: any, res: any) => {
      try {
        const packs = listUserFavorites(req.localUser.id);
        res.json({ packs, total: packs.length });
      } catch (err) {
        console.error("[CarkedIt API] List favorite packs error:", err);
        res.status(500).json({ error: "Failed to retrieve favorite packs" });
      }
    });

    app.post("/api/carkedit/packs/:id/favorite", requireAuth(), (req: any, res: any) => {
      try {
        addFavorite(req.localUser.id, req.params.id);
        res.status(204).end();
      } catch (err) {
        console.error("[CarkedIt API] Favorite pack error:", err);
        res.status(500).json({ error: "Failed to favorite pack" });
      }
    });

    app.delete("/api/carkedit/packs/:id/favorite", requireAuth(), (req: any, res: any) => {
      try {
        removeFavorite(req.localUser.id, req.params.id);
        res.status(204).end();
      } catch (err) {
        console.error("[CarkedIt API] Unfavorite pack error:", err);
        res.status(500).json({ error: "Failed to unfavorite pack" });
      }
    });

    app.patch("/api/carkedit/packs/:id/official", requireAdmin(), (req: any, res: any) => {
      try {
        const { is_official } = req.body;
        if (typeof is_official !== 'boolean') {
          return res.status(400).json({ error: "is_official (boolean) is required" });
        }
        const pack = setPackOfficial(req.params.id, is_official);
        if (!pack) return res.status(404).json({ error: "Pack not found" });
        res.json(pack);
      } catch (err) {
        console.error("[CarkedIt API] Set pack official error:", err);
        res.status(500).json({ error: "Failed to set pack official" });
      }
    });

    app.get("/api/carkedit/packs/:id", (req: any, res: any) => {
      try {
        const pack = getPackById(req.params.id, req.localUser?.id);
        if (!pack) return res.status(404).json({ error: "Pack not found" });
        res.json(pack);
      } catch (err) {
        console.error("[CarkedIt API] Get pack error:", err);
        res.status(500).json({ error: "Failed to retrieve pack" });
      }
    });

    app.put("/api/carkedit/packs/:id", (req: any, res: any) => {
      try {
        const pack = updatePack(req.params.id, req.body);
        if (!pack) return res.status(404).json({ error: "Pack not found" });
        res.json(pack);
      } catch (err: any) {
        if (err.message?.includes('no cards') || err.message?.includes('featured_card_id')) {
          return res.status(400).json({ error: err.message });
        }
        console.error("[CarkedIt API] Update pack error:", err);
        res.status(500).json({ error: "Failed to update pack" });
      }
    });

    app.delete("/api/carkedit/packs/:id", (req: any, res: any) => {
      try {
        const deleted = deletePack(req.params.id);
        if (!deleted) return res.status(404).json({ error: "Pack not found" });
        res.status(204).end();
      } catch (err) {
        console.error("[CarkedIt API] Delete pack error:", err);
        res.status(500).json({ error: "Failed to delete pack" });
      }
    });

    // --- Expansion Card endpoints ---

    app.post("/api/carkedit/packs/:id/cards", (req: any, res: any) => {
      try {
        const { cards } = req.body;
        if (!cards || !Array.isArray(cards) || cards.length === 0) {
          return res.status(400).json({ error: "cards array is required" });
        }
        const validDeckTypes = ['die', 'live', 'bye'];
        for (const card of cards) {
          if (!card.deck_type || !validDeckTypes.includes(card.deck_type)) {
            return res.status(400).json({ error: `Invalid deck_type: ${card.deck_type}. Must be one of: ${validDeckTypes.join(', ')}` });
          }
          if (!card.text || typeof card.text !== 'string' || card.text.trim().length === 0) {
            return res.status(400).json({ error: "Each card must have non-empty text" });
          }
        }
        const created = addCards(req.params.id, cards.map((c: any) => ({ deck_type: c.deck_type, text: c.text.trim() })));
        res.status(201).json({ cards: created });
      } catch (err: any) {
        if (err.message === 'Pack not found') {
          return res.status(404).json({ error: "Pack not found" });
        }
        console.error("[CarkedIt API] Add cards error:", err);
        res.status(500).json({ error: "Failed to add cards" });
      }
    });

    app.put("/api/carkedit/packs/:id/cards/:cardId", (req: any, res: any) => {
      try {
        const card = updateCard(req.params.id, req.params.cardId, req.body);
        if (!card) return res.status(404).json({ error: "Card not found" });
        res.json(card);
      } catch (err) {
        console.error("[CarkedIt API] Update card error:", err);
        res.status(500).json({ error: "Failed to update card" });
      }
    });

    app.delete("/api/carkedit/packs/:id/cards/:cardId", (req: any, res: any) => {
      try {
        const deleted = deleteCard(req.params.id, req.params.cardId);
        if (!deleted) return res.status(404).json({ error: "Card not found" });
        res.status(204).end();
      } catch (err) {
        console.error("[CarkedIt API] Delete card error:", err);
        res.status(500).json({ error: "Failed to delete card" });
      }
    });
  },
});

initDatabase();
console.log("[CarkedIt API] Database initialized");

server.listen(port);
console.log(`[CarkedIt API] Listening on port ${port}`);
console.log(`[CarkedIt API] Health check: http://localhost:${port}/api/carkedit/health`);
console.log(`[CarkedIt API] Serving client from: ${clientDir}`);
