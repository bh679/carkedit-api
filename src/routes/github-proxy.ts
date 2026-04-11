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
    const url = `${GITHUB_API}/repos/${owner}/${repo}/stats/commit_activity`;
    let ghRes = await fetch(url, { headers: ghHeaders() });

    // GitHub returns 202 while computing stats — retry server-side
    for (let i = 0; i < 4 && ghRes.status === 202; i++) {
      await new Promise(r => setTimeout(r, 2000 * (i + 1)));
      ghRes = await fetch(url, { headers: ghHeaders() });
    }

    forwardRateLimit(ghRes, res);

    // If still 202 after retries, return empty array so client doesn't loop
    if (ghRes.status === 202) {
      return res.status(200).json([]);
    }

    const data = await ghRes.json().catch(() => []);
    res.status(ghRes.status).json(data);
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

// GET /wiki/:owner/:repo/:page — fetch raw wiki page markdown
router.get("/wiki/:owner/:repo/:page", async (req, res) => {
  try {
    const { owner, repo, page } = req.params;
    const url = `https://raw.githubusercontent.com/wiki/${owner}/${repo}/${encodeURIComponent(page)}.md`;
    const ghRes = await fetch(url);
    if (!ghRes.ok) {
      return res.status(ghRes.status).send("");
    }
    const text = await ghRes.text();
    res.type("text/plain").send(text);
  } catch (err) {
    res.status(502).json({ error: "GitHub proxy error" });
  }
});

// ── Pre-computed contribution graph ──────────────────

const CONTRIB_REPOS = [
  "bh679/carkedit-online",
  "bh679/carkedit-api",
  "bh679/CarkedIt",
  "bh679/carkedit-client",
  "bh679/fill-in-the-blank",
];

let contribCache: { data: any[]; ts: number } | null = null;
const CONTRIB_CACHE_TTL = 5 * 60 * 1000; // 5 min

function sundayOfWeek(date: Date): number {
  const d = new Date(date);
  d.setUTCHours(0, 0, 0, 0);
  d.setUTCDate(d.getUTCDate() - d.getUTCDay()); // back to Sunday
  return Math.floor(d.getTime() / 1000);
}

async function buildContribGraph(): Promise<any[]> {
  const since = new Date();
  since.setDate(since.getDate() - 91); // ~13 weeks
  const sinceISO = since.toISOString();

  // Fetch commits from all repos in parallel (100 per repo is plenty for 3 months)
  const allCommits: Date[] = [];
  await Promise.all(
    CONTRIB_REPOS.map(async (repo) => {
      try {
        const url = `${GITHUB_API}/repos/${repo}/commits?since=${sinceISO}&per_page=100`;
        const ghRes = await fetch(url, { headers: ghHeaders() });
        if (!ghRes.ok) return;
        const commits = (await ghRes.json()) as any[];
        if (!Array.isArray(commits)) return;
        for (const c of commits) {
          const dateStr = c.commit?.author?.date || c.commit?.committer?.date;
          if (dateStr) allCommits.push(new Date(dateStr));
        }
      } catch { /* skip repo */ }
    })
  );

  // Build week buckets: { weekSunday -> days[0..6] }
  const buckets = new Map<number, number[]>();

  // Pre-fill empty weeks for the last 13 weeks
  const now = new Date();
  for (let i = 12; i >= 0; i--) {
    const d = new Date(now);
    d.setDate(d.getDate() - i * 7);
    const sunday = sundayOfWeek(d);
    if (!buckets.has(sunday)) buckets.set(sunday, [0, 0, 0, 0, 0, 0, 0]);
  }

  // Tally commits into day slots
  for (const date of allCommits) {
    const sunday = sundayOfWeek(date);
    if (!buckets.has(sunday)) buckets.set(sunday, [0, 0, 0, 0, 0, 0, 0]);
    const dayOfWeek = date.getUTCDay(); // 0=Sun .. 6=Sat
    buckets.get(sunday)![dayOfWeek]++;
  }

  // Sort by week timestamp and return
  return [...buckets.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([week, days]) => ({ week, days }));
}

// GET /contrib-graph — pre-merged contribution data from all repos
router.get("/contrib-graph", async (_req, res) => {
  try {
    if (contribCache && Date.now() - contribCache.ts < CONTRIB_CACHE_TTL) {
      return res.json(contribCache.data);
    }
    const data = await buildContribGraph();
    contribCache = { data, ts: Date.now() };
    res.json(data);
  } catch (err) {
    res.status(502).json({ error: "Failed to build contribution graph" });
  }
});

// ── Pre-computed dev stats ─────────────────────────────

const LIVE_REPOS = CONTRIB_REPOS.slice(0, 3);

let devStatsCache: { data: any; ts: number } | null = null;

async function buildDevStats() {
  const results = {
    totalCommits: 0,
    liveCommits: 0,
    branchesMerged: 0,
    linesOfCode: 0,
    daysWorked: 0,
  };

  const allDays = new Set<string>();

  await Promise.all(
    CONTRIB_REPOS.map(async (repo) => {
      const isLive = LIVE_REPOS.includes(repo);

      // Contributors → commit counts
      try {
        const res = await fetch(
          `${GITHUB_API}/repos/${repo}/contributors?per_page=100`,
          { headers: ghHeaders() }
        );
        if (res.ok) {
          const contributors = await res.json();
          if (Array.isArray(contributors)) {
            const repoCommits = contributors.reduce(
              (s: number, c: any) => s + (c.contributions || 0),
              0
            );
            results.totalCommits += repoCommits;
            if (isLive) results.liveCommits += repoCommits;
          }
        }
      } catch { /* skip */ }

      // Stats/contributors → lines of code (additions)
      try {
        const url = `${GITHUB_API}/repos/${repo}/stats/contributors`;
        let res = await fetch(url, { headers: ghHeaders() });
        for (let i = 0; i < 3 && res.status === 202; i++) {
          await new Promise((r) => setTimeout(r, 2000 * (i + 1)));
          res = await fetch(url, { headers: ghHeaders() });
        }
        if (res.ok) {
          const stats = await res.json();
          if (Array.isArray(stats)) {
            for (const contributor of stats) {
              if (Array.isArray(contributor.weeks)) {
                for (const week of contributor.weeks) {
                  results.linesOfCode += week.a || 0;
                }
              }
            }
          }
        }
      } catch { /* skip */ }

      // Merged PRs → branches merged
      try {
        const res = await fetch(
          `${GITHUB_API}/repos/${repo}/pulls?state=closed&per_page=100`,
          { headers: ghHeaders() }
        );
        if (res.ok) {
          const pulls = await res.json();
          if (Array.isArray(pulls)) {
            results.branchesMerged += pulls.filter(
              (p: any) => p.merged_at != null
            ).length;
          }
        }
      } catch { /* skip */ }

      // Commits → unique days worked
      try {
        const res = await fetch(
          `${GITHUB_API}/repos/${repo}/commits?per_page=100`,
          { headers: ghHeaders() }
        );
        if (res.ok) {
          const commits = await res.json();
          if (Array.isArray(commits)) {
            for (const c of commits) {
              const dateStr =
                c.commit?.author?.date || c.commit?.committer?.date;
              if (dateStr) allDays.add(dateStr.slice(0, 10));
            }
          }
        }
      } catch { /* skip */ }
    })
  );

  results.daysWorked = allDays.size;
  return results;
}

// GET /dev-stats — aggregated development statistics
router.get("/dev-stats", async (_req, res) => {
  try {
    if (devStatsCache && Date.now() - devStatsCache.ts < CONTRIB_CACHE_TTL) {
      return res.json(devStatsCache.data);
    }
    const data = await buildDevStats();
    devStatsCache = { data, ts: Date.now() };
    res.json(data);
  } catch (err) {
    res.status(502).json({ error: "Failed to build dev stats" });
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
