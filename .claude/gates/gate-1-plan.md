<!-- gate: gate-1-plan (web add-on) | version: 1.0.0 -->
# Gate 1 — Plan Approval (web add-on)

**Follow `~/.claude/playbooks/gates/gate-1-plan.md` first.** This file only adds web-project steps.

## Research & Reuse: registries
Search npm, PyPI, crates.io and other registries before writing utility code. Prefer battle-tested
libraries over hand-rolled solutions.

## Deployment checklist: web and server items
Flag these alongside the template's checklist:

- Port or networking changes (read `~/.claude/playbooks/port-management.md`)
- Database schema migrations
- New API endpoints needing proxy or load balancer config
- Docker/container configuration changes
- Infrastructure requirement changes (memory, CPU, storage)
