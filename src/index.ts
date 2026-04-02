import path from "path";
import express from "express";
import { defineServer, defineRoom, matchMaker } from "colyseus";
import { GameRoom } from "./rooms/GameRoom";

const port = parseInt(process.env.PORT || "4500", 10);
const clientDir = process.env.CLIENT_DIR || path.join(__dirname, "../../carkedit-client");

const server = defineServer({
  rooms: {
    game: defineRoom(GameRoom),
  },
  express: (app) => {
    app.use(express.static(clientDir));

    app.get("/api/carkedit/health", (_req: any, res: any) => {
      res.json({ status: "ok", timestamp: new Date().toISOString() });
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
  },
});

server.listen(port);
console.log(`[CarkedIt API] Listening on port ${port}`);
console.log(`[CarkedIt API] Health check: http://localhost:${port}/api/carkedit/health`);
console.log(`[CarkedIt API] Serving client from: ${clientDir}`);
