# Credential flow decision

**Status:** Decided (v1)
**Decision:** Deliver every runtime credential off the **VM's attached instance
identity** (a workload-identity role bound to the box via Terraform). The host holds
**no self-managed long-lived secrets** — nothing baked into the image, env, or disk.
The attached identity is the single root of trust; from it the box either mints
short-lived, per-session tokens or reads centrally-held secrets into session memory only.

Builds directly on the settled hosting pick (`c1b0780b`, done): the host is a **raw VM**
(a plain Linux compute instance, cloud-agnostic). A VM has exactly one stable machine
identity, which makes an attached workload-identity role the natural credential-delivery
primitive. Providers (an IAM role, a secrets manager, an STS-style token exchange, a
model gateway) are named only as **examples** — nothing here is provider-specific.

## Decision criteria

- **No self-managed long-lived secrets on the host** — nothing durable on the image, in
  env vars, or on disk. The strongest secret is the one the box never holds at rest.
- **Short-lived / cloud-managed identity** — credentials are supplied at runtime from the
  VM's attached identity, scoped down per session, with the shortest practical lifetime.
- **Least privilege, per session** — each session gets only the credentials it needs,
  scoped as narrowly as the upstream will allow, and only for as long as it runs.

## The root of trust: the VM's attached identity

The VM boots with a **workload-identity role attached by Terraform** (e.g. an
`aws_iam_instance_profile`, a GCE service account, or any provider's instance identity).
The cloud platform vouches for the box: code on the VM proves who it is by asking the
**instance metadata endpoint** for a fresh, automatically-rotated identity token — there
is no key on disk to steal. That attached identity is the *only* standing credential in
the system, and it is a role, not a secret.

Everything else hangs off it. Two mechanisms cover the three credentials:

1. **Mint** — where the upstream federates with cloud/OIDC identity, the box exchanges
   its attached identity for a short-lived, narrowly-scoped token (STS-style / OIDC token
   exchange). Best case: no static secret exists anywhere.
2. **Fetch** — where the upstream cannot be minted from cloud identity, a long-lived
   secret is held **centrally in a secrets manager** (optionally KMS-encrypted), and the
   VM identity is granted a tight read policy. The secret is pulled into **session memory
   (tmpfs) only** at session start and destroyed at teardown — it is never the host's to
   keep at rest.

Per-session scoping happens *inside* the box (consistent with the isolation node
`e126cb28`): the harness fetches/mints each credential at session start, injects it into
that session's sandbox only, and revokes/discards it at session end.

## The three credentials

### 1. `aj` login — authenticating the sandbox to AgentJira

- **Name:** AgentJira agent session token (a short-lived Supabase-issued JWT for the
  agent service identity that `aj` uses).
- **Where it lives:** **Minted per session** — the VM's attached identity authenticates to
  a small AgentJira token broker via OIDC federation, which returns a short-lived JWT
  scoped to the agent role. The token lives only in the session's environment / tmpfs
  (e.g. the `aj` config dir on a per-session mount). No AgentJira secret sits on the host.
  - *Fallback if federation isn't wired at v1:* a long-lived agent key held in the
    **secrets manager**, fetched by the VM identity and exchanged for a session JWT on the
    box — the standing secret still lives centrally, never on the VM.
- **Lifetime:** Session-scoped and short (e.g. ~1 hour), refreshed while the session runs;
  discarded at teardown. The token expires on its own even if a session is compromised.

### 2. Claude credentials — Anthropic/Claude auth for the Claude Code session

- **Name:** Claude Code API credential (an Anthropic API key, or an OAuth session token).
- **Where it lives:** This is the **hardest** of the three, and the review's security
  concern lands squarely here — Anthropic API keys do **not** federate with cloud IAM, so
  a long-lived secret must exist *somewhere*. It lives **centrally in the secrets manager**
  (the source of truth, KMS-encrypted at rest), **never on the host**. At session start the
  VM identity — under a tight, read-only policy scoped to just this secret — pulls it into
  **session memory (tmpfs)**, injected only into that session's sandbox. It is never
  written to the image or to persistent disk, and never shared between sessions.
- **Lifetime:** The key is long-lived *centrally* (rotated on a schedule in the secrets
  manager), but its **presence on the host is session-scoped** — fetched at start, wiped at
  teardown. Use a **workspace/project-scoped key with a spend cap** so blast radius is
  bounded even if a single session leaks it.
- **Stronger option (call-out):** route Claude through a **cloud model gateway** (e.g. a
  provider's managed model endpoint) so the VM's attached identity mints a short-lived
  token per session and **no Anthropic key exists on our side at all**. This is the most
  secure shape; it trades pure vendor-neutrality for cloud-IAM-native auth, so it is
  flagged for v2 rather than mandated at v1.

### 3. GitHub access — repo access to raise PRs

- **Name:** GitHub App installation access token (from a GitHub App installed on the
  project repo, not a user credential).
- **Where it lives:** **Minted per session.** A GitHub App is installed on the repo with
  minimal permissions (contents + pull requests, write). The App's **private key** is the
  only standing GitHub secret and lives **centrally in the secrets manager** (KMS-encrypted)
  — never on the host. At session start the VM identity fetches the App key, signs a JWT,
  and exchanges it for a **short-lived installation token** scoped to that one repo; the
  installation token lives in **session memory only**.
  - *Stronger v2:* move the App-key-to-installation-token exchange behind a small broker
    that itself trusts the VM's OIDC identity, so even the App private key leaves our
    control plane and the box only ever sees the 1-hour token.
- **Lifetime:** GitHub installation tokens are capped at **~1 hour**; re-minted on demand
  while the session runs, and they expire on their own at session end.

## v1 credential flow (summary)

| Credential | Name | Where it lives | Lifetime |
|---|---|---|---|
| `aj` login | AgentJira agent session JWT | Minted per session from VM identity (OIDC → token broker); token in session tmpfs only | Session-scoped, ~1h, refreshed |
| Claude | Claude Code API credential | Central secrets manager (KMS at rest); pulled into session tmpfs at start, wiped at teardown | Long-lived centrally / **session-scoped on host** |
| GitHub | GitHub App installation token | Minted per session (App key in secrets manager → installation token); token in session tmpfs only | ~1h (GitHub cap), re-minted on demand |

**The v1 call:** every credential is delivered off the VM's attached instance identity —
`aj` and GitHub are **minted short-lived per session** with zero standing secret, and the
one credential that cannot be minted (Claude) is held **centrally in a secrets manager and
pulled into session memory only**. The host itself carries **no self-managed long-lived
secret**, consistent with the raw-VM + Terraform direction.

## Security posture and residual risks

Being explicit about the flows and their risks (per spec-review):

- **Attached-identity compromise = root of trust compromise.** If an attacker runs code as
  the VM identity, they can mint/fetch everything. Mitigations: scope the instance role to
  the *minimum* (read one Claude secret, call one token broker, nothing else); per-session
  sandboxing (`e126cb28`) so session code does not run *as* the box identity; egress limits
  at the VM network layer.
- **Claude key is the weakest link** (long-lived, un-federatable). Bounded by:
  central-only storage, per-session in-memory fetch, workspace-scoped key + spend cap,
  scheduled rotation, and the v2 gateway path that removes the key entirely.
- **In-memory ≠ invulnerable.** Session credentials sit in tmpfs; a same-session RCE can
  read them. Bounded by short lifetimes (self-expiry), least-privilege scoping (a leaked
  GitHub token can only touch one repo with two permissions), and no cross-session sharing.
- **Broker/metadata as a target.** The token broker and metadata endpoint must reject
  anything but the VM's genuine identity (enforce IMDSv2-style hop limits / signed
  identity), or the minting guarantees collapse.
- **No secret at rest on the host** by construction — the highest-value, longest-lived
  attack surface (a key on disk or in the image) simply does not exist here.

## Rejected options (one line each)

- **Static cloud/access keys on the box** — a long-lived self-managed secret at rest on the
  host; exactly what the attached identity exists to eliminate.
- **Long-lived PAT / API key baked into the image or env** — ships a durable secret in every
  copy of the image, un-rotatable per session and impossible to scope down.
- **Personal GitHub PAT** — tied to a human account, over-broad, and long-lived; a GitHub
  App installation token is per-repo, least-privilege, and ~1h.
- **GitHub deploy key / SSH key on disk** — a standing private key at rest on the host, no
  per-session scoping and awkward to rotate.
- **Secrets baked into the Terraform state / image build** — leaks long-lived secrets into
  state files and image layers; the box should receive nothing durable.
- **Direct Anthropic key on disk (no secrets manager)** — a long-lived secret persisted on
  the host with no central rotation, revocation, or scoping.

## Handoff note to the cost node (`9e56122f`)

This node firm-blocks cost. The credential flow introduces these **cost-bearing pieces** to
price at v1 scale (one solo operator, a single VM, looping sessions):

- **Secrets manager** — stores the Claude key and the GitHub App private key; priced
  per stored secret + per API access. Every session start does at least one fetch.
- **KMS** — encrypts those secrets at rest and backs the manager; priced per key + per
  cryptographic operation (decrypt on each fetch).
- **Per-session token minting** — STS-style / OIDC token exchange for `aj`, and the GitHub
  App-key → installation-token exchange, run **once (or a few times) per session**; some
  providers price token-exchange / STS calls, and re-minting on ~1h refresh multiplies call
  volume with session length and count.
- **(If the v2 gateway path is taken)** a **cloud model gateway** for Claude would shift
  Claude auth to per-session minted tokens (removing the secrets-manager line for Claude)
  but adds gateway request pricing — flagged so cost can compare the two shapes.

The attached instance role itself is **free** (it is IAM, not a resource). Net v1 cost is
small and dominated by secrets-manager storage + KMS operations + per-session mint calls,
all scaling with session count rather than being fixed.
