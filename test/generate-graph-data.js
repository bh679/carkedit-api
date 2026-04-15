#!/usr/bin/env node
/**
 * Standalone test — runs the 4-phase branch graph algorithm against local repos.
 * Outputs JSON to stdout that can be pasted into test-branch-graph.html.
 *
 * Usage:
 *   node test/generate-graph-data.js
 *   node test/generate-graph-data.js | jq .
 *   node test/generate-graph-data.js > /tmp/graph-data.json
 */

import simpleGit from "simple-git";

const ONLINE_REPO = process.env.ONLINE_REPO_DIR || "/Users/brennanhatton/Projects/CarkedIt/carkedit-online";
const API_REPO = process.env.API_REPO_DIR || "/Users/brennanhatton/Projects/CarkedIt/carkedit-api";
const MAX_MAIN = 100;
const MAX_BRANCHES = 10;
const FMT = "%H\t%P\t%aI\t%s\t%D";

function cleanRefs(raw) {
  if (!raw.trim()) return [];
  return raw.split(",")
    .map(r => r.trim())
    .filter(r => !r.includes("refs/stash"))
    .map(r => r.replace(/^HEAD -> /, "").replace(/^origin\//, ""))
    .filter(r => r !== "HEAD" && r !== "");
}

function parseLine(line) {
  const parts = line.split("\t");
  if (parts.length < 5) return null;
  const hash = parts[0];
  if (!hash) return null;
  return {
    hash,
    parents: parts[1] ? parts[1].split(" ").filter(Boolean) : [],
    date: parts[2],
    subject: parts[3],
    refs: cleanRefs(parts[4]),
  };
}

async function buildRepoGraph(repoDir) {
  const git = simpleGit(repoDir);
  const label = repoDir.includes("online") ? "client" : "api";

  console.error(`[${label}] Fetching...`);
  try { await git.fetch(["--prune", "origin"]); } catch { /* ok */ }

  // Phase 1: Main backbone
  console.error(`[${label}] Phase 1: Main backbone`);
  const mainLog = await git.raw(["log", "--first-parent", "origin/main", `--format=${FMT}`, "-n", String(MAX_MAIN)]);
  const mainCommits = [];
  const mainHashSet = new Set();

  for (const line of mainLog.split("\n")) {
    if (!line.trim()) continue;
    const parsed = parseLine(line);
    if (!parsed) continue;
    mainHashSet.add(parsed.hash);
    mainCommits.push({ ...parsed, onMain: true, branch: "main" });
  }
  console.error(`[${label}]   ${mainCommits.length} main commits`);

  // Phase 2: Per-branch commits
  console.error(`[${label}] Phase 2: Per-branch commits`);
  let branchOutput;
  try {
    branchOutput = await git.raw(["branch", "-r", "--no-merged", "origin/main", "--sort=-committerdate", "--no-color"]);
  } catch { branchOutput = ""; }

  const openBranches = branchOutput.split("\n")
    .map(l => l.trim())
    .filter(l => l && !l.includes("origin/HEAD") && l.startsWith("origin/"))
    .map(l => l.replace(/^origin\//, ""))
    .slice(0, MAX_BRANCHES);

  console.error(`[${label}]   ${openBranches.length} open branches: ${openBranches.join(", ")}`);

  const branchCommits = [];
  for (const branchName of openBranches) {
    try {
      const mergeBase = (await git.raw(["merge-base", "origin/main", `origin/${branchName}`])).trim();
      if (!mergeBase) continue;

      const branchLog = await git.raw(["log", "--first-parent", `origin/main..origin/${branchName}`, `--format=${FMT}`]);
      const commits = [];
      for (const line of branchLog.split("\n")) {
        if (!line.trim()) continue;
        const parsed = parseLine(line);
        if (!parsed) continue;
        const firstParent = parsed.parents[0];
        commits.push({ ...parsed, parents: firstParent ? [firstParent] : [], onMain: false, branch: branchName });
      }

      if (commits.length === 0) continue;

      // Phase 3: Off-backbone merge-base resolution
      if (!mainHashSet.has(mergeBase)) {
        try {
          const ancestryPath = await git.raw(["log", "--ancestry-path", `${mergeBase}..origin/main`, "--format=%H", "--reverse", "-n", "1"]);
          const backboneCommit = ancestryPath.trim();
          if (backboneCommit && mainHashSet.has(backboneCommit)) {
            const oldest = commits[commits.length - 1];
            commits[commits.length - 1] = { ...oldest, parents: [backboneCommit] };
            console.error(`[${label}]   ${branchName}: rewritten merge-base → ${backboneCommit.slice(0, 7)}`);
          }
        } catch { /* leave as-is */ }
      } else {
        const oldest = commits[commits.length - 1];
        if (oldest.parents.length === 0 || oldest.parents[0] !== mergeBase) {
          commits[commits.length - 1] = { ...oldest, parents: [mergeBase] };
        }
      }

      branchCommits.push(...commits);
      console.error(`[${label}]   ${branchName}: ${commits.length} commits (base: ${mergeBase.slice(0, 7)})`);
    } catch (e) {
      console.error(`[${label}]   ${branchName}: SKIPPED (${e.message})`);
    }
  }

  // Phase 4: Assembly
  console.error(`[${label}] Phase 4: Assembly`);
  const commitMap = new Map();
  for (const c of mainCommits) commitMap.set(c.hash, c);
  for (const c of branchCommits) { if (!commitMap.has(c.hash)) commitMap.set(c.hash, c); }

  const allHashes = new Set(commitMap.keys());
  for (const [hash, commit] of commitMap) {
    if (commit.onMain && commit.parents.length > 1) {
      const filtered = commit.parents.filter((p, i) => i === 0 || allHashes.has(p));
      if (filtered.length !== commit.parents.length) {
        commitMap.set(hash, { ...commit, parents: filtered });
      }
    }
  }

  const result = Array.from(commitMap.values())
    .map(c => ({ ...c, refs: [...new Set(c.refs)] }));
  result.sort((a, b) => new Date(b.date).getTime() - new Date(a.date).getTime());

  console.error(`[${label}] Done: ${result.length} total commits`);
  return result;
}

async function main() {
  const [client, api] = await Promise.all([
    buildRepoGraph(ONLINE_REPO),
    buildRepoGraph(API_REPO),
  ]);
  process.stdout.write(JSON.stringify({ client, api }, null, 2) + "\n");
}

main().catch(e => { console.error("Fatal:", e); process.exit(1); });
