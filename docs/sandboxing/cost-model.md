# Cost model

**Status:** Decided (v1)
**Decision:** On **AWS** at v1 scale the infra envelope is **small and dominated by the EC2
instance** — order **$7–66/month** depending on operating mode — and is dwarfed by the **flat
Claude Max-plan subscription** (a separate, non-infra envelope, ~$100–200/month, not API-metered).
Run the harness on **mode (c): poll-triggered auto spin-up/spin-down** — the EventBridge + Lambda
supervisor of [`../loop/lambda-vm-supervisor.md`](../loop/lambda-vm-supervisor.md) starts the
instance only when the board has agent-turn work and it stops itself when idle — so the one infra
line the lifecycle lever moves (EC2) is billed only during real sessions.

**Synthesises three settled picks** — it re-opens none of them:

- [`hosting-model.md`](./hosting-model.md) — host each session on a **raw VM**, instantiated on
  AWS as a single **EC2 instance** (Terraform IaC). EC2 is the dominant infra line and the
  **only** one the spin-up/spin-down lever moves.
- [`network-isolation.md`](./network-isolation.md) — a **host-local** egress proxy (on the same
  instance, no NAT Gateway, no managed proxy service) → no added *service* cost; the only
  additive line is **off-box log storage in S3**. Security groups are free.
- [`credential-flow.md`](./credential-flow.md) — the attached **EC2 instance profile / IAM role**
  is free and the broker adds **no new box**; the additive lines are **Secrets Manager**, **KMS**,
  and **per-session STS token-mint calls**.

Provider is **settled: AWS**. The sibling docs are written provider-agnostically by design; the
figures below instantiate them on AWS with **us-east-1 on-demand list prices**. They are still
**illustrative ranges, not quotes** — each shows the assumption behind it rather than pretending
at precision, and region/RI/Savings-Plan choices move them.

## v1 scale assumptions (stated up front)

- **One sandbox on one instance.** A single EC2 instance, not an ASG or fleet (fleet is the
  hosting doc's likely v2).
- **A solo operator.** One human, one AgentJira board.
- **Intermittent sessions.** Bursty — minutes-to-hours of active agent work, not 24/7 saturation.
  For the session-metered figures below the illustrative load is **~40–80 session-hours/month**
  (e.g. a couple of active hours on most days, idle otherwise). Substitute your own number; the
  line scales linearly.
- **Two separate envelopes.** *Infra* (AWS) and the *flat Max-plan model cost* are kept apart
  throughout — they scale on different axes and one is not a substitute for the other.

## Cost line items (each tied to the decision it comes from)

### Compute — the EC2 instance (`hosting-model.md`)

The dominant infra line, and the **only** line the spin-up/spin-down lever moves. Sizing: a box
that runs a Claude Code session plus the host-local proxy and credential broker — call it
**`t3.medium` (2 vCPU / 4 GB)** as the floor and **`t3.large` (2 vCPU / 8 GB)** as the
comfortable pick.

| Basis | Illustrative figure | Assumption |
|---|---|---|
| Per session-hour | **~$0.04–0.08/hr** | us-east-1 on-demand: `t3.medium` ~$0.0416/hr, `t3.large` ~$0.0832/hr |
| Always-on / month | **~$30–61/mo** | 730 hrs × the above (`t3.medium` ~$30, `t3.large` ~$61) |
| Session-metered / month | **~$2–7/mo** | ~40–80 session-hrs × per-hour rate — what modes (b)/(c) actually bill for EC2 |

EC2 is billed **per second while running**; a *stopped* instance bills **$0 of compute** (its EBS
volume still bills — see Storage). That is exactly why the lifecycle lever is worth pulling on
AWS, and why the saving here is larger than it would be on a flat-rate monthly host.

A 1-year Savings Plan / Reserved Instance would cut the always-on figure ~30–40%, but it
**commits to 24/7 spend** — the opposite of the recommended mode. Not taken at v1.

### Network isolation (`network-isolation.md`)

The egress proxy is a **host-local daemon on the same instance** — tens of MB RAM, negligible CPU
at solo request volume — so it adds **no managed service** and **no new billable compute**; it
folds into the EC2 baseline above. **Security groups are free**, and the design deliberately
avoids a **NAT Gateway** (which would add ~$32/mo plus $0.045/GB — comparable to the whole rest of
the infra envelope). The only genuinely additive lines:

- **S3 log storage** — the proxy's request log shipped off-box. A few GB/mo of S3 Standard at
  ~$0.023/GB-mo plus trivial PUT charges → **cents/month**, growing slowly. Call it **<$1/mo** at
  v1; a lifecycle rule to Glacier/expiry keeps it there.
- **Data transfer out** — three HTTPS hosts, mostly model request/response text. AWS gives
  **100 GB/mo egress free**, and solo session volume sits well under it → **~$0/mo**. Beyond the
  free tier it is $0.09/GB.

### Credential flow (`credential-flow.md`)

The **EC2 instance profile / IAM role** is free (IAM is not a billed resource), and the broker is
co-located with the proxy on the same instance — **no new box**. The real additive lines:

| Line | Illustrative figure | Assumption |
|---|---|---|
| **Secrets Manager** | **~$0.80/mo** | 2 stored secrets (Claude Max OAuth token + GitHub App key) at $0.40/secret-mo; API calls at $0.05/10k are negligible at solo volume |
| **KMS** | **~$1/mo** | 1 customer-managed key at $1/key-mo; requests at $0.03/10k negligible. Using the AWS-managed key instead makes this **$0** |
| **STS token mints** | **$0** | `AssumeRole` / instance-metadata credential fetches are **free**; the GitHub App-key → installation-token exchange is a GitHub API call, also free. Scales with session count/length but priced at zero |

Credential envelope: **~$1–2/mo**, essentially **mode-independent** (driven by stored secrets, not
instance uptime — Secrets Manager and KMS bill whether or not the instance is running).

### Claude subscription — the Max plan (separate envelope)

The operator's **Max plan** is a **flat monthly subscription** — illustratively **~$100–200/mo**
(Claude Max 5× / 20× tiers) — and it is the **single largest recurring line**. It is
**independent of AWS spend** and **not API-metered at v1**: running the instance more or less does
not move it. This is the whole point of keeping two envelopes — the model cost is a fixed
subscription, the infra cost is what the operating-mode decision below actually optimises.

*(v2 note: the credential doc's model-gateway path would move Claude onto **per-token API billing**
— trading this flat line for a metered one, and if routed via Bedrock it would land inside the AWS
bill rather than beside it. A cost swing to weigh deliberately if v2 is taken; not v1.)*

### Storage

A small **EBS gp3** root volume (~20–30 GB) at $0.08/GB-mo → **~$1.60–2.40/mo**. It bills
**while the instance is stopped as well as running**, so it is **mode-independent**. Minor, but it
is the reason a "stopped" instance is not literally free.

## The lifecycle lever — three operating modes

Only the **EC2 line** differs across modes; Secrets Manager / KMS / STS, S3 logs, and the EBS root
volume are **largely mode-independent** (~$4–5/mo fixed). The flat Max-plan line is identical
across all three.

### (a) Always-on 24/7 instance

Simplest — no lifecycle machinery at all. Bills EC2 for **every hour of the month** whether or not
a session runs.

- **EC2:** ~$30–61/mo (from the always-on row above).
- **Tradeoff:** zero operational complexity and zero spin-up latency, but you pay for ~700 idle
  hours you don't use under intermittent load.

### (b) Manual spin-up / spin-down

Operator runs `aws ec2 start-instances` before a work burst and `stop-instances` after. Pays EC2
**only during real sessions**.

- **EC2:** ~$2–7/mo (session-metered row).
- **Tradeoff:** big EC2 saving, no new infra to build, but it **relies on the human remembering**
  to start/stop, and adds **~1–2 min cold spin-up latency** at the start of each burst.

### (c) Poll-triggered auto spin-up / spin-down — the decided architecture

This is no longer hypothetical: [`../loop/lambda-vm-supervisor.md`](../loop/lambda-vm-supervisor.md)
decides it. An **EventBridge cron** fires a small **Lambda** every few minutes; the Lambda reads
the AgentJira board (Supabase-backed) via `aj tasks --json` and calls `ec2:StartInstances` **only**
when unattempted recommended work exists and no supervisor instance is already running. The
instance runs the supervisor loop to completion and **stops itself** on exit-0-when-idle. This
doc's job is only to price it.

- **EC2:** ~$2–7/mo (session-metered — same as (b)).
- **Lambda + EventBridge:** **~$0** — every-5-minutes is ~8.6k sub-second invocations/mo against
  a 1M-request / 400k GB-s free tier; **EventBridge scheduled rules are free**. Even off free tier
  it is **pennies**.
- **Moving parts (each cheap, but real):**
  - **Read-only board credentials** for the Lambda (see the credential doc's agent identity),
    scoped to *read* `aj tasks` and nothing else — stored as a third Secrets Manager secret if
    kept there (+$0.40/mo).
  - **IAM rights** scoped to `ec2:StartInstances` on **just this instance** — nothing broader.
  - An **idle-detection signal** for spin-down. Cheapest on AWS because the loop already provides
    it: exit-0-when-idle, with the instance stopping itself — no extra polling service to pay for,
    and it honours the hosting doc's **drain-then-replace** (never stop mid-task).
- **Tradeoff, stated explicitly:** **~1–2 min spin-up latency** before the first task of a burst
  starts, plus the one-time cost of wiring the Lambda and self-stop — **versus** paying EC2
  **only during real sessions with no human in the loop**.

### Rough monthly totals per mode (illustrative, AWS us-east-1 on-demand)

Infra envelope only; the flat **Max plan (~$100–200/mo)** sits on top of all three, unchanged.

| Mode | EC2 | + mode-independent lines | **AWS total** |
|---|---|---|---|
| (a) Always-on 24/7 | ~$30–61 | ~$4–5 | **~$34–66/mo** |
| (b) Manual spin-up/down | ~$2–7 | ~$4–5 | **~$6–12/mo** |
| (c) Poll-triggered auto | ~$2–7 (+ ~$0 Lambda) | ~$4–5 | **~$7–12/mo** |

## v1 recommendation — across the three modes

**Adopt mode (c), poll-triggered auto spin-up/spin-down** — consistent with the already-decided
Lambda supervisor — with **(b) manual as the acceptable fallback** and **(a) always-on as the
do-nothing baseline**.

Reasoned, not asserted:

- **Why (c) over (a).** Under intermittent load EC2 is the dominant infra line and idle for ~90%
  of the month; because AWS bills EC2 per second and a stopped instance costs $0 of compute, (c)
  cuts that line ~5–10× (~$30–61 → ~$2–7). The Lambda that buys this is **free-tier**, so the
  saving is almost pure upside.
- **Why (c) over (b).** Both bill EC2 only during sessions, but (b) depends on the operator
  **remembering** to start/stop — brittle for a looped, async harness — whereas (c) removes the
  human from the loop entirely, which is the whole point of a looping agent runner.
- **Against its two honest costs.** (1) **~1–2 min spin-up latency** — acceptable for async agent
  work, where a task waiting a minute to begin is invisible. (2) **Idle-detection** is real
  engineering, but on AWS it is **already paid for**: the supervisor loop's exit-0-when-idle plus
  a self-issued `stop-instances` reuses the hosting doc's drain-then-replace lifecycle
  (node `5039267c`) rather than inventing a new billable component.
- **The honest caveat on magnitude.** Because the flat Max plan (~$100–200/mo) **dwarfs** the
  whole AWS envelope, (c)'s absolute saving over (a) is only **~$25–55/mo** against a ~$100–200/mo
  model bill — infra optimisation is a *small* fraction of total spend. So the case for (c) rests
  less on the dollars saved and more on **fit**: it matches the intermittent,
  human-out-of-the-loop usage pattern and is near-free to run. If self-stop proves fiddly to land
  at v1, **fall back to (b)**; even **(a) always-on** is a small premium in the context of the
  total bill, so none of the three is a *wrong* answer — (c) is simply the best-fit one.

**Bottom line:** v1 total ≈ **flat Max plan (~$100–200/mo, separate envelope) + an AWS envelope of
~$7–12/mo under the recommended mode (c)**. Infra is a rounding error next to the model
subscription; spend the optimisation effort on (c) because it fits the workload and costs almost
nothing to run, not because it saves a large fraction of the total.
