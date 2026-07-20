# Cost model

**Status:** Decided (v1)
**Decision:** At v1 scale the infra envelope is **small and dominated by the raw VM** — order
**$10–65/month** depending on operating mode and provider — and is dwarfed by the **flat Claude
Max-plan subscription** (a separate, non-infra envelope, ~$100–200/month, not API-metered).
Run the harness on **mode (c): poll-triggered auto spin-up/spin-down** — a near-free always-on
poller boots the VM only when the board has agent-turn work and stops it when idle — so the one
infra line the lifecycle lever moves (the VM) is billed only during real sessions.

**Synthesises three settled picks** — it re-opens none of them:

- [`hosting-model.md`](./hosting-model.md) — host each session on a **raw VM** (provider-agnostic
  Linux instance, Terraform IaC). The VM is the dominant infra line and the **only** one the
  spin-up/spin-down lever moves.
- [`network-isolation.md`](./network-isolation.md) — a **host-local** egress proxy (same VM, no
  managed NAT/proxy service) → no added *service* cost; the only additive line is **off-box log
  storage**.
- [`credential-flow.md`](./credential-flow.md) — the attached instance role is **free** and the
  broker adds **no new box**; the additive lines are a **secrets manager**, **KMS**, and
  **per-session token-mint calls**.

All figures below are **illustrative and provider-agnostic**: ranges, not quotes. Each shows the
assumption behind it rather than pretending at precision. Example providers (EC2 / GCE / Hetzner /
DigitalOcean) are named the way the sibling docs name them.

## v1 scale assumptions (stated up front)

- **One sandbox on one box.** A single VM, not a fleet (fleet is the hosting doc's likely v2).
- **A solo operator.** One human, one AgentJira board.
- **Intermittent sessions.** Bursty — minutes-to-hours of active agent work, not 24/7 saturation.
  For the session-metered figures below the illustrative load is **~40–80 session-hours/month**
  (e.g. a couple of active hours on most days, idle otherwise). Substitute your own number; the
  line scales linearly.
- **Two separate envelopes.** *Infra* (the VM and its managed-service lines) and the *flat
  Max-plan model cost* are kept apart throughout — they scale on different axes and one is not a
  substitute for the other.

## Cost line items (each tied to the decision it comes from)

### Compute — the raw VM (`hosting-model.md`)

The dominant infra line, and the **only** line the spin-up/spin-down lever moves. Sizing: a
box that runs a Claude Code session plus the host-local proxy and credential broker — call it
**~2 vCPU / 8 GB** illustratively.

| Basis | Illustrative figure | Assumption |
|---|---|---|
| Per session-hour | **~$0.05–0.10/hr** | on-demand 2 vCPU / 8 GB (EC2 `t3.large` ~$0.083/hr, GCE `e2-standard-2` ~$0.067/hr; budget hosts lower) |
| Always-on / month | **~$15–60/mo** | 730 hrs × the above; budget flat-rate hosts (Hetzner/DO-class) sit at the **~$15–30** floor, hyperscaler on-demand nearer **~$45–60** |
| Session-metered / month | **~$3–8/mo** | ~40–80 session-hrs × per-hour rate — what modes (b)/(c) actually bill for the VM |

Budget caveat: some flat-rate hosts (e.g. Hetzner) bill largely per-month regardless of uptime,
so spin-down saves less on them than on per-second-metered hyperscalers — the lever's savings are
biggest exactly where the always-on baseline is highest.

### Network isolation (`network-isolation.md`)

The egress proxy is a **host-local daemon on the same VM** — tens of MB RAM, negligible CPU at
solo request volume — so it adds **no managed service** and **no new billable compute**; it folds
into the VM baseline above. Firewall / security-group rules are **free** (native cloud + host
config). The only genuinely additive line:

- **Off-box log storage** — the proxy's request log shipped to durable object storage. A few GB/mo
  at ~$0.02–0.03/GB-mo → **cents/month**, growing slowly over time. Call it **<$1/mo** at v1.
- **Data egress** — three HTTPS hosts, mostly model request/response text; a few GB/mo at
  ~$0.09/GB → **<$1/mo**. Minor.

### Credential flow (`credential-flow.md`)

The attached instance role is **free** (it is IAM, not a resource), and the broker is co-located
with the proxy on the same VM — **no new box**. The real additive lines:

| Line | Illustrative figure | Assumption |
|---|---|---|
| **Secrets manager** | **~$0.80/mo** | 2 stored secrets (Claude Max OAuth token + GitHub App key) at ~$0.40/secret-mo; per-access API charges negligible at solo session volume |
| **KMS** | **~$1/mo** | 1 customer key at ~$1/key-mo; per-decrypt (~$0.03/10k ops) negligible |
| **Per-session token-mint calls** | **~$0** | STS-style / OIDC token exchange and the GitHub App-key → installation-token exchange are **free** on the common providers; volume scales with session count/length but priced at zero here. Flagged as a watch-item only if a chosen provider meters token exchange |

Credential envelope: **~$2/mo**, essentially **mode-independent** (driven by stored secrets and
session count, not VM uptime).

### Claude subscription — the Max plan (separate envelope)

The operator's **Max plan** is a **flat monthly subscription** — illustratively **~$100–200/mo**
(Claude Max 5× / 20× tiers) — and it is the **single largest recurring line**. It is
**independent of infra** and **not API-metered at v1**: running the VM more or less does not move
it. This is the whole point of keeping two envelopes — the model cost is a fixed subscription, the
infra cost is what the operating-mode decision below actually optimises.

*(v2 note: the credential doc's model-gateway path would move Claude onto **per-token API billing**
— trading this flat line for a metered one. A cost swing to weigh deliberately if v2 is taken; not
v1.)*

### Storage

A small root volume (~20–30 GB) at ~$0.08/GB-mo → **~$2/mo**. Note it persists (and bills) even
while a stopped VM isn't running, so it is **mode-independent**. Minor.

## The lifecycle lever — three operating modes

Only the **VM line** differs across modes; the secrets-manager / KMS / mint, log-storage, and
root-volume lines are **largely mode-independent** (~$4–6/mo fixed). The flat Max-plan line is
identical across all three.

### (a) Always-on 24/7 VM

Simplest — no lifecycle machinery at all. Bills the VM for **every hour of the month** whether or
not a session runs.

- **VM:** ~$15–60/mo (from the always-on row above).
- **Tradeoff:** zero operational complexity and zero spin-up latency, but you pay for ~720 idle
  hours you don't use under intermittent load.

### (b) Manual spin-up / spin-down

Operator starts the VM before a work burst and stops it after. Pays the VM **only during real
sessions**.

- **VM:** ~$3–8/mo (session-metered row).
- **Tradeoff:** big VM saving, but it **relies on the human remembering** to start/stop, and adds
  **~1–2 min cold spin-up latency** at the start of each burst. No new infra to build.

### (c) Poll-triggered auto spin-up / spin-down

A tiny **always-on poller** (a scheduled lambda / cron firing every few minutes) polls the
**AgentJira board** — the Supabase-backed task graph — via `aj tasks` for available agent-turn
work, and **boots the VM only when work exists**, draining and stopping it once idle. This is the
review's "poll the Supabase instance to decide when the EC2 box runs" idea, made concrete: the
poller reads the board (Supabase) and drives the cloud start/stop API on the VM (e.g. EC2).

- **VM:** ~$3–8/mo (session-metered — same as (b)).
- **Poller:** **negligible** — a lambda fired every few minutes is **~8–9k tiny invocations/mo**,
  comfortably within free tier / **pennies**.
- **Moving parts to stand up (each cheap, but real):**
  - **Read-only board credentials** for the poller (see the credential doc's agent identity),
    scoped to *read* `aj tasks` and nothing else.
  - **Cloud API rights** scoped to **start/stop just this one VM** — nothing broader.
  - An **idle-detection signal** to trigger spin-down. This is the genuinely fiddly bit: it must
    honour the hosting doc's **drain-then-replace** — let in-flight sessions finish and only stop
    once **truly idle**, never mid-task.
- **Tradeoff, stated explicitly:** **~1–2 min spin-up latency** before the first task of a burst
  starts, and the one-time cost of building idle-detection — **versus** paying VM cost **only
  during real sessions with no human in the loop**.

### Rough monthly totals per mode (illustrative)

Infra envelope only; the flat **Max plan (~$100–200/mo)** sits on top of all three, unchanged.

| Mode | VM | + mode-independent lines | **Infra total** |
|---|---|---|---|
| (a) Always-on 24/7 | ~$15–60 | ~$4–6 | **~$20–65/mo** |
| (b) Manual spin-up/down | ~$3–8 | ~$4–6 | **~$8–14/mo** |
| (c) Poll-triggered auto | ~$3–8 (+ ~$0–1 poller) | ~$4–6 | **~$8–15/mo** |

## v1 recommendation — across the three modes

**Adopt mode (c), poll-triggered auto spin-up/spin-down** — with **(b) manual as the acceptable
fallback** and **(a) always-on as the do-nothing baseline**.

Reasoned, not asserted:

- **Why (c) over (a).** Under intermittent load the VM is the dominant infra line and idle for
  ~90% of the month; (c) bills it only when the board has work, cutting the VM line ~5–10×
  (~$15–60 → ~$3–8). The poller that buys this is **near-free**, so the infra saving is almost
  pure upside.
- **Why (c) over (b).** Both bill the VM only during sessions, but (b) depends on the operator
  **remembering** to start/stop — brittle for a looped, async harness — whereas (c) removes the
  human from the loop entirely, which is the whole point of a looping agent runner.
- **Against its two honest costs.** (1) **~1–2 min spin-up latency** — acceptable for async agent
  work, where a task waiting a minute to begin is invisible. (2) **Idle-detection** is real
  engineering, but it is **already required** by the hosting doc's drain-then-replace lifecycle
  (node `5039267c`) — (c) reuses that signal rather than inventing a new cost.
- **The honest caveat on magnitude.** Because the flat Max plan (~$100–200/mo) **dwarfs** the
  whole infra envelope, (c)'s absolute saving over (a) is only **~$15–55/mo** against a
  ~$100–200/mo model bill — infra optimisation is a *small* fraction of total spend. So the case
  for (c) rests less on the dollars saved and more on **fit**: it matches the intermittent,
  human-out-of-the-loop usage pattern and is cheap to build. If idle-detection proves too fiddly
  to land at v1, **fall back to (b)**; the absolute premium of even **(a) always-on** over (c) is
  small in the context of the total bill, so none of the three is a *wrong* answer — (c) is simply
  the best-fit one.

**Bottom line:** v1 total ≈ **flat Max plan (~$100–200/mo, separate envelope) + a small infra
envelope of ~$8–15/mo under the recommended mode (c)**. Infra is a rounding error next to the
model subscription; spend the optimisation effort on (c) because it fits the workload and costs
almost nothing to run, not because it saves a large fraction of the total.
