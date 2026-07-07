# LoopCLIHarness

A harness that loops headless Claude Code sessions to pick up and work AgentJira tasks.

The harness repeatedly spins up non-interactive Claude Code sessions, points each at the
AgentJira board, and lets them claim an approved node, implement it, and raise a PR — then
loops to the next task. Each session is a long-lived, stateful, interactive process with a
real filesystem and shell, so the harness treats sandboxing, hosting, and credential
handling as first-class concerns.

Design and decision docs live under [`docs/`](docs/).
