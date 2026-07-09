# Soft-block pickup judgment decision

**Status:** Decided (v1)
**Decision:** **Defer.** For v1 the supervisor loop picks up **only** the CLI's
clearly-recommended set; soft-blocked nodes stay human-picked. The recommended *eventual*
mechanism, when we do automate it, is a **fresh per-candidate headless "judge" session** — never
a long-lived stateful supervisor.

This node is a spike, not loop code. It decides the mechanism; it bakes nothing into the loop.
It `relates_to` the deterministic supervisor loop (`c312861e`) but is deliberately **not** a
firm block: the loop ships first over the clearly-recommended set, and this extends selection
later.

## The problem

`aj tasks` is the harness's source of truth for what to work. It already annotates every node
with its blockers and lists firm-blocked / already-claimed nodes in a "not recommended" section.
Soft-blocked nodes land in that same "not recommended" bucket — visible, but flagged.

A soft block is a **shared decision**: node B is soft-blocked on A when A is settling something
B depends on (a shape, a convention, an interface). The rulebook's guidance to a picker is
judgment, not a constraint — pick up soft-blocked work *only* when you have nothing else to do,
and *only* when proceeding isn't a stretch. "A stretch" has a precise meaning here: if
proceeding requires guessing at decisions the blocker will make, leave it.

The question this node answers: **how does a stateless harness make that judgment call?** A
human picker reads A's thread and decides "settled enough". The supervisor has no eyes and no
memory. We need a mechanism that reproduces "the blocker's shared decisions are settled enough
that proceeding isn't a guess" — or a defensible reason to not try yet.

## The hard constraint

From the human's `split_decision` on the loop subtree: **the supervisor is deterministic plain
code with no growing context.** It reads `aj tasks --json`, invokes the runner, acts on the
outcome, and repeats. It is not an agent and must never accumulate context or reason with an LLM
in-process.

This is load-bearing for the options below. Judging whether a soft block is settled is a
reading-comprehension task over A's decisions and thread — inherently LLM-shaped. So any
mechanism that needs reasoning **must run as a fresh, isolated, per-task headless session** (the
same shape as the single-session runner): spawned, given exactly one candidate, returns a
verdict, dies. It may never live inside the supervisor as a stateful judge.

## Options weighed

### (a) Deterministic-only heuristic

Plain code in the supervisor decides eligibility with no LLM — e.g. promote a soft-blocked node
into the recommended set only when its blocker is `done`, or when a human has attached an
explicit "ok to proceed" tag/edge.

- **Fit to the constraint** — Perfect: it *is* plain code, no context, no session.
- **Weakness** — It doesn't actually answer the question. "Blocker is `done`" collapses a soft
  block into a firm block (wait for completion), throwing away the entire point of a soft
  block, which is that you *can* proceed before the blocker finishes when the relevant decision
  is settled. A settled decision is usually reached long before the blocker node is `done`. And
  a human "ok to proceed" tag is just human picking with extra steps — the human made the
  judgment, not the harness.

### (b) Fresh per-candidate headless "judge" session

For each soft-blocked candidate the supervisor would otherwise skip, spawn a **fresh headless
session** scoped to exactly that candidate. It runs `aj context` on the blocker, reads the
blocker's decisions and thread, and returns a structured yes/no (+ one-line reason). The
supervisor treats the verdict as opaque data: `yes` → add to the work set; `no` → leave it.

- **Fit to the constraint** — Clean. The reasoning lives in a disposable session, exactly like
  the runner; the supervisor stays deterministic plain code and only ever sees a boolean. No
  growing context anywhere.
- **Weakness** — It is real cost and real machinery: a second session type, a prompt contract, a
  structured-output schema, and a spend/latency budget for judging work that, by definition, was
  already deprioritised. It is the *right* long-term shape but not obviously worth building
  before the loop has even shipped its recommended-set path.

### (c) Defer — soft-blocks stay human-picked for v1

The supervisor works only the clearly-recommended set. Soft-blocked nodes remain in the "not
recommended" bucket and are picked up by humans (or by an explicit human hand-off) until we have
evidence the automation is worth it.

- **Fit to the constraint** — Trivially satisfied: nothing new runs.
- **Weakness** — Soft-blocked work waits on a human. Given these are *already* the
  deprioritised, judgment-heavy tail, that is an acceptable v1 gap rather than a real loss.

## v1 recommendation

**Defer (c), with (b) as the named v2.** Ship the loop over the clearly-recommended set first;
keep soft-blocks human-picked. This is chosen **for leanness, reversible over optimal**, the same
posture as the hosting decision:

- The clearly-recommended set is where the loop earns its keep. Soft-blocked nodes are the
  deprioritised tail *by construction* — the rulebook already says only pick them up with nothing
  else to do. Automating the tail before the trunk ships is inverted priority.
- (a) is rejected as a false economy — it's cheap but answers the wrong question, degrading a
  soft block into a firm one or into disguised human picking.
- (b) is the correct mechanism and the explicit v2, but it is net-new session machinery whose
  value is unproven until the loop is running and we can see how often soft-blocked work actually
  starves. Deferring keeps it fully reversible: nothing about shipping the recommended-set loop
  now forecloses adding a judge session later.

### One-line reason per rejected option

- **(a) Deterministic-only heuristic:** cheap but wrong — "blocker `done`" is just a firm block,
  and a human "proceed" tag is just human picking, so it never actually judges settledness.
- **(b) Judge session now:** the right long-term shape, but net-new session machinery whose value
  is unproven before the loop has even shipped its recommended-set path — hold it as v2.

## How this feeds the supervisor loop (`c312861e`)

`c312861e` is a stateless daemon that reads the next task from `aj tasks --json` — the CLI's
deterministic, block-aware recommended set — and works it. Under this decision, **that contract
is unchanged for v1**: the supervisor consumes only the recommended set and never looks at the
"not recommended" bucket. No soft-block code ships in the loop.

The v2 extension slots in without disturbing that contract: between "read `aj tasks --json`" and
"invoke the runner", the supervisor gains an optional pass that, *only when the recommended set is
empty*, takes each soft-blocked candidate and spawns a judge session (b); a `yes` verdict
promotes that node into the work set for this iteration. The supervisor still only ever sees a
deterministic list plus opaque booleans — no growing context, no in-process reasoning.

## Not looping forever

The human review flagged the termination question, and it matters most for the v2 judge path, so
name the guards now so v2 inherits them rather than rediscovering them:

- **Idle/empty is a stop, not a spin.** The v1 loop already needs an idle-backoff when the
  recommended set is empty (sibling `4f1d9719`). The judge pass is gated on *that same emptiness*:
  it only runs when there is nothing recommended, and if it also yields no `yes`, the iteration
  ends and the loop backs off. It never busy-loops re-judging.
- **Judge each candidate at most once per settlement.** A `no` verdict must be cached against the
  blocker's current state (e.g. the blocker's last-updated timestamp / thread length). Re-judging
  the same candidate is only allowed after the blocker has actually changed. Without this, an
  empty recommended set would re-spawn the same judge sessions every backoff tick — burning spend
  to reach the same `no`.
- **A judge `yes` must make progress, and a claim enforces it.** A promoted node is claimed and
  run like any other; its outcome (completed / asked-the-user / errored) moves it out of the
  soft-blocked bucket exactly as the recommended-set path does. It cannot be picked, deferred, and
  re-picked in a tight cycle, because the claim and the outcome-handling already prevent that for
  every node.
- **The judge reads, it does not act.** A judge session only returns a verdict; it never claims,
  edits, or posts. That keeps its cost bounded and its failure mode safe — a judge crash or a
  malformed verdict is treated as `no` (skip), never as a retry storm.

## Handoff notes

- **To `c312861e` (deterministic supervisor loop):** build v1 against the recommended set only —
  do **not** implement soft-block handling. Leave the selection input as `aj tasks --json`'s
  recommended set. The one forward-looking hook to preserve: keep task selection a distinct step
  from runner invocation, so a v2 judge pass can be inserted between them without reshaping the
  loop.
- **To `4f1d9719` (rate-limit / idle-backoff):** the v2 judge pass is gated on the same
  "recommended set empty" condition your backoff triggers on. When you define that idle
  condition, make it queryable/reusable so the future judge pass can hang off it rather than
  re-deriving emptiness.
- **When to revisit:** promote (b) from v2 to built once the loop is running and we observe
  soft-blocked nodes materially starving for human attention. Until there's that evidence, the
  judge session is unbuilt on purpose.
