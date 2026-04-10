import { Router } from "express";
import { requireAdmin } from "../middleware/auth.js";

const GITHUB_API = "https://api.github.com";

function ghHeaders(): Record<string, string> {
  const h: Record<string, string> = { Accept: "application/vnd.github.v3+json" };
  const token = process.env.GITHUB_TOKEN;
  if (token) h.Authorization = `token ${token}`;
  return h;
}

const router = Router();

// All routes require admin
router.use(requireAdmin());

// GET /repos/:owner/:repo/commits
router.get("/repos/:owner/:repo/commits", async (req, res) => {
  try {
    const { owner, repo } = req.params;
    const qs = new URLSearchParams(req.query as Record<string, string>).toString();
    const url = `${GITHUB_API}/repos/${owner}/${repo}/commits${qs ? `?${qs}` : ""}`;
    const ghRes = await fetch(url, { headers: ghHeaders() });
    forwardRateLimit(ghRes, res);
    res.status(ghRes.status).json(await ghRes.json());
  } catch (err) {
    res.status(502).json({ error: "GitHub proxy error" });
  }
});

// GET /repos/:owner/:repo/commits/:sha
router.get("/repos/:owner/:repo/commits/:sha", async (req, res) => {
  try {
    const { owner, repo, sha } = req.params;
    const ghRes = await fetch(`${GITHUB_API}/repos/${owner}/${repo}/commits/${sha}`, { headers: ghHeaders() });
    forwardRateLimit(ghRes, res);
    res.status(ghRes.status).json(await ghRes.json());
  } catch (err) {
    res.status(502).json({ error: "GitHub proxy error" });
  }
});

// GET /repos/:owner/:repo/stats/commit_activity
router.get("/repos/:owner/:repo/stats/commit_activity", async (req, res) => {
  try {
    const { owner, repo } = req.params;
    const ghRes = await fetch(`${GITHUB_API}/repos/${owner}/${repo}/stats/commit_activity`, { headers: ghHeaders() });
    forwardRateLimit(ghRes, res);
    res.status(ghRes.status).json(await ghRes.json());
  } catch (err) {
    res.status(502).json({ error: "GitHub proxy error" });
  }
});

// GET /repos/:owner/:repo/issues
router.get("/repos/:owner/:repo/issues", async (req, res) => {
  try {
    const { owner, repo } = req.params;
    const qs = new URLSearchParams(req.query as Record<string, string>).toString();
    const url = `${GITHUB_API}/repos/${owner}/${repo}/issues${qs ? `?${qs}` : ""}`;
    const ghRes = await fetch(url, { headers: ghHeaders() });
    forwardRateLimit(ghRes, res);
    res.status(ghRes.status).json(await ghRes.json());
  } catch (err) {
    res.status(502).json({ error: "GitHub proxy error" });
  }
});

// GET /repos/:owner/:repo/events
router.get("/repos/:owner/:repo/events", async (req, res) => {
  try {
    const { owner, repo } = req.params;
    const qs = new URLSearchParams(req.query as Record<string, string>).toString();
    const url = `${GITHUB_API}/repos/${owner}/${repo}/events${qs ? `?${qs}` : ""}`;
    const ghRes = await fetch(url, { headers: ghHeaders() });
    forwardRateLimit(ghRes, res);
    res.status(ghRes.status).json(await ghRes.json());
  } catch (err) {
    res.status(502).json({ error: "GitHub proxy error" });
  }
});

// GET /repos/:owner/:repo/contents/* (wildcard path for nested file paths)
router.get("/repos/:owner/:repo/contents/*", async (req, res) => {
  try {
    const { owner, repo } = req.params;
    const filePath = (req.params as any)[0];
    const qs = new URLSearchParams(req.query as Record<string, string>).toString();
    const url = `${GITHUB_API}/repos/${owner}/${repo}/contents/${filePath}${qs ? `?${qs}` : ""}`;
    const ghRes = await fetch(url, { headers: ghHeaders() });
    forwardRateLimit(ghRes, res);
    res.status(ghRes.status).json(await ghRes.json());
  } catch (err) {
    res.status(502).json({ error: "GitHub proxy error" });
  }
});

// GET /repos/:owner/:repo/git/ref/* (wildcard: tags/v1.0, heads/main, etc.)
router.get("/repos/:owner/:repo/git/ref/*", async (req, res) => {
  try {
    const { owner, repo } = req.params;
    const refPath = (req.params as any)[0];
    const ghRes = await fetch(`${GITHUB_API}/repos/${owner}/${repo}/git/ref/${refPath}`, { headers: ghHeaders() });
    forwardRateLimit(ghRes, res);
    res.status(ghRes.status).json(await ghRes.json());
  } catch (err) {
    res.status(502).json({ error: "GitHub proxy error" });
  }
});

// POST /repos/:owner/:repo/git/refs (create tags)
router.post("/repos/:owner/:repo/git/refs", async (req, res) => {
  try {
    const { owner, repo } = req.params;
    const ghRes = await fetch(`${GITHUB_API}/repos/${owner}/${repo}/git/refs`, {
      method: "POST",
      headers: { ...ghHeaders(), "Content-Type": "application/json" },
      body: JSON.stringify(req.body),
    });
    forwardRateLimit(ghRes, res);
    res.status(ghRes.status).json(await ghRes.json());
  } catch (err) {
    res.status(502).json({ error: "GitHub proxy error" });
  }
});

/** Forward GitHub rate-limit headers so the client can display them. */
function forwardRateLimit(ghRes: Response, expressRes: any) {
  const remaining = ghRes.headers.get("X-RateLimit-Remaining");
  const limit = ghRes.headers.get("X-RateLimit-Limit");
  const reset = ghRes.headers.get("X-RateLimit-Reset");
  if (remaining) expressRes.set("X-RateLimit-Remaining", remaining);
  if (limit) expressRes.set("X-RateLimit-Limit", limit);
  if (reset) expressRes.set("X-RateLimit-Reset", reset);
}

export default router;
