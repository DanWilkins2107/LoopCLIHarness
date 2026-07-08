# Network isolation posture

**Status:** Decided (v1)
**Decision:** Default-deny egress at the VM network layer, with a **single host-local
egress proxy** as the only permitted outbound path — hostname-allowlisting the three legit
hosts and doubling as the audit point — and Claude Code's own sandbox/permission modes as a
defense-in-depth inner layer.

**Depends on:** [`hosting-model.md`](./hosting-model.md) — the host is settled as a **raw VM**
(provider-agnostic Linux instance, Terraform IaC), with full root and per-session isolation
living *inside* the box. This doc writes the network posture for that world and does not
re-open the host choice.

## What a session legitimately talks to

A looped Claude Code session needs exactly three outbound destinations:

| Host | Why | Shape |
|---|---|---|
| **GitHub** | clone, fetch, push, `gh` API (PRs) | `github.com`, `api.github.com`, `*.githubusercontent.com`, git over HTTPS |
| **Anthropic API** | the model itself | `api.anthropic.com` over HTTPS |
| **AgentJira Supabase** | `aj` CLI reads/writes the board | the project's Supabase REST/Realtime endpoint over HTTPS |

Everything else is, for v1, an exfiltration or supply-chain risk and should be denied by
default. The problem is small (three hosts, all HTTPS) but the hosts are **cloud-fronted with
rotating IPs** — so the mechanism must allowlist by *name*, not by hand-maintained CIDR.

## The three options, on a raw VM

### 1. Egress allowlist at the VM network layer

Security group + host firewall (`nftables`/`iptables`) restricting outbound to a fixed host
set. Native to a raw VM — it is just the instance's own network config, expressible directly
in Terraform (`aws_security_group` / `google_compute_firewall` / `hcloud_firewall`) plus a
small host-firewall rule set baked into the image. Zero new machinery, and it is the outer
boundary that no in-box process can talk around.

**The catch:** a pure L3/L4 firewall filters by IP/CIDR. The three legit hosts sit behind CDNs
and rotating cloud IP ranges, so a static IP allowlist is either too broad (allowing a whole
provider's IP space, which defeats the point) or a brittle list you hand-maintain forever. The
firewall is the right *boundary* but the wrong *filter granularity* on its own — which is why
the posture pairs it with a proxy that filters by hostname.

### 2. Container network policy

A per-session container whose egress is governed by network policy. On a raw VM this is
**self-managed**: there is no orchestrator or CNI (Calico/Cilium, a Kubernetes
`NetworkPolicy`, a cloud VPC-CNI) to inherit the policy engine *from* — you would stand up and
operate that machinery yourself, on one box, just to express "these three hosts." The
per-session container is worth keeping for *process/filesystem* isolation, but as a **network**
control it buys almost nothing over option 1: the same default-deny + proxy chokepoint applied
at the host covers every container on the box uniformly, with far fewer moving parts. Network
policy here is redundant self-managed plumbing, not an inherited capability.

### 3. Claude Code's own sandbox / permission modes

Claude Code ships its own guardrails — restrictions on which commands/tools run, and its
sandbox for bash execution. Valuable and cheap to turn on, but it is an **in-process, agent-
level** control: it constrains what the agent *chooses* to do, not what a subprocess, a
compromised dependency, or a prompt-injected command *can* reach on the network. It is the
wrong layer to be the *sole* egress boundary (an escape or a rogue child process bypasses it),
but exactly the right **innermost** layer in a defense-in-depth stack — it stops most bad
egress before it ever reaches the firewall, and shrinks what the outer layers have to catch.

## The egress proxy

Run one **host-local forward proxy** (e.g. Squid, tinyproxy, or a small mitmproxy/`goproxy`)
as an always-on daemon on the VM, *outside* every per-session sandbox. Wire it up so it is the
**only** way out:

- **Host firewall = default-deny outbound**, with a single exception: the sandboxes may reach
  the proxy's port (loopback / host-only address), plus DNS. Nothing in a sandbox can open a
  direct socket to the internet — all egress is forced through the proxy.
- **Proxy = hostname allowlist.** It permits `CONNECT` only to the three destinations above
  (matched by domain, so CDN IP rotation is a non-issue) and refuses everything else. For plain
  HTTPS tunnelling it allowlists on the SNI/`CONNECT` host without needing to terminate TLS;
  TLS interception is available if deeper inspection is ever wanted, but is **not** required for
  v1 and is deliberately skipped to avoid managing a trust store.
- Sessions are pointed at it the standard way (`HTTPS_PROXY`/`HTTP_PROXY`, `git`'s proxy
  config), which every one of the three clients (git/`gh`, the Anthropic SDK, supabase-js)
  already honours.

This gives name-based allowlisting (solving option 1's IP-list problem) behind a hard L3/L4
default-deny boundary (giving the proxy teeth nothing can route around).

### Does the proxy double as the audit point?

**Yes.** Because every outbound request is funneled through this one process, its access log is
a complete, tamper-evident record of everything a session reached: timestamp, destination host,
bytes, allow/deny verdict. That is the natural single chokepoint for both *control* and
*observation* — building a separate audit mechanism would just re-derive the same data less
completely. **Audit lives in the proxy's request log** (shipped off-box to durable storage so a
compromised VM can't rewrite its own history). Per-session attribution comes from binding each
sandbox to a distinct proxy identity (per-sandbox loopback port or proxy credential), so log
lines map back to the session that made them.

## Output

### v1 posture

Layered, default-deny:

1. **VM network layer — default-deny egress** (security group + host firewall). The only
   permitted outbound is to the host-local proxy (plus DNS). This is the hard boundary.
2. **Host-local egress proxy — the allowlist + the audit point.** One always-on daemon,
   hostname-allowlisting GitHub + Anthropic API + AgentJira Supabase, logging every request.
3. **Per-session sandbox** (container / namespace / dedicated user, from the hosting node) for
   process & filesystem isolation, routed through the proxy for network — *not* relied on for
   network policy itself.
4. **Claude Code sandbox / permission modes** — innermost layer, enabled as cheap
   defense-in-depth.

Concretely: bake the firewall rules and the proxy into the VM's immutable image via Terraform +
cloud-init; sessions inherit the posture with nothing to configure per-session.

### One-line reason per rejected / de-emphasized option

- **Egress allowlist as a *standalone* L3/L4 control** — right boundary, wrong granularity
  alone: it can't cleanly track CDN-rotated IPs for the three hosts, so it's kept as the
  default-deny *fence* and the proxy does the by-name filtering.
- **Container network policy** — on a raw VM there's no CNI/orchestrator to inherit a policy
  engine from, so it's self-managed plumbing that duplicates the host proxy's job for no gain;
  containers stay for process/fs isolation, not network control.
- **Claude Code sandbox/permission modes as the *sole* control** — an in-process agent-level
  guardrail can be bypassed by a subprocess or injected command, so it's demoted to the
  innermost defense-in-depth layer rather than the egress boundary.

### Audit point

The **egress proxy is the audit point** — a single chokepoint for both outbound control and
request logging. No separate audit system; logs are shipped off-box to durable storage and
attributed per-session via distinct proxy identities.

### Handoff note to Cost model (`9e56122f`)

Cost-relevant facts this posture emits:

- **The egress proxy is one always-on, host-local daemon — not a per-session process and not a
  separate instance.** It is co-located on the *same* VM as the sessions (a lightweight Squid/
  tinyproxy-class process: tens of MB RAM, negligible CPU at solo-operator request volume). It
  does **not** add a new billable compute unit at v1.
- **It does not change session spin-up/spin-down.** The proxy is part of the baked VM image and
  runs for the life of the box; sessions come and go through it. So it sizes into the *always-on
  VM* baseline, not the per-session cost.
- **Only genuinely additive cost is log storage**, which grows over time and is shipped off-box
  (a small object-storage/log line item), plus a marginal bump to the VM's baseline RAM/CPU for
  the daemon — fold into always-on VM sizing, not per-session.
- **Firewall/security-group rules are free** (native cloud + host config, no runtime cost).
- **v2 flag:** if the harness later scales to a *fleet* of VMs (the hosting doc's likely v2),
  the proxy may graduate to a shared always-on service — at that point it becomes its own
  sizeable always-on line item. Out of scope for v1's single-box costing.
