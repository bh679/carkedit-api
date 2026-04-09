import { randomUUID } from "node:crypto";
import path from "path";
import fs from "fs";
import { fileURLToPath } from "url";
import express from "express";
import multer from "multer";
import { defineServer, defineRoom, matchMaker } from "colyseus";
import { GameRoom } from "./rooms/GameRoom.js";
import { initDatabase, saveGameResult, createLiveGame, updateLiveGame, completeLiveGame, abandonGame, getRecentGames, getGameById, getStats, getStatsByPeriod, getCardStats, getGameEvents, saveIssueReport, getIssueReports, saveSurveyResponse, getSurveyStats, getSurveyResponses, setGameDev, setSurveyDev } from "./db/database.js";
import { createUser, getUserById, updateUserProfile, linkAnonymousUserToFirebase, listUsers, hasAnyAdmin, setAdminFlag } from "./db/users.js";
import { createPack, getPackById, listPacks, updatePack, deletePack, addCards, updateCard, deleteCard, addFavorite, removeFavorite, listUserFavorites, setPackOfficial, setPackDev, getPackStats, listPackStatsAll } from "./db/packs.js";
import { optionalAuth, requireAuth, requireAdmin, setFirebaseAvailable } from "./middleware/auth.js";
import type { GameResult, IssueReport } from "./db/types.js";
import { listProviders, getProvider, buildPrompt } from "./services/image-gen/index.js";

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

    // Serve uploaded brand images and card illustrations
    const uploadsDir = path.join(__dirname, '../uploads');
    const brandsDir = path.join(uploadsDir, 'brands');
    const cardImagesDir = path.join(uploadsDir, 'card-images');
    fs.mkdirSync(brandsDir, { recursive: true });
    fs.mkdirSync(cardImagesDir, { recursive: true });
    app.use('/uploads', express.static(uploadsDir));

    // PNG / WebP / SVG — all support transparency. JPEG excluded.
    const ALLOWED_BRAND_MIME = new Set(['image/png', 'image/webp', 'image/svg+xml']);
    const brandUpload = multer({
      storage: multer.diskStorage({
        destination: brandsDir,
        filename: (req, file, cb) => {
          const ext = path.extname(file.originalname || '').toLowerCase() || '.png';
          cb(null, `pack-${req.params.id}-${Date.now()}${ext}`);
        },
      }),
      limits: { fileSize: 2 * 1024 * 1024 }, // 2MB
      fileFilter: (_req, file, cb) => {
        if (!ALLOWED_BRAND_MIME.has(file.mimetype)) {
          return cb(new Error('Only PNG, JPEG, or WebP images are allowed'));
        }
        cb(null, true);
      },
    });

    // Apply optional auth to pack, user, and image-gen routes
    app.use('/api/carkedit/packs', optionalAuth());
    app.use('/api/carkedit/users', optionalAuth());
    app.use('/api/carkedit/image-gen', optionalAuth());

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

    app.patch("/api/carkedit/games/:id/dev", requireAdmin(), (req: any, res: any) => {
      try {
        const { is_dev } = req.body;
        if (typeof is_dev !== 'boolean') {
          return res.status(400).json({ error: "is_dev (boolean) is required" });
        }
        const game = setGameDev(req.params.id, is_dev);
        if (!game) return res.status(404).json({ error: "Game not found" });
        res.json(game);
      } catch (err) {
        console.error("[CarkedIt API] Set game dev error:", err);
        res.status(500).json({ error: "Failed to set game dev" });
      }
    });

    app.patch("/api/carkedit/surveys/:id/dev", requireAdmin(), (req: any, res: any) => {
      try {
        const { is_dev } = req.body;
        if (typeof is_dev !== 'boolean') {
          return res.status(400).json({ error: "is_dev (boolean) is required" });
        }
        const survey = setSurveyDev(req.params.id, is_dev);
        if (!survey) return res.status(404).json({ error: "Survey not found" });
        res.json(survey);
      } catch (err) {
        console.error("[CarkedIt API] Set survey dev error:", err);
        res.status(500).json({ error: "Failed to set survey dev" });
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

    // --- Survey endpoints ---

    app.post("/api/carkedit/surveys", (req: any, res: any) => {
      try {
        const { game_id, player_name, session_id, nps_score, comment, improvement, client_version, is_dev } = req.body;

        if (typeof nps_score !== 'number' || !Number.isInteger(nps_score) || nps_score < 0 || nps_score > 10) {
          return res.status(400).json({ error: "nps_score must be an integer between 0 and 10" });
        }

        const saved = saveSurveyResponse({
          id: randomUUID(),
          created_at: new Date().toISOString(),
          game_id: game_id || undefined,
          player_name: player_name || undefined,
          session_id: session_id || undefined,
          nps_score,
          comment: comment || undefined,
          improvement: improvement || undefined,
          client_version: client_version || undefined,
          is_dev: !!is_dev,
        });

        if (!saved) {
          return res.status(409).json({ error: "Survey already submitted for this game" });
        }
        res.json({ status: "saved" });
      } catch (err) {
        console.error("[CarkedIt API] Save survey error:", err);
        res.status(500).json({ error: "Failed to save survey response" });
      }
    });

    app.get("/api/carkedit/surveys/stats", requireAdmin(), (req: any, res: any) => {
      try {
        const devFilter = (req.query.dev as string) === 'dev' || (req.query.dev as string) === 'nodev' ? req.query.dev : 'all';
        res.json(getSurveyStats(devFilter as any));
      } catch (err) {
        console.error("[CarkedIt API] Get survey stats error:", err);
        res.status(500).json({ error: "Failed to retrieve survey stats" });
      }
    });

    app.get("/api/carkedit/surveys", requireAdmin(), (req: any, res: any) => {
      try {
        const limit = Math.min(parseInt(req.query.limit as string) || 50, 200);
        const offset = parseInt(req.query.offset as string) || 0;
        const devFilter = (req.query.dev as string) === 'dev' || (req.query.dev as string) === 'nodev' ? req.query.dev : 'all';
        res.json(getSurveyResponses(limit, offset, devFilter as any));
      } catch (err) {
        console.error("[CarkedIt API] Get surveys error:", err);
        res.status(500).json({ error: "Failed to retrieve survey responses" });
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
        const devParam = _req.query.is_dev as string | undefined;
        const sortParam = (_req.query.sort as string) || 'newest';
        const sort = (['newest', 'most_used', 'most_saved'].includes(sortParam) ? sortParam : 'newest') as 'newest' | 'most_used' | 'most_saved';
        const isAdmin = !!_req.localUser?.is_admin;
        const requestedDev = devParam === undefined ? undefined : devParam === 'true' || devParam === '1';
        // Non-admin viewers never see dev decks in search results.
        const effectiveDev = isAdmin ? requestedDev : false;
        const result = listPacks({
          creator_id: _req.query.creator_id as string || undefined,
          status: _req.query.status as string || undefined,
          is_official: officialParam === undefined ? undefined : officialParam === 'true' || officialParam === '1',
          is_dev: effectiveDev,
          search: (_req.query.search as string) || undefined,
          sort,
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

    app.patch("/api/carkedit/packs/:id/dev", requireAdmin(), (req: any, res: any) => {
      try {
        const { is_dev } = req.body;
        if (typeof is_dev !== 'boolean') {
          return res.status(400).json({ error: "is_dev (boolean) is required" });
        }
        const pack = setPackDev(req.params.id, is_dev);
        if (!pack) return res.status(404).json({ error: "Pack not found" });
        res.json(pack);
      } catch (err) {
        console.error("[CarkedIt API] Set pack dev error:", err);
        res.status(500).json({ error: "Failed to set pack dev" });
      }
    });

    // Must be registered BEFORE /packs/:id so the literal path wins.
    app.get("/api/carkedit/packs/stats", requireAdmin(), (_req: any, res: any) => {
      try {
        const packs = listPackStatsAll();
        res.json({ packs });
      } catch (err) {
        console.error("[CarkedIt API] Pack stats list error:", err);
        res.status(500).json({ error: "Failed to retrieve pack stats list" });
      }
    });

    // Must be registered BEFORE /packs/:id so the literal path wins.
    app.get("/api/carkedit/packs/:id/stats", (req: any, res: any) => {
      try {
        const stats = getPackStats(req.params.id);
        if (!stats) return res.status(404).json({ error: "Pack not found" });
        res.json(stats);
      } catch (err) {
        console.error("[CarkedIt API] Pack stats error:", err);
        res.status(500).json({ error: "Failed to retrieve pack stats" });
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
        // brand_image_url can only be cleared via PUT; uploads go through POST /brand.
        if (req.body && 'brand_image_url' in req.body && req.body.brand_image_url !== null) {
          return res.status(400).json({ error: "brand_image_url can only be set via POST /packs/:id/brand" });
        }
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

    app.post("/api/carkedit/packs/:id/brand", brandUpload.single('image'), (req: any, res: any) => {
      try {
        if (!req.file) {
          return res.status(400).json({ error: "image file is required" });
        }
        const existing = getPackById(req.params.id);
        if (!existing) {
          fs.unlink(req.file.path, () => {});
          return res.status(404).json({ error: "Pack not found" });
        }
        // Delete previous brand file if present and is a local upload
        const prev = existing.brand_image_url;
        if (prev && prev.startsWith('/uploads/brands/')) {
          const prevPath = path.join(uploadsDir, prev.replace(/^\/uploads\//, ''));
          fs.unlink(prevPath, () => {});
        }
        const relUrl = `/uploads/brands/${req.file.filename}`;
        const pack = updatePack(req.params.id, { brand_image_url: relUrl });
        res.json(pack);
      } catch (err: any) {
        console.error("[CarkedIt API] Upload brand image error:", err);
        res.status(500).json({ error: "Failed to upload brand image" });
      }
    }, (err: any, _req: any, res: any, _next: any) => {
      // Multer error handler (fires for size limits and fileFilter rejects)
      res.status(400).json({ error: err?.message || "Invalid upload" });
    });

    app.delete("/api/carkedit/packs/:id/brand", (req: any, res: any) => {
      try {
        const existing = getPackById(req.params.id);
        if (!existing) return res.status(404).json({ error: "Pack not found" });
        const prev = existing.brand_image_url;
        if (prev && prev.startsWith('/uploads/brands/')) {
          const prevPath = path.join(uploadsDir, prev.replace(/^\/uploads\//, ''));
          fs.unlink(prevPath, () => {});
        }
        const pack = updatePack(req.params.id, { brand_image_url: null });
        res.json(pack);
      } catch (err) {
        console.error("[CarkedIt API] Delete brand image error:", err);
        res.status(500).json({ error: "Failed to remove brand image" });
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

    /**
     * Validate a custom-die-card variant. Returns an error message string or
     * null when the input is valid.
     * - card_special is optional, but when present must be "?" or "Split"
     * - Variants only allowed on die deck
     * - Split MUST include `options` as an array of exactly 2 non-empty strings
     */
    function validateCardVariant(deckType: string, cardSpecial: any, options: any): string | null {
      if (cardSpecial === undefined || cardSpecial === null || cardSpecial === '') {
        if (options !== undefined && options !== null) {
          return "options can only be set on die-deck Split cards";
        }
        return null;
      }
      if (cardSpecial !== '?' && cardSpecial !== 'Split') {
        return `card_special must be "?" or "Split", got: ${cardSpecial}`;
      }
      if (deckType !== 'die') {
        return "card_special is only allowed on die-deck cards";
      }
      if (cardSpecial === 'Split') {
        if (!Array.isArray(options) || options.length !== 2) {
          return "Split cards require an options array of exactly 2 strings";
        }
        for (const o of options) {
          if (typeof o !== 'string' || o.trim().length === 0) {
            return "Split options must be non-empty strings";
          }
          if (o.length > 100) {
            return "Split options max length is 100 characters";
          }
        }
      } else {
        if (options !== undefined && options !== null) {
          return "Mystery (?) cards must not have an options array";
        }
      }
      return null;
    }

    function normalizeCardSpecial(value: any): string | null {
      if (value === '?' || value === 'Split') return value;
      return null;
    }


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
          if (card.prompt !== undefined && card.prompt !== null && typeof card.prompt !== 'string') {
            return res.status(400).json({ error: "card.prompt must be a string or null" });
          }
          const variantErr = validateCardVariant(card.deck_type, card.card_special, card.options);
          if (variantErr) return res.status(400).json({ error: variantErr });
        }
        const created = addCards(req.params.id, cards.map((c: any) => ({
          deck_type: c.deck_type,
          text: c.text.trim(),
          prompt: typeof c.prompt === 'string' ? (c.prompt.trim() || null) : null,
          card_special: normalizeCardSpecial(c.card_special),
          options_json: c.card_special === 'Split' && Array.isArray(c.options)
            ? JSON.stringify(c.options.map((o: string) => o.trim()))
            : null,
        })));
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
        const body = req.body || {};
        if (body.prompt !== undefined && body.prompt !== null && typeof body.prompt !== 'string') {
          return res.status(400).json({ error: "prompt must be a string or null" });
        }
        // Variant validation: only check if any of the variant fields are being touched.
        if (body.card_special !== undefined || body.options !== undefined) {
          // We need the effective deck_type for validation. Use the one from the body
          // if provided, otherwise treat as 'die' (the only deck that allows variants).
          const effectiveDeck = body.deck_type ?? 'die';
          const variantErr = validateCardVariant(effectiveDeck, body.card_special, body.options);
          if (variantErr) return res.status(400).json({ error: variantErr });
        }
        const updates: any = {};
        if (body.text !== undefined) updates.text = body.text;
        if (body.deck_type !== undefined) updates.deck_type = body.deck_type;
        if (body.sort_order !== undefined) updates.sort_order = body.sort_order;
        if (body.prompt !== undefined) {
          updates.prompt = typeof body.prompt === 'string' ? (body.prompt.trim() || null) : null;
        }
        if (body.card_special !== undefined) {
          updates.card_special = normalizeCardSpecial(body.card_special);
        }
        if (body.options !== undefined) {
          updates.options_json = body.card_special === 'Split' && Array.isArray(body.options)
            ? JSON.stringify(body.options.map((o: string) => String(o).trim()))
            : null;
        }
        const card = updateCard(req.params.id, req.params.cardId, updates);
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

    // --- Image generation (test admin page) ---
    //
    // All routes are admin-only. These back the admin-image-gen.html page that
    // the art team uses to test AI image generators against a structured
    // style JSON. See carkedit-online/js/admin-image-gen/ for the client.

    app.get("/api/carkedit/image-gen/providers", requireAdmin(), (_req: any, res: any) => {
      try {
        res.json({ providers: listProviders() });
      } catch (err) {
        console.error("[CarkedIt API] List providers error:", err);
        res.status(500).json({ error: "Failed to list providers" });
      }
    });

    /**
     * POST /api/carkedit/image-gen/style
     *
     * Persist the admin page's style editor contents back to the shipped
     * default file at `<CLIENT_DIR>/js/data/image-gen-style.json`. The
     * file path is hardcoded relative to `clientDir`, so no part of the
     * request body influences where the write lands — safe from
     * directory traversal. The client sends `{ style: <object> }`; the
     * server validates it's a non-array plain object and pretty-prints
     * with 2-space indent + trailing newline (matching how we author
     * the file by hand).
     */
    app.post("/api/carkedit/image-gen/style", requireAdmin(), (req: any, res: any) => {
      try {
        const { style } = req.body || {};
        if (!style || typeof style !== 'object' || Array.isArray(style)) {
          return res.status(400).json({ error: "style must be a plain object" });
        }
        const STYLE_REL_PATH = 'js/data/image-gen-style.json';
        const stylePath = path.join(clientDir, STYLE_REL_PATH);
        // Guard against clientDir misconfig pointing somewhere weird.
        const resolved = path.resolve(stylePath);
        const clientResolved = path.resolve(clientDir);
        if (!resolved.startsWith(clientResolved + path.sep)) {
          return res.status(500).json({ error: "Refusing to write outside CLIENT_DIR" });
        }
        const jsonText = JSON.stringify(style, null, 2) + '\n';
        fs.mkdirSync(path.dirname(resolved), { recursive: true });
        fs.writeFileSync(resolved, jsonText, 'utf8');
        res.json({ ok: true, bytes: Buffer.byteLength(jsonText, 'utf8'), path: '/' + STYLE_REL_PATH });
      } catch (err: any) {
        console.error("[CarkedIt API] Save style error:", err);
        res.status(500).json({ error: err?.message || "Failed to save style JSON" });
      }
    });

    app.post("/api/carkedit/image-gen/generate", requireAdmin(), async (req: any, res: any) => {
      try {
        const { providerId, cardText, cardPrompt, deckType, style, promptOverride, options } = req.body || {};

        if (!providerId || typeof providerId !== 'string') {
          return res.status(400).json({ error: "providerId is required" });
        }
        const provider = getProvider(providerId);
        if (!provider) {
          return res.status(400).json({ error: `Unknown provider: ${providerId}` });
        }
        if (!provider.isConfigured()) {
          return res.status(503).json({
            error: `Provider ${providerId} is not configured (missing API key)`,
          });
        }

        const overrideIsSet = typeof promptOverride === 'string' && promptOverride.trim().length > 0;
        const prompt = overrideIsSet
          ? promptOverride.trim()
          : buildPrompt({
              cardText: typeof cardText === 'string' ? cardText : '',
              cardPrompt: typeof cardPrompt === 'string' ? cardPrompt : null,
              deckType: typeof deckType === 'string' ? deckType : null,
              style: (style && typeof style === 'object') ? style : null,
            });

        if (!prompt || prompt.trim().length === 0) {
          return res.status(400).json({ error: "Resolved prompt is empty — provide cardText or promptOverride" });
        }

        const result = await provider.generate({
          prompt,
          style: (style && typeof style === 'object') ? style : undefined,
          options: (options && typeof options === 'object') ? options : undefined,
        });
        res.json(result);
      } catch (err: any) {
        console.error("[CarkedIt API] image-gen generate error:", err);
        res.status(502).json({ error: err?.message || "Image generation failed" });
      }
    });

    /**
     * Download a remote image (typically a provider-hosted URL returned by
     * /api/carkedit/image-gen/generate) into uploads/card-images/ and persist
     * it to the target card's image_url column.
     *
     * Why this isn't a multipart upload: provider URLs are one-shot signed
     * URLs that expire quickly — round-tripping them through the browser as
     * a file upload would be slower and more brittle than letting the server
     * fetch them directly.
     */
    app.post(
      "/api/carkedit/packs/:id/cards/:cardId/image-from-url",
      requireAdmin(),
      async (req: any, res: any) => {
        try {
          const { imageUrl } = req.body || {};
          if (!imageUrl || typeof imageUrl !== 'string') {
            return res.status(400).json({ error: "imageUrl is required" });
          }
          // Guard against non-http(s) schemes (file://, data:, javascript:, etc).
          let parsed: URL;
          try {
            parsed = new URL(imageUrl);
          } catch {
            return res.status(400).json({ error: "imageUrl is not a valid URL" });
          }
          if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
            return res.status(400).json({ error: "imageUrl must use http(s)" });
          }

          const pack = getPackById(req.params.id);
          if (!pack) return res.status(404).json({ error: "Pack not found" });

          const fetchRes = await fetch(imageUrl);
          if (!fetchRes.ok) {
            return res.status(502).json({
              error: `Failed to download image (${fetchRes.status})`,
            });
          }
          const contentType = (fetchRes.headers.get('content-type') || '').toLowerCase();
          const extMap: Record<string, string> = {
            'image/png': '.png',
            'image/webp': '.webp',
            'image/jpeg': '.jpg',
            'image/jpg': '.jpg',
            'image/gif': '.gif',
            'image/svg+xml': '.svg',
          };
          let ext = extMap[contentType] || '';
          if (!ext) {
            const pathExt = path.extname(parsed.pathname).toLowerCase();
            if (['.png', '.webp', '.jpg', '.jpeg', '.gif', '.svg'].includes(pathExt)) {
              ext = pathExt === '.jpeg' ? '.jpg' : pathExt;
            }
          }
          if (!ext) ext = '.png';

          const buffer = Buffer.from(await fetchRes.arrayBuffer());
          // 10 MB ceiling — generous for 1024x1024 PNGs but keeps the
          // abuse surface narrow.
          const MAX_BYTES = 10 * 1024 * 1024;
          if (buffer.length > MAX_BYTES) {
            return res.status(413).json({ error: "Image too large (>10MB)" });
          }

          const filename = `card-${req.params.id}-${req.params.cardId}-${Date.now()}${ext}`;
          const filepath = path.join(cardImagesDir, filename);
          fs.writeFileSync(filepath, buffer);

          // Best-effort cleanup of the previous image for this card.
          const relUrl = `/uploads/card-images/${filename}`;
          const updated = updateCard(req.params.id, req.params.cardId, {
            image_url: relUrl,
          });
          if (!updated) {
            // Card vanished between auth and write — roll back the file.
            fs.unlink(filepath, () => {});
            return res.status(404).json({ error: "Card not found" });
          }
          res.json(updated);
        } catch (err: any) {
          console.error("[CarkedIt API] image-from-url error:", err);
          res.status(500).json({ error: err?.message || "Failed to save image" });
        }
      }
    );
  },
});

initDatabase();
console.log("[CarkedIt API] Database initialized");

server.listen(port);
console.log(`[CarkedIt API] Listening on port ${port}`);
console.log(`[CarkedIt API] Health check: http://localhost:${port}/api/carkedit/health`);
console.log(`[CarkedIt API] Serving client from: ${clientDir}`);
