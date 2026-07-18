# LoopCLIHarness

A harness that loops headless Claude Code sessions to pick up and work AgentJira tasks.

The harness repeatedly spins up non-interactive Claude Code sessions, points each at the
AgentJira board, and lets them claim an approved node, implement it, and raise a PR — then
loops to the next task. Each session is a long-lived, stateful, interactive process with a
real filesystem and shell, so the harness treats sandboxing, hosting, and credential
handling as first-class concerns.

## Layout

Each part of the harness lives in its own directory (monorepo-style, kept separate
even while small):

- [`runner/`](runner/) — `run-task`, the single-session runner: runs one AgentJira
  node in one fresh headless Claude Code session and reports how it finished. See
  [`runner/README.md`](runner/README.md).
- [`docs/`](docs/) — design and decision docs.
