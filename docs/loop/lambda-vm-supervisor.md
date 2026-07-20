# Lambda-triggered VM supervisor architecture

**Status:** Decided (v1)
**Decision:** Operate the loop as a **scheduled Lambda that spawns an ephemeral VM**.
An EventBridge cron fires a cheap Lambda that reads the board (`aj tasks --json`); when
unattempted recommended work exists and no supervisor VM is already running, it **starts a
pre-provisioned, stopped VM**. That VM runs the deterministic supervisor loop
(`ff1bd2c1`) to completion and **stops itself** when the loop exits idle. No VM idles between
bursts; no long-lived daemon.

This node decides how the loop is *operated*. It changes no loop code: the supervisor's
existing contract — run to completion, then **exit 0 with a machine-readable summary** when no
unattempted recommended task remains — is the only seam this design leans on.

## What we are operating

The deterministic supervisor loop (`ff1bd2c1`) is a **batch process**: it selects the first
unattempted recommended task, runs it in a fresh runner session, acts on the outcome, and
**exits 0 when the board has no more recommended work**. It does not poll, sleep, or idle — that
was deliberately pushed to siblings (`4f1d9719` idle-backoff, `38a4fa30` soft-block judgment).

So the operating question is narrow: **what turns that batch process on when there is work, and
off when there isn't, without paying for an idle VM in between?** Work arrives in bursts (a human
approves specs, a PR merges and unblocks children), so between bursts the right amount of compute
is *zero*.

The host is already decided: a **raw VM** (`hosting-model.md`), chosen for long-lived stateful
Claude Code sessions with an operator-owned drain-then-replace lifecycle. This design must sit on
that host and conflict with neither it nor the lifecycle node (`5039267c`).

## Options weighed

### 1. Always-on VM daemon

A single VM stays up permanently; a daemon (cron/systemd-timer on the box) wakes the supervisor
loop on an interval.

- **Trigger** — Local timer on the VM. Simplest possible; no cloud trigger surface.
- **Cost** — Pays 24/7 for a box that is idle most of the time. Work is bursty; the VM is not.
  This is the exact "idle VM between bursts" the node is chartered to avoid.
- **Fit** — The daemon must own poll/backoff to avoid busy-spinning an empty board — logic the
  loop deliberately *doesn't* have (`4f1d9719` owns it, and isn't built yet). An always-on daemon
  forces that dependency early. Rejected.

### 2. Lambda spawns an ephemeral VM — **chosen**

A scheduled Lambda is the cheap always-on part; the VM is the expensive burst part and exists
only while there is work.

- **Trigger** — EventBridge cron invokes a small Lambda on a coarse interval (e.g. every few
  minutes). The Lambda reads `aj tasks --json`, and only if there is unattempted recommended work
  **and** no supervisor VM already running does it start the VM. A poll with nothing to do costs a
  sub-second Lambda invocation, not a running VM.
- **Cost** — Near-zero between bursts (Lambda invocations are effectively free at this cadence);
  VM time is paid only while the loop is actually working. Matches spend to work.
- **Fit** — Clean division of labor: the Lambda is stateless and short (Lambda's native shape),
  the VM is long-lived and stateful (the raw-VM host's native shape). The loop stays deployment-
  agnostic and unchanged — the Lambda just starts the box; the loop's existing exit-0-when-idle is
  the stop signal. Chosen.

### 3. Lambda-only (no VM)

Run the loop (and the Claude Code sessions it drives) inside Lambda itself.

- **Fit** — A non-starter, and already settled: `hosting-model.md` rejected managed compute for
  the session workload outright — hard execution-time caps, ephemeral/read-only filesystem, no
  persistent interactive shell. A Claude Code session violates every one of those. Lambda can
  *trigger* the work; it cannot *host* it. Rejected.

## v1 recommendation

**A scheduled Lambda that starts a stopped, pre-provisioned VM (option 2).** It is the only option
that pays zero compute between bursts while still hosting the long-lived stateful sessions on the
raw VM the hosting model requires — the Lambda is the cheap trigger, the VM is the capable worker,
and the loop's existing run-to-completion contract is the entire integration seam.

### One-line reason per rejected option

- **Always-on VM daemon:** pays 24/7 for a box that is idle between bursts and forces the not-yet-
  built poll/backoff logic into the operating layer — the exact idle cost this node exists to kill.
- **Lambda-only:** managed compute can't host a long-lived interactive Claude Code session (settled
  in `hosting-model.md`); it can trigger the work but not run it.

## Trigger / schedule

- **EventBridge cron → Lambda**, on a coarse fixed interval (minutes, not seconds; tune later with
  `4f1d9719`). Fixed-rate polling is the v1 shape — event-driven triggering off the board is a
  later refinement, not needed for v1.
- The Lambda does the **cheap check only**: `aj tasks --json`, filter to unattempted `recommended`
  entries (the same set the loop would pick from). Empty → do nothing, exit. Non-empty → proceed to
  the concurrency check below, then start the VM. The Lambda never runs a task itself and holds no
  state between invocations.
- The Lambda needs board read access and permission to start/describe the one VM — a tightly scoped
  role, provisioned via Terraform alongside the VM.

## VM start-vs-stop mechanism

**Start a pre-provisioned, stopped instance** (not Terraform create/destroy per burst, not a
prebaked-AMI launch each time).

- **Start stopped instance — chosen.** The supervisor VM is created **once** by Terraform and left
  in the stopped state. The Lambda issues *start*; the VM issues *stop* on itself when idle.
  Start/stop is seconds, has a stable instance id (which makes the concurrency check trivial — see
  below), and keeps the whole fleet in one Terraform state without the Lambda ever mutating infra.
- **Terraform create/destroy per burst — rejected.** Putting `terraform apply`/`destroy` on the
  hot path means the Lambda mutates infrastructure state on every burst: slow, race-prone against
  concurrent applies, and it drags the full IaC toolchain into a function that should only make one
  API call. Terraform provisions the box; it does not cycle it.
- **Prebaked-AMI launch each time — rejected for v1.** Launching a fresh instance from a baked
  image per burst is the cleaner path *once image-bake and drain-then-replace exist* (`5039267c`),
  but for v1 it adds a bake pipeline and per-launch instance churn for no benefit over starting one
  stopped box. Revisit when lifecycle lands (see reconciliation).

## VM lifecycle (per burst)

1. Lambda starts the stopped instance.
2. On boot the VM runs the supervisor loop (`ff1bd2c1`) — e.g. a systemd oneshot / boot unit that
   invokes the `loop` entrypoint. The loop works the recommended set exactly as specified.
3. The loop **runs to completion and exits 0 with its summary** when no unattempted recommended
   task remains. That exit is the **only seam**: the boot unit waits on it and, on a clean exit,
   the VM **stops itself** (self-issued `shutdown`/stop). No external stop signal, no idle poll on
   the box.
4. Stopped VM costs nothing but storage until the next Lambda start.

The loop's `asked_user` / `errored` outcomes need no special operating handling — they resolve on
the board (human turn, or surfaced error), the loop still exits 0 when nothing recommended remains,
and the VM stops. The next scheduled Lambda re-evaluates the board fresh.

## Concurrency / idempotency — never double-spawn

The single stable instance id makes this a **describe-before-start** check:

- Before starting, the Lambda calls describe on the supervisor instance. Start **only** if it is in
  the `stopped` state. If it is `running`, `pending`, or `stopping`, the Lambda does nothing this
  tick — a burst is already in flight (or winding down) and will drain the board itself.
- Because there is exactly **one** supervisor instance (started, never created, per burst),
  "is one already running?" is a single state read, not a tag-scan or desired-count reconciliation.
  Two overlapping Lambda invocations both see `running` (or one loses the start race harmlessly on a
  no-op start of an already-starting box); neither creates a second worker.
- The board itself is the second line of defense: the runner **claims** each node, so even in a
  pathological double-start no node is worked twice. The concurrency check prevents paying for two
  VMs; the claim prevents duplicated *work*.

This is a **single-worker v1 by design** — one VM draining the recommended set serially, matching
the loop's own serial, single-session model. Parallel workers are a scale concern for later, not v1.

## Reconciliation

- **Hosting model (`hosting-model.md`, raw VM).** Fully consistent: the worker is a raw VM with
  full root, hosting the sessions exactly as decided. The Lambda is *operating* infrastructure
  (trigger + power switch), not a session host — it never runs a Claude Code session, so the
  "managed compute can't host sessions" rejection doesn't apply to it. Lambda triggering, VM
  hosting.
- **Lifecycle & rolling updates (`5039267c`, drain-then-replace).** No conflict, and deliberately
  minimal overlap for v1. Start/stop of one instance is orthogonal to drain-then-replace: draining
  is about swapping the *image/harness* under active sessions without killing them, which happens
  **while a VM is running**, not at start/stop. When `5039267c` lands, the operating model evolves
  cleanly — the "start a stopped instance" mechanism is the natural place drain-then-replace plugs
  in (bring up a new immutable-image instance, let the old one finish, retire it), and that is
  exactly the point at which the **prebaked-AMI** launch option above becomes the better mechanism.
  v1 does not need it; the seam is left open, not closed.

## Handoff notes — what the merge breaks down into

On merge this node returns to `awaiting_agent_breakdown` (it is a `breakdown_on_merge` node). The
follow-on work this decision implies:

- **Terraform: supervisor VM + Lambda + schedule.** One stopped, pre-provisioned VM instance; the
  scheduled Lambda and its EventBridge cron rule; the Lambda's scoped role (board read +
  start/describe the one instance); the VM's own permission to stop itself. Sits under the
  VM-bootstrap/deployment infra work (`8276b707`).
- **Lambda function: cheap board check + guarded start.** Read `aj tasks --json`, filter to
  unattempted recommended, describe-before-start concurrency guard, start the instance. Stateless,
  no task execution.
- **VM boot integration.** The boot unit (systemd oneshot or equivalent) that runs the `loop`
  entrypoint on start and issues self-stop on the loop's clean exit-0 — the concrete wiring of the
  loop's summary contract to the power-off.
- **Reconcile with idle-backoff (`4f1d9719`)** when it lands: the cron interval and any per-burst
  backoff are that node's to tune; this design fixes only the coarse-poll shape.
