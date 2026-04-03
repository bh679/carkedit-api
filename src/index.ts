import path from "path";
import fs from "fs";
import { fileURLToPath } from "url";
import express from "express";
import { defineServer, defineRoom, matchMaker } from "colyseus";
import { GameRoom } from "./rooms/GameRoom.js";
import { initDatabase, saveGameResult, createLiveGame, updateLiveGame, completeLiveGame, abandonGame, getRecentGames, getGameById, getStats, getStatsByPeriod, getCardStats, getGameEvents, saveIssueReport, getIssueReports } from "./db/database.js";
import type { GameResult, IssueReport } from "./db/types.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const port = parseInt(process.env.PORT || "4500", 10);
const clientDir = process.env.CLIENT_DIR || path.join(__dirname, "../../carkedit-client");

const serverStartedAt = new Date().toISOString();

const server = defineServer({
  rooms: {
    game: defineRoom(GameRoom),
  },
  express: (app) => {
    app.use(express.json());
    app.use(express.static(clientDir));

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
        res.json({ roomId: match.roomId });
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
          id: crypto.randomUUID(),
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

    app.get("/api/carkedit/games/stats", (_req: any, res: any) => {
      try {
        const since = _req.query.since as string | undefined;
        res.json(since ? getStatsByPeriod(since) : getStats());
      } catch (err) {
        console.error("[CarkedIt API] Get stats error:", err);
        res.status(500).json({ error: "Failed to retrieve stats" });
      }
    });

    app.get("/api/carkedit/games/stats/live", async (_req: any, res: any) => {
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

    app.get("/api/carkedit/cards/stats", (_req: any, res: any) => {
      try {
        res.json(getCardStats());
      } catch (err) {
        console.error("[CarkedIt API] Get card stats error:", err);
        res.status(500).json({ error: "Failed to retrieve card stats" });
      }
    });

    app.get("/api/carkedit/games", (_req: any, res: any) => {
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

    app.get("/api/carkedit/games/:id", (req: any, res: any) => {
      try {
        const game = getGameById(req.params.id);
        if (!game) return res.status(404).json({ error: "Game not found" });
        res.json(game);
      } catch (err) {
        console.error("[CarkedIt API] Get game error:", err);
        res.status(500).json({ error: "Failed to retrieve game" });
      }
    });

    app.get("/api/carkedit/games/:id/events", (req: any, res: any) => {
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
          id: crypto.randomUUID(),
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

    app.get("/api/carkedit/issues", (_req: any, res: any) => {
      try {
        const limit = Math.min(parseInt(_req.query.limit as string) || 50, 200);
        const offset = parseInt(_req.query.offset as string) || 0;
        res.json(getIssueReports(limit, offset));
      } catch (err) {
        console.error("[CarkedIt API] Get issue reports error:", err);
        res.status(500).json({ error: "Failed to retrieve issue reports" });
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
