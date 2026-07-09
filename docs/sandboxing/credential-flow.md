# Credential flow decision

**Status:** Decided (v1)
**Decision:** Keep every runtime credential **out of the per-session sandbox**. The
**host-local egress proxy** (the one picked in the network-isolation node `e126cb28`,
PR #2) is the credential holder: it mints/fetches each credential off the **VM's attached
instance identity** and **injects it into the session's outbound requests**, so the
sandbox itself holds no token at all. The **one exception is the Claude/Anthropic
credential** — Claude Code authenticates in-process, so that credential must be present
inside the session; it is the sole credential a session ever sees, and its blast radius is
bounded (workspace-scoped key + spend cap, in memory only, wiped at teardown). The host
still holds **no self-managed long-lived secrets** — nothing baked into the image, env, or
disk.

Builds on two settled picks: the host is a **raw VM** (hosting node `c1b0780b`, done — a
plain Linux compute instance, cloud-agnostic) and its only outbound path is a **single
host-local egress proxy** (isolation node `e126cb28`, PR #2) running in the host-root
domain *outside* every per-session sandbox. A VM has exactly one stable machine identity,
which makes an attached workload-identity role the natural root of trust; the proxy already
sits on the one chokepoint every request must cross, which makes it the natural place to
attach credentials. Providers (an IAM role, a secrets manager, an STS-style token exchange,
a model gateway) are named only as **examples** — nothing here is provider-specific.

## Decision criteria

- **Credentials out of the sandbox** — the session sandbox holds no token it doesn't
  strictly need in-process. A secret a session never holds is a secret a same-session
  compromise cannot steal.
- **No self-managed long-lived secrets on the host** — nothing durable on the image, in
  env vars, or on disk. The strongest secret is the one the box never holds at rest.
- **Short-lived / cloud-managed identity** — credentials are supplied at runtime from the
  VM's attached identity, scoped down per session, with the shortest practical lifetime.
- **Least privilege, per session** — each session gets only the access it needs, scoped as
  narrowly as the upstream will allow, and only for as long as it runs.

## The root of trust: the VM's attached identity

The VM boots with a **workload-identity role attached by Terraform** (e.g. an
`aws_iam_instance_profile`, a GCE service account, or any provider's instance identity).
The cloud platform vouches for the box: code on the VM proves who it is by asking the
**instance metadata endpoint** for a fresh, automatically-rotated identity token — there
is no key on disk to steal. That attached identity is the *only* standing credential in
the system, and it is a role, not a secret.

Everything else hangs off it. Two mechanisms cover the three credentials:

1. **Mint** — where the upstream federates with cloud/OIDC identity, the attached identity
   is exchanged for a short-lived, narrowly-scoped token (STS-style / OIDC token exchange).
   Best case: no static secret exists anywhere.
2. **Fetch** — where the upstream cannot be minted from cloud identity, a long-lived secret
   is held **centrally in a secrets manager** (optionally KMS-encrypted), and the VM
   identity is granted a tight read policy. The secret is pulled into memory only and never
   the host's to keep at rest.

## Where credentials live: the proxy, not the sandbox

The isolation node already runs **one host-local forward proxy** as the sole outbound path
for every session, owned by host-root and outside every sandbox. This decision puts the
credential logic **there** rather than inside the session:

- **The proxy mints/fetches** each credential off the VM's attached identity (the two
  mechanisms above) and holds it in the proxy process, in the host-root trust domain.
- **The proxy injects** the credential into the session's outbound requests. The session's
  clients (`aj`, `git`/`gh`) are pointed at the proxy the standard way
  (`HTTPS_PROXY`/`HTTP_PROXY`, git's proxy config) and send requests with **no real
  credential** — a placeholder or none. On the way out, the proxy rewrites the
  `Authorization` header with the real short-lived token.
- **The sandbox holds nothing** for these credentials. A same-session RCE has no `aj` token
  and no GitHub token to read — they live one trust domain up, in a process the confined
  session cannot reach, stop, or reconfigure (it has no host-root; the netfilter rules and
  the proxy daemon are host-root-owned, per the isolation node's colocation argument).

**Cost of this shape — TLS termination.** To rewrite an `Authorization` header the proxy
must see the request, so for the two hosts whose credentials it injects (AgentJira Supabase
and GitHub) the proxy must **terminate TLS** (act as a trusted MITM with a host-root-owned
trust anchor the sandboxes trust). The isolation node deliberately skipped TLS interception
at v1 to avoid managing a trust store; adopting proxy-side injection **takes that cost on
purpose** in exchange for keeping credentials out of the sandbox entirely. This is the one
security/complexity tradeoff of the reviewer's proxy-centric model, and it is accepted
here. See the cross-node note at the end — the isolation doc's "no TLS interception at v1"
line is refined by this decision for the two injected hosts.

The Claude/Anthropic host stays a **plain tunnel** (no TLS termination, no injection),
because its credential is *not* proxy-held — see credential 2.

## The three credentials

### 1. `aj` login — authenticating the sandbox to AgentJira

- **Name:** AgentJira agent session token (a short-lived Supabase-issued JWT for the agent
  service identity that `aj` uses).
- **Where it lives:** **In the proxy, never in the session.** The VM's attached identity
  authenticates to a small AgentJira token broker via OIDC federation, which returns a
  short-lived JWT scoped to the agent role; the proxy holds that JWT and injects it as the
  `Authorization` header on outbound AgentJira/Supabase requests. The session's `aj` config
  carries **no token** — it just talks to Supabase through the proxy.
  - *Fallback if federation isn't wired at v1:* a long-lived agent key held in the
    **secrets manager**, fetched by the VM identity and exchanged for a session JWT — the
    exchange runs **in the proxy**, so the standing secret lives centrally and the minted
    JWT never leaves the proxy process.
- **Lifetime:** Session-scoped and short (e.g. ~1 hour), refreshed by the proxy while the
  session runs; discarded at teardown. The token expires on its own even if the box is
  compromised, and a compromised *session* never had it to begin with.

### 2. Claude credentials — Anthropic/Claude auth for the Claude Code session

- **Name:** Claude Code API credential (an Anthropic API key, or a Claude OAuth session
  token).
- **The exception — this one lives in the session.** Unlike `aj` and GitHub, Claude Code
  **authenticates in-process**: it reads its key/OAuth token from its own environment,
  attaches the auth itself, and (for the OAuth/`setup-token` flow) refreshes the token
  in-process. The proxy cannot cleanly stand in for that in-client auth dance, so the
  credential must be **present inside the session**. This is exactly the reviewer's flagged
  exception, and it makes Claude the **only** credential a session ever holds.
- **Where it lives:** Anthropic keys do **not** federate with cloud IAM, so a long-lived
  secret must exist somewhere. It lives **centrally in the secrets manager** (source of
  truth, KMS-encrypted at rest), **never on the host at rest**. At session start the VM
  identity — under a tight, read-only policy scoped to just this secret — pulls it into
  **session memory (tmpfs)**, injected only into that session's sandbox. It is never written
  to the image or persistent disk, and never shared between sessions.
- **Lifetime:** Long-lived *centrally* (rotated on a schedule in the secrets manager), but
  its **presence in the session is session-scoped** — fetched at start, wiped at teardown.
  Use a **workspace/project-scoped key with a spend cap** so blast radius is bounded even if
  a single session leaks it.
- **Why not inject it at the proxy like the others?** Because Claude Code owns its auth
  in-process (see above), header-rewriting at the proxy would still require a working
  credential inside the client, so it buys nothing for v1. The clean way to remove even this
  exception is the **v2 model-gateway path** below — which is the *same* proxy-injection
  idea applied to Claude.
- **Stronger option (v2, removes the exception):** route Claude through a **cloud model
  gateway** (e.g. a provider's managed model endpoint) so the VM's attached identity mints a
  short-lived token per session and **no Anthropic key exists on our side at all**. This is
  the proxy-injection model extended to Claude, and would make the session hold **zero**
  credentials. It trades pure vendor-neutrality for cloud-IAM-native auth, so it is flagged
  for v2 rather than mandated at v1.

### 3. GitHub access — repo access to raise PRs

- **Name:** GitHub App installation access token (from a GitHub App installed on the project
  repo, not a user credential).
- **Where it lives:** **In the proxy, never in the session.** A GitHub App is installed on
  the repo with minimal permissions (contents + pull requests, write). The App's **private
  key** is the only standing GitHub secret and lives **centrally in the secrets manager**
  (KMS-encrypted) — never on the host. At session start (and on ~1h refresh) the proxy, using
  the VM identity, fetches the App key, signs a JWT, and exchanges it for a **short-lived
  installation token** scoped to that one repo. The proxy holds that token and injects it
  into `git`/`gh` HTTPS traffic; the session's git config carries only a placeholder
  credential.
  - *Stronger v2:* move the App-key-to-installation-token exchange behind a small broker
    that itself trusts the VM's OIDC identity, so even the App private key leaves our control
    plane and the proxy only ever handles the 1-hour token.
- **Lifetime:** GitHub installation tokens are capped at **~1 hour**; re-minted by the proxy
  on demand while the session runs, and they expire on their own at session end. The session
  never holds one.

## v1 credential flow (summary)

| Credential | Name | Held by | Reaches the session? | Lifetime |
|---|---|---|---|---|
| `aj` login | AgentJira agent session JWT | **Proxy** (minted from VM identity via OIDC → token broker; injected into outbound reqs) | **No** — injected at proxy | Session-scoped, ~1h, refreshed |
| Claude | Claude Code API credential | Central secrets manager → **session tmpfs** | **Yes** (the exception — in-process auth) | Long-lived centrally / **session-scoped in memory** |
| GitHub | GitHub App installation token | **Proxy** (App key in secrets manager → installation token; injected into git traffic) | **No** — injected at proxy | ~1h (GitHub cap), re-minted on demand |

**The v1 call:** credentials live in the **host-local egress proxy**, which mints/fetches
them off the VM's attached identity and injects them into each session's outbound requests —
so the sandbox holds **no** `aj` or GitHub credential at all. The **only** credential a
session ever sees is the Claude/Anthropic key, because Claude Code authenticates in-process;
it is held centrally and pulled into session memory only, and the v2 model-gateway path
removes even that. The host itself carries **no self-managed long-lived secret**, consistent
with the raw-VM + Terraform + single-egress-proxy direction.

## Security posture and residual risks

Being explicit about the flows and their risks (per spec-review):

- **Sessions hold almost nothing.** By moving injection to the proxy, a same-session RCE can
  steal **only** the Claude key (the one in-process exception) — not the `aj` or GitHub
  tokens, which never enter the sandbox. This is the main security gain from the reviewer's
  proxy-centric model, and it shrinks the session blast radius to a single, spend-capped,
  workspace-scoped credential.
- **The proxy is now a concentrated credential holder.** Centralising injection makes the
  proxy process the highest-value target: it holds the live `aj` and GitHub tokens and the
  minting rights for both. Bounded by: it runs in the **host-root domain outside every
  sandbox** (a confined session cannot read its memory, stop it, or reconfigure it — same
  colocation argument as the isolation node), it holds only **short-lived** tokens (not the
  standing secrets, which stay in the secrets manager), and compromising it already requires
  host-root — at which point the whole box is lost regardless.
- **TLS termination widens what the proxy sees.** To inject headers the proxy terminates TLS
  for GitHub and AgentJira, so it sees those requests in plaintext and must manage a
  host-root-owned trust anchor. Bounded by: the trust store is owned by host-root outside the
  sandbox, termination is scoped to only the two injected hosts (Claude stays a plain
  tunnel), and the proxy is *already* the audit chokepoint, so it is not a new trust
  boundary — only a deeper one.
- **Attached-identity compromise = root of trust compromise.** If an attacker runs code as
  the VM identity they can mint/fetch everything. Mitigations: scope the instance role to the
  *minimum* (read the Claude + App secrets, call the token broker, nothing else);
  per-session sandboxing (`e126cb28`) so session code does not run *as* the box identity;
  egress limits at the VM network layer.
- **Claude key is the weakest link** (long-lived, un-federatable, and the one credential in
  the sandbox). Bounded by: central-only storage, per-session in-memory fetch,
  workspace-scoped key + spend cap, scheduled rotation, and the v2 gateway path that removes
  the key from our side entirely.
- **Broker/metadata as a target.** The token broker and metadata endpoint must reject
  anything but the VM's genuine identity (enforce IMDSv2-style hop limits / signed identity),
  or the minting guarantees collapse.
- **No secret at rest on the host** by construction — the highest-value, longest-lived attack
  surface (a key on disk or in the image) simply does not exist here.

## Rejected options (one line each)

- **Inject `aj`/GitHub credentials into the sandbox (per-session, in the session)** — the
  prior shape; simpler (no TLS termination) but the session holds live tokens a same-session
  RCE can read. Rejected in favour of proxy injection, which removes them from the sandbox.
- **Inject the Claude key at the proxy too** — Claude Code authenticates in-process, so a
  working credential must still exist in the client; proxy injection buys nothing for v1. The
  v2 model gateway is the correct way to remove this credential from the session.
- **Static cloud/access keys on the box** — a long-lived self-managed secret at rest on the
  host; exactly what the attached identity exists to eliminate.
- **Long-lived PAT / API key baked into the image or env** — ships a durable secret in every
  copy of the image, un-rotatable per session and impossible to scope down.
- **Personal GitHub PAT** — tied to a human account, over-broad, and long-lived; a GitHub App
  installation token is per-repo, least-privilege, and ~1h.
- **GitHub deploy key / SSH key on disk** — a standing private key at rest on the host, no
  per-session scoping and awkward to rotate.
- **Secrets baked into the Terraform state / image build** — leaks long-lived secrets into
  state files and image layers; the box should receive nothing durable.
- **Direct Anthropic key on disk (no secrets manager)** — a long-lived secret persisted on
  the host with no central rotation, revocation, or scoping.

## Cross-node consistency note (isolation node `e126cb28` / PR #2)

The isolation doc runs the egress proxy as a **hostname-allowlist tunnel that does not
terminate TLS at v1** (to avoid managing a trust store). This decision **refines that** for
the two hosts whose credentials the proxy injects: for **AgentJira Supabase** and **GitHub**
the proxy **does terminate TLS** at v1 (host-root-owned trust anchor) so it can rewrite the
`Authorization` header. The **Anthropic** host remains a plain CONNECT tunnel. If the
isolation and cost docs assume a pure no-TLS-interception proxy, reconcile them with this: TLS
termination is now in scope for two of the three hosts.

## Handoff note to the cost node (`9e56122f`)

This node firm-blocks cost. The credential flow introduces these **cost-bearing pieces** to
price at v1 scale (one solo operator, a single VM, looping sessions):

- **Secrets manager** — stores the Claude key and the GitHub App private key; priced per
  stored secret + per API access. Every session start does at least one fetch (Claude key +
  App key).
- **KMS** — encrypts those secrets at rest and backs the manager; priced per key + per
  cryptographic operation (decrypt on each fetch).
- **Per-session token minting (now in the proxy)** — STS-style / OIDC token exchange for
  `aj`, and the GitHub App-key → installation-token exchange, run **once (or a few times) per
  session** and re-minted on ~1h refresh; some providers price token-exchange / STS calls, so
  call volume scales with session length and count. This work moved *from the session to the
  proxy* but the call volume is unchanged.
- **Proxy TLS-termination overhead** — terminating TLS for GitHub + AgentJira adds a small
  per-request CPU/latency cost and requires provisioning/rotating a host-root trust anchor
  (cheap, but non-zero operationally). The Anthropic tunnel is unaffected.
- **(If the v2 gateway path is taken)** a **cloud model gateway** for Claude would shift
  Claude auth to per-session minted tokens (removing the secrets-manager line for Claude, and
  removing the last in-session credential) but adds gateway request pricing — flagged so cost
  can compare the two shapes.

The attached instance role itself is **free** (it is IAM, not a resource), and colocating
credential injection in the already-required egress proxy adds **no new box**. Net v1 cost is
small and dominated by secrets-manager storage + KMS operations + per-session mint calls, all
scaling with session count rather than being fixed.
