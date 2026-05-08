import { Router } from "express";
import fs from "node:fs";
import path from "node:path";
import { requireAdmin } from "../middleware/auth.js";

const DEFAULT_STATE_DIR = "/home/bitnami/server";

function tokenFilePaths(): { api: string; online: string } {
  const stateDir = process.env.STATE_DIR || DEFAULT_STATE_DIR;
  return {
    api: path.join(stateDir, ".deploy-token-carkedit-api"),
    online: path.join(stateDir, ".deploy-token-carkedit-online"),
  };
}

function readTokenFile(filePath: string): string | null {
  try {
    if (!fs.existsSync(filePath)) return null;
    return fs.readFileSync(filePath, "utf-8").trim();
  } catch (err: any) {
    console.error(`[deploy-token] read failed ${filePath}: ${err.code || err.message}`);
    return null;
  }
}

export function getDeployTokensHandler(_req: any, res: any): void {
  const { api: apiPath, online: onlinePath } = tokenFilePaths();
  const apiToken = readTokenFile(apiPath);
  const onlineToken = readTokenFile(onlinePath);

  if (!apiToken || !onlineToken) {
    res.status(503).json({ error: "deploy_tokens_not_provisioned" });
    return;
  }

  res.set("Cache-Control", "no-store");
  res.json({ api: apiToken, online: onlineToken });
}

const router = Router();
router.use(requireAdmin());
router.get("/", getDeployTokensHandler);

export default router;
