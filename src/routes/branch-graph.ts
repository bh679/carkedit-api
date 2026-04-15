import path from "path";
import { fileURLToPath } from "url";
import { Router } from "express";
import simpleGit from "simple-git";
import { requireAdmin } from "../middleware/auth.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/* ------------------------------------------------------------------ */
/*  Repo paths                                                         */
/* ------------------------------------------------------------------ */

const onlineRepoDir =
  process.env.ONLINE_REPO_DIR ||
  "/opt/bitnami/apache/htdocs/carkedit-online";

const apiRepoDir =
  process.env.API_REPO_DIR || path.resolve(__dirname, "../..");

/* ------------------------------------------------------------------ */
/*  Types                                                              */
/* ------------------------------------------------------------------ */

interface Commit {
  hash: string;
  parents: string[];
  date: string;
  subject: string;
  refs: string[];
  onMain: boolean;
  branch: string;
}

/* ------------------------------------------------------------------ */
/*  Cache                                                              */
/* ------------------------------------------------------------------ */

let graphCache: {
  data: { client: Commit[]; api: Commit[] };
  ts: number;
  headClient: string;
  headApi: string;
} | null = null;

const GRAPH_CACHE_TTL = 30_000; // 30 seconds

/* ------------------------------------------------------------------ */
/*  Helpers                                                            */
/* ------------------------------------------------------------------ */

const MAX_MAIN_COMMITS = 100;
const MAX_BRANCHES = 10;
const LOG_FORMAT = "%H\t%P\t%aI\t%s\t%D";

function cleanRefs(raw: string): string[] {
  if (!raw.trim()) return [];
  return raw
    .split(",")
    .map((r) => r.trim())
    .filter((r) => !r.includes("refs/stash"))
    .map((r) => r.replace(/^HEAD -> /, "").replace(/^origin\//, ""))
    .filter((r) => r !== "HEAD" && r !== "");
}

function parseLogLine(line: string): Omit<Commit, "onMain" | "branch"> | null {
  const parts = line.split("\t");
  if (parts.length < 5) return null;
  const hash = parts[0];
  if (!hash) return null;
  const parents = parts[1] ? parts[1].split(" ").filter(Boolean) : [];
  return {
    hash,
    parents,
    date: parts[2],
    subject: parts[3],
    refs: cleanRefs(parts[4]),
  };
}

/* ------------------------------------------------------------------ */
/*  4-Phase graph algorithm                                            */
/* ------------------------------------------------------------------ */

async function buildRepoGraph(repoDir: string): Promise<Commit[]> {
  const git = simpleGit(repoDir);

  // Fetch latest refs (once per cache rebuild)
  try {
    await git.fetch(["--prune", "origin"]);
  } catch {
    // fetch may fail locally if no remote configured — continue anyway
  }

  /* ── Phase 1: Main backbone ── */
  const mainLog = await git.raw([
    "log",
    "--first-parent",
    "origin/main",
    `--format=${LOG_FORMAT}`,
    `-n`,
    String(MAX_MAIN_COMMITS),
  ]);

  const mainCommits: Commit[] = [];
  const mainHashSet = new Set<string>();

  for (const line of mainLog.split("\n")) {
    if (!line.trim()) continue;
    const parsed = parseLogLine(line);
    if (!parsed) continue;
    mainHashSet.add(parsed.hash);
    mainCommits.push({ ...parsed, onMain: true, branch: "main" });
  }

  /* ── Phase 2: Per-branch commits ── */
  let branchOutput: string;
  try {
    branchOutput = await git.raw([
      "branch",
      "-r",
      "--no-merged",
      "origin/main",
      "--sort=-committerdate",
      "--no-color",
    ]);
  } catch {
    branchOutput = "";
  }

  const openBranches = branchOutput
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l && !l.includes("origin/HEAD"))
    .filter((l) => l.startsWith("origin/"))
    .map((l) => l.replace(/^origin\//, ""))
    .slice(0, MAX_BRANCHES);

  const branchCommits: Commit[] = [];

  for (const branchName of openBranches) {
    try {
      // Find fork point
      const mergeBase = (
        await git.raw(["merge-base", "origin/main", `origin/${branchName}`])
      ).trim();
      if (!mergeBase) continue;

      // Get branch-only commits
      const branchLog = await git.raw([
        "log",
        "--first-parent",
        `origin/main..origin/${branchName}`,
        `--format=${LOG_FORMAT}`,
      ]);

      const commits: Commit[] = [];
      for (const line of branchLog.split("\n")) {
        if (!line.trim()) continue;
        const parsed = parseLogLine(line);
        if (!parsed) continue;
        // Keep only first parent (strips merge-from-main noise)
        const firstParent = parsed.parents[0];
        commits.push({
          ...parsed,
          parents: firstParent ? [firstParent] : [],
          onMain: false,
          branch: branchName,
        });
      }

      if (commits.length === 0) continue;

      /* ── Phase 3: Off-backbone merge-base resolution ── */
      if (!mainHashSet.has(mergeBase)) {
        // The merge-base is NOT on the first-parent backbone.
        // Find the backbone merge commit that brought it into main.
        try {
          const ancestryPath = await git.raw([
            "log",
            "--ancestry-path",
            `${mergeBase}..origin/main`,
            "--format=%H",
            "--reverse",
            "-n",
            "1",
          ]);
          const backboneCommit = ancestryPath.trim();
          if (backboneCommit && mainHashSet.has(backboneCommit)) {
            // Rewrite the oldest branch commit's parent to point to backbone
            const oldest = commits[commits.length - 1];
            commits[commits.length - 1] = {
              ...oldest,
              parents: [backboneCommit],
            };
          }
        } catch {
          // If ancestry-path fails, leave as-is
        }
      } else {
        // Ensure the oldest commit's parent points to the merge-base
        // (it should already via first-parent, but be explicit)
        const oldest = commits[commits.length - 1];
        if (oldest.parents.length === 0 || oldest.parents[0] !== mergeBase) {
          commits[commits.length - 1] = {
            ...oldest,
            parents: [mergeBase],
          };
        }
      }

      branchCommits.push(...commits);
    } catch {
      // Skip branches that fail — partial data is better than none
      continue;
    }
  }

  /* ── Phase 4: Assembly ── */
  const commitMap = new Map<string, Commit>();

  // Main commits first (they win on dedup)
  for (const c of mainCommits) {
    commitMap.set(c.hash, c);
  }

  // Branch commits (skip if already in main)
  for (const c of branchCommits) {
    if (!commitMap.has(c.hash)) {
      commitMap.set(c.hash, c);
    }
  }

  // For main merge commits: filter out second parents NOT in the commit set
  // This prevents orphan curves to merged/closed branches
  const allHashes = new Set(commitMap.keys());
  for (const [hash, commit] of commitMap) {
    if (commit.onMain && commit.parents.length > 1) {
      const filtered = commit.parents.filter(
        (p, i) => i === 0 || allHashes.has(p),
      );
      if (filtered.length !== commit.parents.length) {
        commitMap.set(hash, { ...commit, parents: filtered });
      }
    }
  }

  // Deduplicate refs
  const commits = Array.from(commitMap.values()).map((c) => ({
    ...c,
    refs: [...new Set(c.refs)],
  }));

  // Sort by date descending
  commits.sort(
    (a, b) => new Date(b.date).getTime() - new Date(a.date).getTime(),
  );

  return commits;
}

/* ------------------------------------------------------------------ */
/*  Quick HEAD check for cache invalidation                            */
/* ------------------------------------------------------------------ */

async function getHead(repoDir: string): Promise<string> {
  try {
    const git = simpleGit(repoDir);
    return (await git.revparse(["HEAD"])).trim();
  } catch {
    return "";
  }
}

/* ------------------------------------------------------------------ */
/*  Router                                                             */
/* ------------------------------------------------------------------ */

const router = Router();

router.use(requireAdmin());

router.get("/graph", async (_req, res) => {
  try {
    // Quick HEAD checks for cache validation
    const [headClient, headApi] = await Promise.all([
      getHead(onlineRepoDir),
      getHead(apiRepoDir),
    ]);

    // Return cache if valid
    if (
      graphCache &&
      Date.now() - graphCache.ts < GRAPH_CACHE_TTL &&
      graphCache.headClient === headClient &&
      graphCache.headApi === headApi
    ) {
      return res.json(graphCache.data);
    }

    // Build graph for both repos in parallel
    const [client, api] = await Promise.all([
      buildRepoGraph(onlineRepoDir).catch((err) => {
        console.error(
          "[CarkedIt API] Branch graph failed for client repo:",
          err.message,
        );
        return [] as Commit[];
      }),
      buildRepoGraph(apiRepoDir).catch((err) => {
        console.error(
          "[CarkedIt API] Branch graph failed for api repo:",
          err.message,
        );
        return [] as Commit[];
      }),
    ]);

    if (client.length === 0 && api.length === 0) {
      return res
        .status(502)
        .json({ error: "Failed to build graph for both repos" });
    }

    const data = { client, api };
    graphCache = { data, ts: Date.now(), headClient, headApi };

    res.json(data);
  } catch (err: any) {
    console.error("[CarkedIt API] Branch graph error:", err.message);
    res.status(500).json({ error: "Internal server error" });
  }
});

export default router;
