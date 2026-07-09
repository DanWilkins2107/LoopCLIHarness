# Soft-block pickup judgment decision

**Status:** Decided (v1)
**Decision:** **Automate it with an LLM judge, orchestrated by AgentJira — not by the
supervisor.** When the node(s) a soft-blocked task is set to *reassess after* reach `done`,
AgentJira moves that task into a new **`evaluating_soft_block`** status. That status is an agent
turn: the deterministic supervisor dispatches a **fresh, isolated, per-node headless "judge"
session** that reads the now-settled decisions plus the surrounding graph and returns a
structured verdict. AgentJira routes on the verdict — promote to `ready_for_pickup`, re-arm to
wait, or escalate to the human reviewer.

This node is a spike, not loop code. It decides the mechanism; it bakes nothing into the loop.
It `relates_to` the deterministic supervisor loop (`c312861e`) but is deliberately **not** a
firm block: the loop ships first over the clearly-recommended set, and this extends selection
later — via an AgentJira status the loop already knows how to read, not via new supervisor logic.

## The problem

`aj tasks` is the harness's source of truth for what to work. It already annotates every node
with its blockers and lists firm-blocked / already-claimed nodes in a "not recommended" section.
Soft-blocked nodes land in that same "not recommended" bucket — visible, but flagged.

A soft block is a **shared decision**: node B is soft-blocked on A when A is settling something
B depends on (a shape, a convention, an interface). The rulebook's guidance to a picker is
judgment, not a constraint — pick up soft-blocked work *only* when you have nothing else to do,
and *only* when proceeding isn't a stretch. "A stretch" has a precise meaning here: if
proceeding requires guessing at decisions the blocker will make, leave it.

The question this node answers: **how does the harness make that judgment call without a human
doing it by hand each time?** A human picker reads A's thread and decides "settled enough". We
want to reproduce "the blocker's shared decisions are settled enough that proceeding isn't a
guess" — and to do it with an LLM, not a human, because a session that reads the surrounding
graph can form the **bigger long-term picture** a per-ticket human glance misses.

## The hard constraint — and where the judgment actually lives

From the human's `split_decision` on the loop subtree: **the supervisor is deterministic plain
code with no growing context.** It reads `aj tasks --json`, dispatches a disposable session per
task, acts on the outcome, and repeats. It is not an agent and must never accumulate context or
reason with an LLM in-process.

That constraint binds the **supervisor** — it does not forbid the *system* from making an
LLM-shaped judgment. The reviewer's steer resolves the apparent tension by splitting the work
across three layers, each staying within its remit:

- **AgentJira (the board)** owns the *state*. It gains a new status, `evaluating_soft_block`, and
  a *reassess-after* trigger on soft-blocked nodes. When the trigger fires, AgentJira flips the
  node into `evaluating_soft_block` and, on the verdict coming back, routes it onward. This is
  data and a state machine — no reasoning, no growing context.
- **The supervisor** stays exactly as specified: it reads `aj tasks --json`, sees an
  `evaluating_soft_block` node as an agent turn, and dispatches a session for it — the same way
  it dispatches a runner session for a `ready_for_pickup` node. It never inspects the decision;
  it only sees a status and, later, an opaque outcome.
- **The judge session** does the reasoning. It is a **fresh, isolated, per-node headless
  session** — the same disposable shape as the single-session runner: spawned, given exactly one
  candidate, reads context, emits a structured verdict, dies. No long-lived stateful judge ever
  exists.

So the LLM judgment is real and lives in v1, but it never touches the supervisor's loop. It is a
new *board state* serviced by a *throwaway session* — which is also, deliberately, a first slice
of the reviewer role moving off the human: today the human eyeballs whether a soft-blocked node
is safe to start; the judge session takes that call, with the human left as the escalation
backstop and progressively offloaded from there.

## Options weighed

### (a) Deterministic-only heuristic

Plain code decides eligibility with no LLM — e.g. promote a soft-blocked node the moment its
blocker is `done`, or when a human attaches an explicit "ok to proceed" tag/edge.

- **Fit to the constraint** — Perfect: it *is* plain code, no session.
- **Weakness** — It doesn't actually judge. Auto-promoting on "blocker `done`" makes no
  settledness assessment at all — it can't tell a settled decision from an unsettled one, and it
  can't weigh the bigger-picture fit the reviewer explicitly wants. A human "ok to proceed" tag is
  just human picking with extra steps. Rejected.

### (b) LLM judge session, triggered on reassess-after and orchestrated by AgentJira — **chosen**

For each soft-blocked node, AgentJira records a **reassess-after** set: the node(s) whose
completion means "there is now enough new information to re-judge this." When every node in that
set reaches `done`, AgentJira moves the soft-blocked node into `evaluating_soft_block`. The
supervisor dispatches a fresh headless judge session; the judge runs `aj context` on the
settled node(s), reads their decisions and thread plus the surrounding graph, and returns a
structured verdict (`proceed` / `not_yet` / `escalate`, each with a one-line reason). AgentJira
routes on it.

- **Fit to the constraint** — Clean. Reasoning lives in a disposable session; the supervisor
  stays deterministic and only ever sees a status and an outcome; the board only ever stores
  state. No growing context anywhere.
- **Why it wins** — It is the only option that *actually judges* settledness, it uses an LLM (the
  reviewer's explicit want), it reads wide enough to get the long-term picture, and its trigger
  is event-driven — so it evaluates when something concrete changed, not on a poll. The cost
  (a new status, a judge prompt contract, a structured-output schema, a reassess-after field) is
  real but bounded, and most of it is AgentJira surface rather than loop code.

### (c) Defer — soft-blocks stay human-picked for v1

The supervisor works only the clearly-recommended set; soft-blocked nodes stay human-picked until
the automation proves its worth.

- **Fit to the constraint** — Trivially satisfied: nothing new runs.
- **Weakness** — It leans on human intervention indefinitely, which is precisely what the
  reviewer wants *off* the critical path — the value here is the system forming a bigger-picture
  judgment automatically, and deferral forecloses exactly that. Rejected as the v1 direction (it
  remains the trivial fallback if the judge is ever unavailable). Rejected.

### One-line reason per rejected option

- **(a) Deterministic-only heuristic:** cheap but blind — promoting on "blocker `done`" makes no
  settledness judgment and can't weigh the bigger picture the reviewer wants.
- **(c) Defer:** keeps a human on the critical path indefinitely, which is the thing we are
  trying to automate away — not the v1 direction.

## v1 recommendation

**Build (b): the reassess-after → `evaluating_soft_block` → judge-session pipeline.** Concretely:

1. **Reassess-after trigger (AgentJira).** A soft-blocked node carries a reassess-after set of
   node ids. Default it to the node's soft-block blocker(s); allow it to be set explicitly so the
   human can point it at the specific decision node that settles the question rather than the whole
   downstream subtree. Because decisions in this graph are *their own nodes* (this doc is one),
   "reassess after node X is `done`" fires precisely when the decision is settled — which is the
   right signal, and is *not* the same as waiting for a big implementation blocker to finish.
2. **`evaluating_soft_block` status (AgentJira).** When every node in the reassess-after set is
   `done`, the board moves the node from its waiting state into `evaluating_soft_block`, an
   **agent-turn** status. It surfaces in `aj tasks` as agent-actionable, like any other agent turn.
3. **Judge session (supervisor dispatches, session reasons).** The supervisor dispatches a fresh
   headless judge scoped to that one node. The judge reads the settled node(s) and enough of the
   surrounding graph to form the bigger-picture call, and returns a structured verdict. It
   **reads only** — never claims, edits, or posts.
4. **Verdict routing (AgentJira).**
   - `proceed` → node advances to `ready_for_pickup` (or `awaiting_agent_spec` if it still needs a
     spec). From here it is ordinary work.
   - `not_yet` → node returns to waiting, **re-armed** against the next reassess-after completion
     (see "Not looping forever"). A one-line reason is posted to the thread.
   - `escalate` → node goes to `awaiting_human_response` for the human reviewer to decide.

This keeps the human as the **reviewer/backstop** for v1 — the judge only decides the clear
cases and escalates the rest — and leaves a clean path to offload more of that review to the
judge as confidence grows (widen what counts as an autonomous `proceed`, narrow `escalate`).

Chosen **for the reviewer's stated direction over leanness**: it is more machinery than deferral,
but the machinery is where the harness earns its long-term value — an automated, bigger-picture
judgment — and it is contained to a new board status plus a disposable session, touching no
supervisor logic.

## Not looping forever

The spec review flagged termination, and it is the sharpest question for an automated judge. The
reassess-after trigger is itself the primary guard, backed by three more:

- **Event-driven, never polled.** A judge runs only when a reassess-after set *transitions* to
  fully `done` — a discrete event, not an every-tick check. An idle loop with no completions
  spawns zero judges.
- **One judge per settlement.** A `not_yet` verdict re-arms the node against the *next*
  reassess-after completion, not an immediate re-judge. The node cannot be re-evaluated until
  something in its trigger set actually changes again, so an empty board never re-spawns the same
  judge to reach the same `not_yet`.
- **Escalation is a terminator, not a retry.** A judge that is unsure returns `escalate`, which
  hands to a human (`awaiting_human_response`) — it does not loop. A judge crash or malformed
  verdict is treated as `escalate` (or `not_yet` + re-arm), never as an automatic retry storm.
- **A `proceed` must make progress, enforced by the claim.** A promoted node is claimed and run
  like any other; its outcome moves it out of the soft-blocked bucket exactly as the
  recommended-set path does. It cannot be promoted, dropped, and re-promoted in a tight cycle,
  because the claim and outcome-handling already prevent that for every node.

## Handoff notes

- **To AgentJira (the board itself):** this decision asks for two additions — a
  `evaluating_soft_block` status (agent turn, sitting between a soft-blocked node's waiting state
  and `ready_for_pickup`, with `not_yet`→waiting and `escalate`→`awaiting_human_response`
  transitions), and a **reassess-after** field on soft-blocked nodes (default: the soft-block
  blocker(s); overridable to an explicit node set). The reassess-after → `evaluating_soft_block`
  transition fires when the set is fully `done`. Both are board-side; neither touches the loop.
- **To `c312861e` (deterministic supervisor loop):** build v1 against the recommended set only.
  The one forward-looking requirement: treat `evaluating_soft_block` as an agent-turn status that
  dispatches a **judge** session type (read-only, returns a structured verdict) instead of the
  runner. Keep task selection a distinct step from session dispatch so this second session type
  slots in without reshaping the loop. The supervisor still only reads a list and dispatches
  disposable sessions — it never reads or applies the verdict; AgentJira does.
- **To `4f1d9719` (rate-limit / idle-backoff):** judge sessions are ordinary sessions and count
  against the same spend/rate budget — include `evaluating_soft_block` dispatches in whatever
  concurrency and backoff accounting you define. There is no separate judge poll to bound; the
  reassess-after event is the only thing that creates judge work.
- **When to revisit:** once the judge is running, tune the `proceed` / `escalate` boundary from
  observed outcomes — the intended trajectory is to widen autonomous `proceed` and shrink
  `escalate` as the judge proves reliable, moving more of the reviewer's load off the human.
