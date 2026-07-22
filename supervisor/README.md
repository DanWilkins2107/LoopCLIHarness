# `loop` — deterministic supervisor

Drives the [single-session runner](../runner/) in a batch: repeatedly picks the
first recommended AgentJira task, runs it in a fresh runner process, acts on the
outcome, and stops when nothing is recommended. **Deterministic** — plain code,
no LLM and no accumulating context in the loop itself; all per-task intelligence
lives in the runner's fresh session.

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
   reading its single stdout JSON line (`{ node_id, outcome, detail }`). The node
   is marked attempted.
3. **Act** on the runner's outcome:
   - `completed` — move on to the next recommended task.
   - `asked_user` — the node is now with the human; leave it and continue.
   - `errored` — surface it (a log line now, plus the run summary); **no retry**
     this run.

Each node is attempted **at most once per run**. The attempted-set prevents
re-picking an errored node, or one the CLI still lists just after a `completed`
run advanced its status.

## Termination and output

The loop ends when no *unattempted* recommended task remains (also if the board
can't be read). It then prints a machine-readable summary to **stdout** and exits
`0`:

```json
{ "attempted": 3, "completed": 2, "asked_user": 1, "errored": 0, "errored_node_ids": [] }
```

All diagnostics and the runners' own output go to **stderr**; stdout carries only
the final summary line.

## Scope (v1)

Deployment-agnostic: it runs to completion and exits — no polling, backoff, or
sleep-when-idle, and no soft-block judgment. Those are separate follow-ups.
