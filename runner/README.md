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

## Per-session sandbox (bubblewrap)

On Linux each session is confined in an unprivileged [`bwrap`](https://github.com/containers/bubblewrap)
user namespace (posture layers 3–4 of `docs/sandboxing/network-isolation.md`):

- **No host-root** — a user namespace maps root-inside to the caller's
  unprivileged host uid, so a session can never edit nftables or the proxy. This
  is the precondition that makes the host firewall/proxy un-bypassable.
- **Process isolation** — separate PID/IPC/UTS/cgroup namespaces; a session
  can't see or signal host / sibling-session processes.
- **Filesystem isolation** — the host root fs is not mounted; only an allowlist
  of read-only system paths, a fresh tmpfs `HOME`, and the session's own writable
  workdir. Other sessions' data and host credential files are unreachable.
- **Egress via the proxy** — `HTTPS_PROXY`/`HTTP_PROXY` + git `http.proxy` are
  set inside the sandbox. The network namespace is shared (not unshared) so the
  session reaches the host-local proxy; the host firewall (node `c9315e26`) does
  the network confinement.

The proxy URL is read from `LOOP_SESSION_PROXY` (or standard `HTTPS_PROXY`/
`HTTP_PROXY`) — this consumes node `c9315e26`'s per-session proxy-identity scheme
without pinning it (a per-sandbox port or per-sandbox credential are both just a
URL). Credential *provisioning* into the fresh `HOME` is owned by the
credential-flow node.

Controls:

- `LOOP_SANDBOX=0` — run unconfined (opt-out; non-Linux dev is unconfined by
  default). `LOOP_SANDBOX=1` forces it on.
- `LOOP_SESSION_WORKDIR` — the session's writable workdir (default: cwd).
- On Linux with sandboxing on, a missing `bwrap` **fails closed** (the runner
  errors rather than run a session unconfined).

## Output contract

stdout carries exactly one JSON object —
`{ "node_id", "outcome", "detail" }` — everything else (diagnostics and the
session's own output) goes to stderr. `outcome` is `completed` (exit 0),
`asked_user` (exit 10), or `errored` (exit 20); the supervisor consumes either.
