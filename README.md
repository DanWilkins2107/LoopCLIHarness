# LoopCLIHarness

A harness that loops headless Claude Code sessions to pick up and work AgentJira tasks.

The harness repeatedly spins up non-interactive Claude Code sessions, points each at the
AgentJira board, and lets them claim an approved node, implement it, and raise a PR — then
loops to the next task. Each session is a long-lived, stateful, interactive process with a
real filesystem and shell, so the harness treats sandboxing, hosting, and credential
handling as first-class concerns.

Design and decision docs live under [`docs/`](docs/).

## `run-task` — single-session runner

`run-task <node-id>` runs **one** AgentJira node in **one** fresh headless
auto-mode Claude Code session and reports how it finished. It is the harness's
first runtime primitive; the supervisor loop builds directly on it.

Each run is a brand-new process with fresh context — no `--continue`/`--resume`,
nothing persisted, no state carried between runs.

### Prerequisites

Auth is a **precondition**, not the runner's job (local dev is fine for v1):

- [`claude`](https://docs.claude.com/en/docs/claude-code) on `PATH` and authenticated.
- The `aj` CLI on `PATH` and authenticated (`aj whoami` works).
- The AgentJira plugin already installed for the session.
- Node.js >= 18.

Before spawning a session, the runner does a fast preflight (`aj whoami`) to
confirm `aj` is on `PATH` and authenticated — via env vars (`AGENTJIRA_URL`,
`AGENTJIRA_ANON_KEY`, `AGENTJIRA_EMAIL`, `AGENTJIRA_PASSWORD`) **or**
`~/.agentjira/config.json`, whichever the environment provides. If that fails it
exits `errored` immediately rather than spending a session.

### Usage

```bash
node run-task.mjs <node-id>
# or, after `npm link` / install:
run-task <node-id>
```

The runner spawns a non-interactive session (`claude --print --permission-mode
auto --no-session-persistence --output-format json`), points it at the node, and
lets the plugin's own skills drive claim/context/stage-appropriate work.

### Output contract

The **only** thing on stdout is one JSON object (all diagnostics and the
session's own output go to stderr):

```json
{ "node_id": "<id>", "outcome": "<outcome>", "detail": "<human-readable>" }
```

`outcome` is exactly one of, each with a distinct process exit code:

| outcome      | exit | meaning                                                                    |
| ------------ | ---- | -------------------------------------------------------------------------- |
| `completed`  | `0`  | clean exit; node in a non-error state (`pr_raised`, `spec_review`, `broken_down`, `done`, …) |
| `asked_user` | `10` | clean exit; node is now `awaiting_human_response` (plugin question flow)    |
| `errored`    | `20` | crash / non-zero exit / usage-limit or API error / no clean finish         |

Classification is deterministic: it combines the session process exit status
(plus the session's own `is_error` flag) with the node's post-run status queried
via `aj context <node> --json`.
