<!-- gate: gate-2-test (web add-on) | version: 1.1.0 -->
# Gate 2 — Testing Approval (web add-on)

**Follow `~/.claude/playbooks/gates/gate-2-test.md` first.** This file only adds web-project steps.

## Agent Actions
1. Before starting dev servers, read `~/.claude/playbooks/port-management.md`.
2. Integration/e2e tests: curl for APIs, Playwright MCP for UI.
3. Screenshots: `browser_take_screenshot`.
4. Accessibility: `browser_snapshot` for tree analysis.
5. Before the report, open the running app in the app's built-in browser (`preview_start` with the
   local URL, or `navigate`), on the page the feature lives on, so the user can test it there.

## Extra Report Content
- Clickable local URL with port (the page already open in the built-in browser)
- The start command as a fenced ```` ```bash ```` block, so it gets a Run button if the server stops
