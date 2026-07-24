# `runner` — single-session runners

Each entrypoint runs **one** AgentJira node in **one** fresh headless Claude
Code session and reports the result on stdout. Stateless by design: every
invocation is a brand-new session process — no `--continue`/`--resume`, no
state carried between runs. The generic session-spawn plumbing (`spawnTool` +
stdout/stderr wiring) lives in `session.ts`; everything else is per-entrypoint.

- **`run-task`** — the worker. Claims a node and does its stage work (break
  down / spec / implement + raise a PR).
- **`run-judge`** — the read-only soft-block judge. Reads a node already in
  `evaluating_soft_block` and returns a verdict; never claims, edits, or posts.

## Prerequisites

Auth is a **precondition**, not the runner's job (local dev is fine for v1):

- `claude` on `PATH` and authenticated, with the AgentJira plugin installed.
- The `aj` CLI on `PATH` and authenticated (`aj whoami` works — via env vars or
  `~/.agentjira/config.json`, whichever the environment provides).
- Node.js >= 18.

## Usage

```bash
npm install                      # once, to pull the dev toolchain (tsx, typescript)
npx tsx run-task.ts <node-id>    # or: npm start -- <node-id>
npx tsx run-judge.ts <node-id>   # or: npm run judge -- <node-id>
```

Type-check with `npm run typecheck`.

## Per-session sandbox (bubblewrap)

Every session runs inside an unprivileged [`bwrap`](https://github.com/containers/bubblewrap)
user namespace (posture layers 3–4 of `docs/sandboxing/network-isolation.md`).
There is no unconfined path: a missing `bwrap` fails closed. See `sandbox.ts`
for the confinement itself.

Required env (validated before any session spawns):

- `LOOP_SESSION_PROXY` — proxy URL all session egress is forced through.
- `LOOP_SESSION_WORKDIR` — the session's writable workdir.
- `NO_PROXY` (optional) — hosts that bypass the proxy.

## Output contract

Both entrypoints print exactly one JSON object on stdout; everything else
(diagnostics and the session's own output) goes to stderr.

**`run-task`** — `{ "node_id", "outcome", "detail" }`. `outcome` is `completed`
(exit 0), `asked_user` (exit 10), or `errored` (exit 20).

**`run-judge`** — `{ "node_id", "verdict", "reason" }`. `verdict` is `proceed`
(exit 0) or `not_yet` (exit 10); `reason` is one line. The judge session is
constrained **read-only** — it cannot claim, edit, or post to the board (only
read-only `aj` commands and read-only tools are allowed). Every non-`proceed`
path — spawn/session error, unsure, missing or malformed verdict — resolves to
`not_yet`. It never returns `proceed` on doubt.
