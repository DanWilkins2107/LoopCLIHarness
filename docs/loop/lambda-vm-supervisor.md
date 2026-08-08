# Lambda-triggered VM supervisor architecture

**Status:** Decided
**Decision:** Operate the loop as a **scheduled Lambda that spawns an ephemeral VM**.
An EventBridge cron fires a cheap Lambda that reads the board (`aj tasks --json`); when
unattempted recommended work exists and no supervisor instance is already alive, it issues
**`RunInstances` from the VM launch template**. That fresh instance runs the deterministic
supervisor loop (`ff1bd2c1`) to completion and **terminates itself** when the loop exits idle. No
instance exists between bursts; no long-lived daemon.

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

The host is already decided: a **raw VM** (`hosting-model.md`), chosen for stateful Claude Code
sessions with an operator-owned drain-then-replace lifecycle. This design must sit on that host
and conflict with neither it nor the lifecycle node (`5039267c`).

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
  **and** no supervisor instance is already alive does it launch one. A poll with nothing to do
  costs a sub-second Lambda invocation, not a running VM.
- **Cost** — Zero between bursts: no instance, no EBS volume, no address. VM time is paid only
  while the loop is actually working. Matches spend to work.
- **Fit** — Clean division of labor: the Lambda is stateless and short (Lambda's native shape),
  the VM is stateful for the length of a burst (the raw-VM host's native shape). The loop stays
  deployment-agnostic and unchanged — the Lambda just launches the box; the loop's existing
  exit-0-when-idle is the stop signal. Chosen.

### 3. Lambda-only (no VM)

Run the loop (and the Claude Code sessions it drives) inside Lambda itself.

- **Fit** — A non-starter, and already settled: `hosting-model.md` rejected managed compute for
  the session workload outright — hard execution-time caps, ephemeral/read-only filesystem, no
  persistent interactive shell. A Claude Code session violates every one of those. Lambda can
  *trigger* the work; it cannot *host* it. Rejected.

## Recommendation

**A scheduled Lambda that launches a fresh instance from the VM launch template per burst
(option 2).** It is the only option that pays zero compute *and zero storage* between bursts while
still hosting the sessions on the raw VM the hosting model requires — the Lambda is the cheap
trigger, the instance is the capable worker, and the loop's run-to-completion contract is the
entire integration seam.

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
  the concurrency check below, then launch. The Lambda never runs a task itself and holds no state
  between invocations.
- The Lambda needs board read access and a tightly scoped EC2 role — `ec2:RunInstances`,
  `ec2:TerminateInstances`, `ec2:CreateTags`, `ec2:DescribeInstances` and `iam:PassRole` for the VM
  instance-profile role — provisioned via Terraform alongside the launch template.

## VM launch-and-terminate mechanism

**Launch a fresh instance from the launch template per burst; the box terminates itself when the
loop is done** (not starting an instance that was left stopped, not Terraform create/destroy per
burst).

- **Launch from the launch template per burst — chosen.** Terraform owns the launch template; the
  Lambda calls `RunInstances` against it and tags the result with the supervisor tag. The template
  is configured to terminate on an instance-initiated shutdown and to delete the root volume with
  it, which is what makes the loop's own `poweroff` a full teardown — instance and disk both go.
  Between bursts there is nothing to pay for and nothing to drift.
- **Start an instance left stopped — rejected.** Keeping one instance created once and started per
  burst pays standing EBS (and any attached address) forever, keeps mutable state alive across
  bursts so the box drifts from `user_data`, and needs `ec2:StartInstances` plus a stable instance
  id in the Lambda's contract. Terminate-on-idle is strictly cheaper and strictly more
  reproducible.
- **Terraform create/destroy per burst — rejected.** Putting `terraform apply`/`destroy` on the
  hot path means the Lambda mutates infrastructure state on every burst: slow, race-prone against
  concurrent applies, and it drags the full IaC toolchain into a function that should only make one
  API call. Terraform owns the template; the Lambda cycles instances from it.

## VM lifecycle (per burst)

1. Lambda calls `RunInstances` from the launch template and tags the instance with the supervisor
   tag.
2. The instance boots and provisions itself from `user_data`, then runs the supervisor loop
   (`ff1bd2c1`) — e.g. a systemd oneshot / boot unit that invokes the `loop` entrypoint. The loop
   works the recommended set exactly as specified.
3. The loop **runs to completion and exits 0 with its summary** when no unattempted recommended
   task remains. That exit is the **only seam**: the boot unit waits on it and, on a clean exit,
   issues `poweroff`.
4. The launch template's terminate-on-shutdown behaviour turns that `poweroff` into a termination
   and takes the root volume with it. Cost between bursts is zero — no instance, no EBS, no
   address.

The loop's `asked_user` / `errored` outcomes need no special operating handling — they resolve on
the board (human turn, or surfaced error), the loop still exits 0 when nothing recommended remains,
and the instance terminates. The next scheduled Lambda re-evaluates the board fresh.

## Concurrency / idempotency — never double-spawn

There is no stable instance id to read any more, so the guard is a **tag scan**:

- Before launching, the Lambda calls `DescribeInstances` filtered on the supervisor tag and on
  instance states `pending`, `running`, `stopping` and `shutting-down`. It launches **only** on a
  zero-length result. A non-empty result means a burst is already in flight (or winding down) and
  will drain the board itself.
- **Lambda reserved concurrency 1** backs that up: two ticks cannot overlap in the first place, so
  the tag scan never races against another copy of itself.
- The board itself is the second line of defense: the runner **claims** each node, so even in a
  pathological double-spawn no node is worked twice. The tag scan and reserved concurrency prevent
  paying for two VMs; the claim prevents duplicated *work*.

This is a **single-worker v1 by design** — one instance draining the recommended set serially,
matching the loop's own serial, single-session model. Parallel workers are a scale concern for
later, not v1.

## TTL reaper — the hung-loop backstop

Terminate-on-idle means the **only** stop signal is the loop exiting cleanly. A loop that hangs
never exits, so it never powers off, so it bills until someone notices. That is the one failure
mode this model introduces that the old one did not have.

- The **same Lambda**, on the same tick, reaps: `DescribeInstances` on the supervisor tag already
  returns launch times, so before (or alongside) the spawn decision it calls `TerminateInstances`
  on any supervisor instance older than the TTL.
- No new infrastructure, no watchdog on the box, no extra schedule — it rides the tick that already
  exists.
- **Placeholder TTL: 2 hours**, env-tunable. The real number is tuned at implementation against
  observed burst length (`4f1d9719` owns interval/backoff tuning generally).

## Reconciliation

- **Hosting model (`hosting-model.md`, raw VM).** Fully consistent: the worker is a raw VM with
  full root, hosting the sessions exactly as decided. The Lambda is *operating* infrastructure
  (trigger + lifecycle), not a session host — it never runs a Claude Code session, so the
  "managed compute can't host sessions" rejection doesn't apply to it. Lambda triggering, VM
  hosting.
- **Lifecycle & rolling updates (`5039267c`, drain-then-replace).** No conflict, and deliberately
  minimal overlap for v1. Per-burst launch/terminate is orthogonal to drain-then-replace: draining
  is about swapping the *image/harness* under active sessions without killing them, which happens
  **while an instance is running**, not at launch or teardown. The seam is left open, not closed —
  when `5039267c` lands it plugs in at the same place (bring up a replacement instance, let the old
  one finish, retire it), and a baked image would just change what the launch template points at.

## Handoff notes — what this breaks down into

This node is **not** a `breakdown_on_merge` node — it records a call already made, and the
follow-on work is already split as the other children of `2f94026e` (Lambda function, Terraform for
the Lambda + schedule + scoped role + board-credential secret, spend guard, ci-apply IAM widening,
and the human-only board-account setup). See that node's children for the current list; do not
re-split from here.
