import path from "path";
import fs from "fs";
import { fileURLToPath } from "url";
import express from "express";
import { defineServer, defineRoom, matchMaker } from "colyseus";
import { GameRoom } from "./rooms/GameRoom.js";
import { initDatabase, saveGameResult, getRecentGames, getGameById } from "./db/database.js";
import type { GameResult } from "./db/types.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const port = parseInt(process.env.PORT || "4500", 10);
const clientDir = process.env.CLIENT_DIR || path.join(__dirname, "../../carkedit-client");

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
      res.json({ version: pkg.version });
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
        const { mode, rounds, players, settings, finishedAt } = req.body;
        if (!players || !Array.isArray(players) || players.length === 0) {
          return res.status(400).json({ error: "players array is required" });
        }
        if (!rounds || rounds < 1) {
          return res.status(400).json({ error: "rounds must be >= 1" });
        }

        const sorted = [...players].sort((a: any, b: any) => b.score - a.score);
        const result: GameResult = {
          id: crypto.randomUUID(),
          finished_at: finishedAt || new Date().toISOString(),
          mode: mode || "local",
          rounds,
          player_count: players.length,
          winner_name: sorted[0].name,
          winner_score: sorted[0].score,
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

    app.get("/api/carkedit/games", (_req: any, res: any) => {
      try {
        const limit = Math.min(parseInt(_req.query.limit as string) || 20, 100);
        const offset = parseInt(_req.query.offset as string) || 0;
        const result = getRecentGames(limit, offset);
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
  },
});

initDatabase();
console.log("[CarkedIt API] Database initialized");

server.listen(port);
console.log(`[CarkedIt API] Listening on port ${port}`);
console.log(`[CarkedIt API] Health check: http://localhost:${port}/api/carkedit/health`);
console.log(`[CarkedIt API] Serving client from: ${clientDir}`);
