# `run-task` — single-session runner

Runs **one** AgentJira node in **one** fresh headless auto-mode Claude Code
session and reports how it finished. Stateless by design: every invocation is a
brand-new session process — no `--continue`/`--resume`, no state carried
between runs.

## Prerequisites

Auth is a **precondition**, not the runner's job (local dev is fine for v1):

- `claude` on `PATH` and authenticated, with the AgentJira plugin installed.
- The `aj` CLI on `PATH` and authenticated (`aj whoami` works — via env vars or
  `~/.agentjira/config.json`, whichever the environment provides).
- Node.js >= 18.

## Usage

```bash
npm install                     # once, to pull the dev toolchain (tsx, typescript)
npx tsx run-task.ts <node-id>   # or: npm start -- <node-id>
```

Type-check with `npm run typecheck`.

## Output contract

stdout carries exactly one JSON object —
`{ "node_id", "outcome", "detail" }` — everything else (diagnostics and the
session's own output) goes to stderr. `outcome` is `completed` (exit 0),
`asked_user` (exit 10), or `errored` (exit 20); the supervisor consumes either.
