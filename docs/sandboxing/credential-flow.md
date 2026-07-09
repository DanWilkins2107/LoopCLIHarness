# Credential flow decision

**Status:** Decided (v1)
**Decision:** Hold **no standing secret** in the per-session sandbox or on the host. Every
runtime credential is a **short-lived token minted at session time off the VM's attached
instance identity** (a workload-identity role bound to the box via Terraform). A small
**host-root credential broker** does the minting/fetching outside every sandbox; the
session's clients (`aj`, `git`/`gh`) receive a fresh token through a **credential helper**
at request time and attach it themselves — so the sandbox never holds a *standing* secret,
only a scoped ~1h token while it runs. That ~1h is the lifetime of each *token*, not a cap on
session length: the broker **re-mints on demand**, so sessions can run arbitrarily long (see
[Sessions longer than the token lifetime](#sessions-longer-than-the-token-lifetime)). The Claude
credential is the one un-mintable exception: v1 runs off a **Max plan**, so it is the operator's
**OAuth subscription login token**, held centrally and pulled into session memory only.

**v1 deliberately does not terminate TLS.** The stronger "proxy holds the token, session
holds nothing" shape is real and is written up below as a **v2 hardening** — but it requires
TLS termination (a trusted man-in-the-middle with a private CA in the sandbox), which is a
non-trivial security surface of its own. The section
[How a credential reaches the client](#how-a-credential-reaches-the-client--and-where-tls-termination-comes-in)
explains exactly what that means and why v1 stays on the simpler broker path, consistent with
the isolation node's "no TLS interception at v1" posture.

Builds on two settled picks: the host is a **raw VM** (hosting node `c1b0780b`, done — a
plain Linux compute instance, cloud-agnostic) and its only outbound path is a **single
host-local egress proxy** (isolation node `e126cb28`, PR #2) running in the host-root domain
*outside* every per-session sandbox. A VM has exactly one stable machine identity, which
makes an attached workload-identity role the natural root of trust. Providers (an IAM role, a
secrets manager, an STS-style token exchange, a model gateway) are named only as **examples**
— nothing here is provider-specific.

## Decision criteria

- **No standing secret in the sandbox** — the session never holds a long-lived key. At most
  it holds a **short-lived, tightly-scoped token** for as long as it runs. A standing secret a
  session never holds is a standing secret a same-session compromise cannot steal. **One honest
  exception:** v1 runs Claude Code off the operator's **Max plan**, whose login credential Claude
  authenticates with *in-process* — so that one credential does live in the session. It is called
  out and bounded in [§2](#2-claude-credentials--anthropicclaude-auth-for-the-claude-code-session),
  not hand-waved away.
- **No self-managed long-lived secrets on the host** — nothing durable on the image, in env
  vars, or on disk. The strongest secret is the one the box never holds at rest.
- **Short-lived / cloud-managed identity** — credentials are supplied at runtime from the
  VM's attached identity, scoped down per session, with the shortest practical lifetime.
- **Least privilege, per session** — each session gets only the access it needs, scoped as
  narrowly as the upstream will allow, and only for as long as it runs.
- **Least machinery for the security won** — at v1 (one solo operator, one box) prefer the
  primitive that delivers the property without standing up a new trust surface (e.g. a private
  CA) unless the extra security clearly earns it.

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
   identity is granted a tight read policy. The secret is pulled into memory only and is never
   the host's to keep at rest.

Both mechanisms run in a **host-root credential broker** — a tiny always-on helper in the
host-root trust domain, outside every session sandbox (it can sit in, or beside, the egress
proxy the isolation node already runs). A confined session cannot read the broker's memory,
stop it, or reconfigure it — it has no host-root, and the broker's scope is set by the
host-root-owned instance role, not by the session.

## How a credential reaches the client — and where TLS termination comes in

This is the part the review flagged. It is worth being precise, because "just have the proxy
add the credential" sounds simple but runs into how HTTPS works.

**The setup.** Every request a session makes (git push, `gh` API, `aj` reads/writes to
Supabase) is **HTTPS** — encrypted end-to-end from the client *inside the session* to the
real host (github.com, the Supabase endpoint). Our egress proxy sits on the path, but for an
ordinary HTTPS tunnel all it sees is (1) the destination hostname (from the TLS `CONNECT` /
SNI, which is how it allowlists) and (2) an opaque stream of encrypted bytes. **It cannot
read or edit the `Authorization` header, because that header is inside the encrypted body.**
That is TLS doing its job.

So there are three ways to get a credential onto the request, and they differ in *who*
attaches it and *what infrastructure* it costs:

### (A) Credential helper + host-root broker — the v1 choice

The client attaches the credential itself, but it never *stores* one. It is configured with a
**credential helper**: at the moment it needs auth, it calls the **host-root broker** over a
local channel, the broker mints/fetches a fresh short-lived token off the VM identity, and
hands it back. `git` has this built in (`credential.helper`); `aj` and `gh` can read a token
from an env/file the broker refreshes.

- **No TLS surgery at all.** The proxy stays a plain hostname-allowlisting tunnel, exactly as
  the isolation doc describes. Nothing new to trust.
- **What the session holds:** a **short-lived, tightly-scoped token** (≤1h, repo-scoped for
  GitHub, agent-scoped for `aj`), in memory, for the moment of the request — **never a standing
  secret**. The standing secrets (GitHub App key, Claude key) stay central and off the box.
- **Residual:** because the token does transit the session process, a same-session compromise
  *can* read that token while it's live. Bounded hard: it is ≤1h and narrowly scoped, and egress
  is locked to the three allowlisted hosts (isolation node), so a stolen token is difficult to
  use *from elsewhere* and expires on its own. It cannot become a durable foothold.

### (B) Proxy-side injection via TLS termination — the v2 hardening

This is the "session holds nothing" shape, and the one the review is (rightly) not sold on.
To let the **proxy** rewrite the `Authorization` header, the proxy has to see the header —
which means it has to **decrypt the session's HTTPS**. That is **TLS termination**, and
concretely it means:

- The proxy presents **its own TLS certificate** to the client instead of GitHub's real one.
  For the client to accept it without screaming, the sandbox's trust store is pre-loaded with a
  **private certificate authority (CA) that host-root owns**. The proxy is now a *deliberate,
  trusted man-in-the-middle*: client → (TLS to proxy) → proxy decrypts, injects the real token
  → (fresh TLS to GitHub) → upstream.
- **What it buys:** the session's clients send requests with **no credential at all** (a
  placeholder), so a same-session compromise has **no `aj`/GitHub token to read** — not even a
  short-lived one. Blast radius shrinks to just the Claude key.
- **What it costs (why it's not v1):**
  - **A private CA is a new high-value secret.** If that CA's private key ever leaks, an
    attacker can impersonate *any* host to the sandbox (forge github.com, the Supabase endpoint,
    anything) — you have manufactured the exact MITM capability TLS exists to prevent, and now
    have to protect and rotate it.
  - **The proxy now sees GitHub + AgentJira traffic in plaintext.** It becomes a concentrated
    target holding live tokens *and* readable request bodies.
  - **Operational weight:** managing a trust store, CA rotation, and per-host termination — the
    isolation node explicitly skipped this at v1 to avoid exactly this machinery.

For a solo-operator v1 the marginal gain (removing a ≤1h scoped token from the session, when
the session already unavoidably holds the Claude key) does not justify standing up a MITM CA.
So (B) is documented as the **v2 hardening** to adopt if/when the threat model warrants it.

### (C) Plaintext-to-loopback reverse proxy — noted, not chosen

A middle option: reconfigure each client to talk **plain HTTP to the local proxy** (not
HTTPS), and let the proxy do the real TLS outbound with the token attached. This keeps the
token out of the session **without** a MITM CA, because the client isn't doing TLS to the
proxy at all. It's viable for `aj`/Supabase (endpoint base-URL override) but fiddly for `git`
(URL rewriting, absolute-URL redirects back to github.com). Kept on the table as a lighter
route to the (B) property, but not needed at v1.

**Bottom line for the reviewer:** "the proxy holds the credential and the session holds
nothing" is achievable (option B), but the only way to inject a header into an HTTPS request
is to break its encryption at the proxy — TLS termination — which means owning a private CA
that can impersonate any site to the sandbox. v1 avoids that and uses option (A): no standing
secret anywhere on the box, only a short-lived scoped token that transits the session while it
runs. Option (B) is the clearly-labelled next step if we want to remove even that token.

### Sessions longer than the token lifetime

The reviewer's question: if tokens expire in ~1h, how does a session that runs longer keep going?
The ~1h is a property of each *token*, **not a ceiling on session length**. The session never
depends on a single token lasting to the end — the **credential helper re-invokes the broker on
demand**, so when a token nears expiry the client transparently gets a freshly-minted one off the
VM's attached identity, which itself **never expires**. Concretely:

- **GitHub** — installation tokens are hard-capped at ~1h by GitHub; the broker re-mints from the
  App key whenever a `git`/`gh` call presents an aged-out token. A multi-hour session simply draws
  a new 1h token each time it needs one.
- **`aj`** — the Supabase agent JWT is refreshed (or re-exchanged from the central agent key) by
  the broker before it lapses, the same way.
- **Claude** — Claude Code refreshes its short-lived OAuth **access** token **in-process** from the
  Max-plan login credential for the whole session, so a long run never re-auths out of band.

Net: session length is unbounded by credential lifetime. Short token lifetimes cost nothing in
continuity — they only shrink the window a *stolen* token is usable — because re-minting is cheap
and keyed off the never-expiring attached identity. (The per-session mint-call **volume** this
implies scales with session length and is flagged for the cost node.)

## The three credentials

### 1. `aj` login — authenticating the sandbox to AgentJira

- **Name:** AgentJira agent session token (a short-lived Supabase-issued JWT for the agent
  service identity that `aj` uses).
- **Where it lives:** Minted by the **host-root broker** from the VM's attached identity via
  OIDC federation to a small AgentJira token broker, which returns a short-lived JWT scoped to
  the agent role. The session's `aj` reads that JWT from a broker-refreshed location at request
  time; **no standing secret** is stored in the session.
  - *Fallback if federation isn't wired at v1:* a long-lived agent key held in the **secrets
    manager**, fetched by the VM identity and exchanged for a session JWT — the exchange runs in
    the **broker**, so the standing secret stays central and only the minted JWT reaches the
    session.
- **Lifetime:** Session-scoped and short (e.g. ~1 hour), refreshed by the broker while the
  session runs; discarded at teardown. It expires on its own, and only the short-lived JWT — not
  any standing secret — is ever in the session.

### 2. Claude credentials — Anthropic/Claude auth for the Claude Code session

- **Name:** Claude Code **subscription (OAuth) login credential**. v1 runs Claude Code off the
  operator's **Max plan**, not a metered API key — so the credential is the Max-plan **OAuth token**
  (generated once for headless use via `claude setup-token` and supplied to the session as
  `CLAUDE_CODE_OAUTH_TOKEN`), *not* an `ANTHROPIC_API_KEY`. (An API key remains a drop-in alternative
  if we ever bill per-token, but it is not the v1 path.)
- **The exception — this one genuinely lives in the session.** Claude Code **authenticates
  in-process**: it reads the OAuth token from its own environment, attaches the auth itself, and
  refreshes the short-lived access token in-process from the login credential. Neither a broker nor a
  proxy can stand in for that in-client auth dance, so the credential must be **present inside the
  session**. This is the reviewer's flagged exception, and it makes Claude the credential with the
  largest in-session footprint.
- **Where it lives:** a subscription OAuth token does **not** federate with cloud IAM, so a
  durable secret must exist somewhere. It lives **centrally in the secrets manager** (source of
  truth, KMS-encrypted at rest), **never on the host at rest**. At session start the VM identity —
  under a tight, read-only policy scoped to just this secret — pulls it into **session memory
  (tmpfs)**, injected only into that session's sandbox. It is never written to the image or
  persistent disk, and never shared between sessions.
- **Lifetime:** the OAuth **access** token is short-lived and refreshed in-process for the life of
  the session; the durable **login/refresh** credential is long-lived *centrally* (rotated by
  re-running `setup-token`) but its **presence in the session is session-scoped** — fetched at start,
  wiped at teardown.
- **Blast radius (differs from an API key).** A leaked subscription token abuses the operator's
  **Max-plan account and quota**, not a metered spend, so an API-style *spend cap* doesn't apply.
  Bound it instead by: central-only storage, in-memory-only per session, egress locked to the three
  allowlisted hosts, and **revocation by rotating the login** (`setup-token`) if a leak is suspected.
  It is the one credential with account-level reach, which is why it is the residual weak point below.
- **Stronger option (v2, removes the exception) — with a cost tradeoff:** route Claude through a
  **cloud model gateway** so the VM's attached identity mints a short-lived token per session and
  **no Claude credential lives in the session at all**. Note the tension for the cost node: a gateway
  is **API-metered**, so this trades the Max plan's flat subscription cost for per-token API billing —
  a security win that is *not* cost-neutral. Flagged for v2, not mandated at v1.

### 3. GitHub access — repo access to raise PRs

- **Name:** GitHub App installation access token (from a GitHub App installed on the project
  repo, not a user credential).
- **Where it lives:** A GitHub App is installed on the repo with minimal permissions (contents
  + pull requests, write). The App's **private key** is the only standing GitHub secret and lives
  **centrally in the secrets manager** (KMS-encrypted) — never on the host. At session start (and
  on ~1h refresh) the **broker**, using the VM identity, fetches the App key, signs a JWT, and
  exchanges it for a **short-lived installation token** scoped to that one repo. That installation
  token is handed to the session's `git`/`gh` via the **credential helper** at request time; the
  App private key never reaches the session, and the session stores no standing credential — only
  the ≤1h installation token while it runs.
  - *Stronger v2:* move the App-key-to-installation-token exchange behind a small remote broker
    that itself trusts the VM's OIDC identity, so even the App private key leaves our control
    plane and the box only ever handles the 1-hour token.
- **Lifetime:** GitHub installation tokens are capped at **~1 hour**; re-minted by the broker on
  demand while the session runs, and they expire on their own at session end.

## v1 credential flow (summary)

| Credential | Name | Minted/held by | In the session? | Lifetime |
|---|---|---|---|---|
| `aj` login | AgentJira agent session JWT | **Host-root broker** (minted from VM identity via OIDC → token broker) | Only the ≤1h **JWT**, via credential helper — no standing secret | Session-scoped, ~1h, refreshed |
| Claude | Claude Code **Max-plan OAuth** login token (`setup-token`) | Central secrets manager → **session tmpfs** | **Yes** (the exception — in-process auth) | Access token refreshed in-process; login credential long-lived centrally / **session-scoped in memory** |
| GitHub | GitHub App installation token | **Host-root broker** (App key in secrets manager → installation token) | Only the ≤1h **installation token**, via credential helper — App key stays central | ~1h (GitHub cap), re-minted on demand |

**The v1 call:** the box holds **no self-managed long-lived secret**, and the session holds
**no standing secret** — only short-lived, narrowly-scoped tokens minted at request time off
the VM's attached identity by a host-root broker and handed to the clients via a credential
helper. The Claude credential is the one exception, because Claude Code authenticates
in-process; at v1 it is the operator's **Max-plan OAuth login token**, held centrally and pulled
into session memory only, and the v2 model-gateway path removes even that (moving Claude onto
API-metered billing). **v1 does not terminate TLS** — the proxy stays a plain
hostname-allowlist tunnel (consistent with the isolation node). Removing the short-lived tokens
from the session entirely is the **v2** proxy-injection hardening, which is what introduces TLS
termination.

## Security posture and residual risks

Being explicit about the flows and their risks (per spec-review — the human asked for strong
security and clarity on each flow):

- **No standing secret is ever in the session or on the host.** The App private key and the
  `aj` agent key stay central; the box's only standing credential is a *role* (the attached
  identity), which is not a secret and has nothing to exfiltrate. This is the main structural
  guarantee.
- **What a same-session compromise can reach.** The Claude key (in-process, unavoidable) and,
  *while a request is in flight*, the ≤1h scoped `aj`/GitHub token the credential helper just
  fetched. Bounded: those tokens are short-lived and narrowly scoped (repo-scoped GitHub,
  agent-scoped `aj`), egress is locked to the three allowlisted hosts (isolation node) so a
  stolen token is hard to use from anywhere else, and nothing durable is left behind at teardown.
- **The broker is a concentrated minting point, but not a plaintext MITM.** It holds the
  minting rights and briefly the freshly-minted tokens, in the host-root domain outside every
  sandbox (a confined session cannot read its memory, stop it, or reconfigure it). Crucially, at
  v1 it does **not** decrypt anyone's traffic — it only issues tokens — so it is not a new trust
  boundary over the plaintext of GitHub/AgentJira requests.
- **Why v1 skips TLS termination (the reviewer's question).** Terminating TLS to inject headers
  would require a **host-root-owned private CA in the sandbox trust store** — a MITM capability
  that, if its key leaked, lets an attacker impersonate any host to the sandbox, and it would put
  GitHub/AgentJira request bodies in plaintext at the proxy. The security it buys at v1 is only
  *removing a ≤1h scoped token from the session* — modest, given the Claude key is already in the
  session. Not worth manufacturing a MITM CA for one solo box; deferred to v2.
- **The Claude Max-plan login token is the weakest link** (durable, un-federatable, and
  unavoidably in the sandbox — and, being a subscription credential, its blast radius is the
  operator's account/quota rather than a metered spend). Bounded by: central-only storage,
  per-session in-memory fetch, egress locked to the allowlisted hosts, revocation by rotating the
  login (`setup-token`), and the v2 gateway path that removes the credential from the session
  entirely (at the cost of API-metered billing).
- **Attached-identity compromise = root of trust compromise.** If an attacker runs code as the
  VM identity they can mint/fetch everything. Mitigations: scope the instance role to the
  *minimum* (read the Claude + App secrets, call the token broker, nothing else); per-session
  sandboxing (`e126cb28`) so session code does not run *as* the box identity; egress limits at the
  VM network layer.
- **Broker/metadata as a target.** The token broker and metadata endpoint must reject anything
  but the VM's genuine identity (enforce IMDSv2-style hop limits / signed identity), or the
  minting guarantees collapse.
- **No secret at rest on the host** by construction — the highest-value, longest-lived attack
  surface (a key on disk or in the image) simply does not exist here.

## Rejected / deferred options (one line each)

- **Proxy-side header injection via TLS termination (the "session holds nothing" shape)** —
  strongest for session blast radius, but needs a host-root private CA that can impersonate any
  host to the sandbox; the v1 gain (dropping a ≤1h scoped token from the session) doesn't justify
  that MITM surface. **Deferred to v2**, not rejected.
- **Static cloud/access keys on the box** — a long-lived self-managed secret at rest on the
  host; exactly what the attached identity exists to eliminate.
- **Long-lived PAT / API key baked into the image or env** — ships a durable secret in every
  copy of the image, un-rotatable per session and impossible to scope down.
- **Personal GitHub PAT** — tied to a human account, over-broad, and long-lived; a GitHub App
  installation token is per-repo, least-privilege, and ~1h.
- **GitHub deploy key / SSH key on disk** — a standing private key at rest on the host, no
  per-session scoping and awkward to rotate.
- **Standing `aj` agent key in the session** — a long-lived secret in the sandbox; replaced by a
  broker-minted ≤1h JWT so the session holds no durable AgentJira credential.
- **Secrets baked into the Terraform state / image build** — leaks long-lived secrets into state
  files and image layers; the box should receive nothing durable.
- **Claude credential (Max-plan OAuth token or API key) on disk (no secrets manager)** — a
  long-lived secret persisted on the host with no central rotation, revocation, or scoping.

## Cross-node consistency note (isolation node `e126cb28` / PR #2)

**v1 is now consistent with the isolation doc:** the egress proxy remains a
**hostname-allowlist tunnel that does not terminate TLS**. Credentials are delivered by a
**host-root broker + client credential helper**, which needs no TLS interception and no trust
store — so nothing in the isolation posture is contradicted at v1.

The only place the two docs touch is the **v2 hardening**: if we later adopt proxy-side
injection to remove the short-lived tokens from the session, *that* introduces TLS termination
for the two injected hosts (GitHub + AgentJira), with the Anthropic host staying a plain tunnel.
At that point the isolation and cost docs should be revisited together to add the trust-store /
CA machinery. Flagged here so the future change is a conscious, shared decision rather than a
surprise.

## Handoff note to the cost node (`9e56122f`)

This node firm-blocks cost. The credential flow introduces these **cost-bearing pieces** to
price at v1 scale (one solo operator, a single VM, looping sessions):

- **Secrets manager** — stores the Claude Max-plan OAuth login token and the GitHub App private
  key; priced per stored secret + per API access. Every session start does at least one fetch
  (Claude login token + App key).
- **KMS** — encrypts those secrets at rest and backs the manager; priced per key + per
  cryptographic operation (decrypt on each fetch).
- **Per-session token minting (in the host-root broker)** — STS-style / OIDC token exchange for
  `aj`, and the GitHub App-key → installation-token exchange, run once (or a few times) per
  session and re-minted on ~1h refresh; some providers price token-exchange / STS calls, so call
  volume scales with session length and count.
- **The broker itself adds no new box** — it is a tiny always-on helper co-located with the
  already-required egress proxy on the same VM (negligible RAM/CPU at solo volume). **No TLS
  termination at v1**, so there is *no* CA/trust-store cost and no per-request TLS-termination
  overhead in the v1 baseline.
- **(If the v2 hardening is taken)** proxy-side TLS injection would add a **CA/trust-store** to
  provision and rotate plus per-request TLS-termination CPU for GitHub + AgentJira — flagged as a
  v2 line item, not v1.
- **(If the v2 gateway path is taken)** a **cloud model gateway** for Claude would shift Claude
  auth to per-session minted tokens (removing the secrets-manager line for Claude, and removing
  the last in-session credential) but **moves Claude from the Max plan's flat subscription onto
  per-token API billing** plus gateway request pricing — a potentially large cost swing, flagged so
  cost can compare the flat-subscription (v1) and metered (v2) shapes deliberately.

The attached instance role itself is **free** (it is IAM, not a resource), and colocating the
credential broker in the already-required egress proxy adds **no new box**. Net v1 cost is small
and dominated by secrets-manager storage + KMS operations + per-session mint calls, all scaling
with session count rather than being fixed.
