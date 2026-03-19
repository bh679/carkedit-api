# carkedit-api — Developer Guide

<!-- Source: github.com/bh679/claude-templates/templates/repo/CLAUDE.md -->

This is the `carkedit-api` sub-repo for the CarkedItOnline project.

- **Tech stack:** Node.js + Colyseus (multiplayer game server)
- **Local dev port:** `4501`
- **Project orchestrator:** https://github.com/bh679/CarkedIt

---

## Setup

```bash
npm install
npm run dev
```

---

## Versioning

<!-- Full policy: github.com/bh679/claude-templates/standards/versioning.md -->

Format: `V.MM.PPPP` in `package.json`.

- Bump `PPPP` on every commit
- Bump `MM` on every merged feature (reset PPPP to `0000`)
- Bump `V` only for breaking changes

---

## Branching & Git

<!-- Full policy: github.com/bh679/claude-templates/standards/git.md -->

- Feature branches: `dev/<feature-slug>`
- All development in **git worktrees** (never directly on `main`)
- Commit after every meaningful unit of work
- Push immediately after every commit

### Blocked commands

The following are blocked in `.claude/settings.json`:
- `git push --force`
- `git reset --hard`
- `rm -rf`

---

## Build & Test

```bash
npm run build    # production build
npm run test     # unit tests
```

For UI/integration testing, use the Playwright setup in the project orchestrator repo.

---

## Key Files

| File | Purpose |
|---|---|
| `src/index.ts` | Application entry point |
| `src/rooms/` | Colyseus game room definitions |
| `package.json` | Dependencies and version |
| `.env.example` | Required environment variables |

---

## Environment Variables

Copy `.env.example` to `.env` and fill in values. Never commit `.env`.

Required variables:
- `PORT` — Server port (default: 4501)
- `NODE_ENV` — Environment (development/production)
