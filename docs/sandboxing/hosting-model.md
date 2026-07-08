# Hosting model decision

**Status:** Decided (v1)
**Decision:** Host each Claude Code session on a **raw virtual machine** (a plain Linux compute instance, e.g. EC2, GCE, Hetzner, DigitalOcean — cloud-agnostic).

This is the keystone decision for the sandboxing subtree: the isolation posture
(`e126cb28`), credential flow (`9e800d99`), and lifecycle updates (`5039267c`) all read off
the host chosen here.

## What we are hosting

A Claude Code session is **long-lived, stateful, and interactive**. It needs a real
filesystem, a real shell, arbitrary subprocesses, and it runs for minutes-to-hours per task.
The harness loops these sessions to pick up AgentJira nodes. The host must therefore treat a
persistent interactive process as the normal case, not the exception — this single fact drives
the whole comparison below.

Providers are named only as **examples**; nothing here is AWS-specific. Because the operator
wants **Terraform** as the IaC layer, each model is also judged on how cleanly it maps to
Terraform resources.

## The three models

### 1. Raw VM (e.g. EC2 / GCE / a bare cloud instance)

- **Isolation fit** — Strong support, though the VM itself is only the *outer* boundary; the
  per-session sandbox lives *inside* it. You have full root, so every isolation primitive is
  on the table: separate users, Linux namespaces, seccomp/cgroups, nested containers, even
  microVMs (gVisor / Firecracker). Egress is controlled at the instance's own network layer
  (security group + host firewall). Nothing is forbidden to you.
- **Solo-operator overhead** — Lowest *conceptual* overhead: a VM is just a computer. You
  patch it and you own the OS, but there is no orchestrator, no control plane, no task/service
  abstraction to learn. One person can reason about one box.
- **Lifecycle constraint** — Most permissive. Drain-then-replace is entirely operator-driven:
  stand up a new instance from an immutable image, stop routing new sessions to the old one,
  let in-flight sessions finish, then terminate. Nothing kills your process out from under you.
  The cost is that you must *build* the drain/handoff yourself (a simple "accepting" flag or a
  load balancer target-drain).
- **Terraform** — The most mature, most portable resource in every provider (`aws_instance`,
  `google_compute_instance`, `hcloud_server`, …). A single well-understood resource plus a
  security group and an image reference. Easiest thing to express as IaC, and the easiest to
  keep provider-agnostic.

### 2. Containers (e.g. ECS / Fargate / a managed container service)

- **Isolation fit** — Good per-session boundary (one container per session) with egress via
  network policy / security groups. But managed container runtimes constrain you: Fargate-style
  services forbid privileged mode and restrict the kernel features (user namespaces, nested
  virtualization) that a strong isolation posture may want. You inherit the platform's ceiling.
- **Solo-operator overhead** — Higher. You now run an orchestrator: clusters, task definitions,
  services, networking, and a wider IAM surface — moving parts a solo operator does not need at
  v1 scale.
- **Lifecycle constraint** — Orchestrators are built around *stateless* rolling replace and will
  happily terminate tasks to converge on desired state. Protecting a long-lived interactive
  session means fighting the model with task-protection / custom drain logic — you end up
  hand-building the same drain you'd build on a VM, on top of more machinery.
- **Terraform** — Well supported but more surface: cluster + task def + service + networking +
  roles, several coupled resources versus the VM's one.

### 3. Managed compute (e.g. Lambda / a PaaS request runner)

- **Isolation fit** — Isolation itself is strong (per-invocation microVM) but **not yours to
  shape** — you can't set the egress posture the isolation node needs, and there is no place to
  run a custom sandbox.
- **Solo-operator overhead** — Lowest for *stateless* work, but that is the wrong shape: you'd
  spend the saved ops budget fighting the execution model.
- **Lifecycle constraint** — There is no "in-flight session" to drain — invocations are short
  and simply time out. Drain-then-replace is not even expressible.
- **Terraform** — Fine to express, but irrelevant given the model doesn't fit the workload.
- **Fundamental mismatch** — Built for short, stateless invocations: hard execution-time caps,
  an ephemeral/read-only filesystem, and no persistent interactive shell. A long-lived stateful
  Claude Code session violates every one of these assumptions. Non-starter for v1.

## v1 recommendation

**Host each session on a raw VM.** It is the leanest *defensible* pick for a solo operator
running stateful shell sessions with a drain-then-replace lifecycle: zero impedance mismatch to
a long-lived interactive process, full freedom over the isolation primitives the next node will
choose, operator-owned lifecycle with no orchestrator killing sessions, and the single most
mature Terraform resource.

This is chosen **for leanness, reversible over optimal**. Containers are the likely v2 once
scale or fleet management demands an orchestrator — and starting on a VM keeps that reversible,
because you can run the exact same session containers *on* the VM first and lift them into a
managed service later without changing the session contract.

### One-line reason per rejected model

- **Containers (ECS/Fargate):** adds an orchestrator built around stateless rolling replace —
  real ops overhead and a lifecycle model that fights long-lived interactive sessions, for
  scale a solo v1 doesn't need yet.
- **Managed compute (Lambda/PaaS):** built for short stateless invocations — no persistent
  shell, ephemeral filesystem, and hard time caps make it a non-starter for a long-lived
  interactive Claude Code session.

## Handoff notes to later nodes

- **Isolation (`e126cb28`)** — The host is a single VM, so per-session isolation happens
  *inside* the box: one sandbox per session (container / namespace / dedicated user), with
  egress controlled at the VM's network layer. Because you have full root, strong primitives
  (user namespaces, seccomp, nested containers, gVisor/Firecracker) are all available — you are
  not capped by a managed runtime's restrictions. Pick the posture freely; the host won't
  constrain you.
- **Credential (`9e800d99`)** — A VM has one stable machine identity. Attach an instance
  role / workload identity to the box rather than baking long-lived keys, and mint short-lived,
  per-session credentials *on* the host, scoped down per sandbox. One host identity to manage,
  provisioned via Terraform.
- **Lifecycle (`5039267c`)** — Drain-then-replace is operator-controlled and must be built, not
  inherited: bring up a new immutable-image VM (via Terraform), flip the old one to
  "not accepting new sessions", let in-flight sessions finish, then terminate. No platform will
  preempt your sessions; the work to own is the drain signal + session handoff, not survival
  against an orchestrator.
