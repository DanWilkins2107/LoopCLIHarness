# `loop` — deterministic supervisor

Drives the [single-session runner](../runner/) in a long-lived loop: repeatedly
picks the first recommended AgentJira task, runs it in a fresh runner process,
acts on the outcome, and gently polls when the board is idle (backing off on
usage-limit / API-error exits). **Deterministic** — plain code, no LLM and no
accumulating context in the loop itself; all per-task intelligence lives in the
runner's fresh session.

## Prerequisites

Same as the runner (auth is a precondition, not the loop's job):

- The `aj` CLI on `PATH` and authenticated (`aj tasks` works).
- `claude` on `PATH` and authenticated with the AgentJira plugin (used by the
  runner).
- `tsx` available (the loop spawns `tsx ../runner/run-task.ts <node-id>`).
- Node.js >= 18.
- A POSIX environment (Linux runners / an Ubuntu container locally).

## Usage

```bash
npm install                     # once, to pull the dev toolchain (tsx, typescript)
npx tsx loop.ts                 # or: npm start
npx tsx loop.ts --project <id>  # scope to one project (passes through to `aj tasks -p`)
```

Type-check with `npm run typecheck`.

## What it does each iteration

1. **Select** — query `aj tasks --json` *fresh*, take the first `recommended`
   entry not already attempted this run. No selection logic of its own; it trusts
   the recommended order.
2. **Run** — spawn the runner for that node, forwarding the runner's stderr and
   reading its single stdout JSON line (`{ node_id, outcome, detail, reset_at? }`).
3. **Act** on the runner's outcome:
   - `completed` — move on; mark attempted.
   - `asked_user` — the node is now with the human; leave it, mark attempted.
   - `errored` — surface it (a log line, plus the run summary); mark attempted,
     skip it for the rest of the run. **No retry.**
   - `usage_limited` — sleep until `reset_at` (+ margin), or a fixed cooldown when
     no `reset_at`, then **re-run the same node** — not counted, not marked
     attempted (a usage limit is not the node's fault).
   - `api_error` — transient. Exponential backoff and re-run the same node up to a
     retry cap; on exhaustion treat as `errored`.

A terminally-handled node is attempted **at most once per idle cycle**; errored
nodes are skipped for the rest of the process. The attempted-set also prevents
re-picking a node the CLI still lists just after a `completed` run advanced its
status.

## Backoff and idle polling

Rate-limit/backoff/idle tuning is **hardcoded** in `constants.ts` (not
user-editable); the sleep + exponential-backoff math is in `backoff.ts`
(`min(base·2ⁿ, cap)`).

The loop is a **long-lived poller**: when no recommended agent-turn task remains
it logs `idle`, sleeps `IDLE_INTERVAL_S`, and re-queries — it does **not** exit.
Each idle cycle clears the attempted-set (so nodes newly in an agent-turn status
get picked up) while keeping a persistent errored-node skip set. `SIGINT`/
`SIGTERM` stops it after the current node, prints the summary, and exits `0`.

## Output

On shutdown it prints a machine-readable summary to **stdout**:

```json
{ "attempted": 3, "completed": 2, "asked_user": 1, "errored": 0, "errored_node_ids": [] }
```

All diagnostics and the runners' own output go to **stderr**; stdout carries only
the final summary line. Exit codes 21 (`usage_limited`) / 22 (`api_error`) come
from the runner — see [`../runner/`](../runner/).
