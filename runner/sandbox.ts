// Per-session sandbox (bubblewrap).
//
// Confines each Claude Code session in an unprivileged `bwrap` user namespace so
// the session **never holds host-root** — the load-bearing precondition that
// makes the host firewall/proxy un-bypassable (a confined session cannot edit
// nftables or reconfigure the proxy). Also gives process + filesystem isolation
// and forces egress through the host-local proxy.
//
// Layering (see docs/sandboxing/network-isolation.md, layers 3–4):
//   - The default-deny firewall + allowlisting proxy + the per-session
//     proxy-identity scheme are the VM image's job (node c9315e26). This module
//     only *consumes* that scheme: it forwards a proxy URL (whatever form the
//     image hands us — a per-sandbox loopback port OR a per-sandbox credential,
//     both just a URL string) into the sandbox env. It does not pin the contract.
//   - Credential *provisioning* into the session (which auth vars, via what
//     helper) is owned by the credential-flow node. This module gives the session
//     a clean, writable, isolated HOME for that layer to populate; it does not
//     bind the host home or host credential files into the sandbox.

import { existsSync } from "node:fs";

export interface ProxyConfig {
  httpsProxy?: string;
  httpProxy?: string;
  noProxy?: string;
}

export type SandboxMode = "on" | "off";

export interface SandboxPlan {
  /** Binary to spawn (`bwrap` when sandboxed, else the inner bin). */
  bin: string;
  /** Full argv for that binary (bwrap opts + inner command, or just inner args). */
  args: string[];
  sandboxed: boolean;
}

const TRUE_VALUES = new Set(["1", "on", "true", "yes", "force"]);
const FALSE_VALUES = new Set(["0", "off", "false", "no"]);

/**
 * Decide whether the session should be sandboxed.
 * `LOOP_SANDBOX` forces it on/off; unset ⇒ auto (on for Linux, off elsewhere —
 * bwrap is a Linux-only kernel feature, and local dev on other platforms is a
 * supported v1 escape hatch).
 */
export function sandboxMode(env: NodeJS.ProcessEnv, platform: NodeJS.Platform): SandboxMode {
  const raw = (env.LOOP_SANDBOX ?? "").trim().toLowerCase();
  if (TRUE_VALUES.has(raw)) return "on";
  if (FALSE_VALUES.has(raw)) return "off";
  return platform === "linux" ? "on" : "off";
}

/** True when `LOOP_SANDBOX` explicitly demands sandboxing (fail-closed if unavailable). */
export function sandboxForced(env: NodeJS.ProcessEnv): boolean {
  return TRUE_VALUES.has((env.LOOP_SANDBOX ?? "").trim().toLowerCase());
}

/**
 * Resolve the proxy the sandbox must route egress through, consuming — without
 * pinning — node c9315e26's per-session proxy-identity scheme. `LOOP_SESSION_PROXY`
 * (a single URL the image/spawn layer sets per session) applies to both schemes;
 * standard `HTTPS_PROXY`/`HTTP_PROXY`/`NO_PROXY` are honoured as a fallback.
 */
export function resolveProxy(env: NodeJS.ProcessEnv): ProxyConfig {
  const session = env.LOOP_SESSION_PROXY?.trim() || undefined;
  const httpsProxy = env.HTTPS_PROXY?.trim() || env.https_proxy?.trim() || session;
  const httpProxy = env.HTTP_PROXY?.trim() || env.http_proxy?.trim() || session;
  const noProxy = env.NO_PROXY?.trim() || env.no_proxy?.trim() || undefined;
  return { httpsProxy, httpProxy, noProxy };
}

// Read-only host paths the runtime needs (binaries, libraries, system config
// incl. CA certs + resolv.conf). Bound read-only so a confined session cannot
// tamper with them. Absent paths are skipped so the same rule set works across
// merged-usr and non-merged-usr layouts.
const RO_SYSTEM_PATHS = ["/usr", "/bin", "/sbin", "/lib", "/lib32", "/lib64", "/etc", "/opt"];

const SANDBOX_HOME = "/home/agent";

export interface BwrapOptions {
  /** The session's own working directory — the ONLY host path bound writable. */
  workdir: string;
  proxy: ProxyConfig;
  /** Injected for tests; defaults to fs.existsSync. */
  exists?: (p: string) => boolean;
}

/**
 * Build the `bwrap` argument vector (options + the inner command appended).
 * Confinement:
 *   - unprivileged user namespace ⇒ no host-root (root inside the ns maps to the
 *     caller's unprivileged host uid, never host uid 0);
 *   - separate PID/IPC/UTS/cgroup namespaces ⇒ can't see or signal host/sibling
 *     processes; new session ⇒ no shared-tty (TIOCSTI) escape;
 *   - the host root fs is NOT mounted; only an allowlist of read-only system
 *     paths plus the session's own writable workdir and a fresh tmpfs HOME —
 *     other sessions' data and host credential files are simply unreachable;
 *   - the network namespace is deliberately shared (NOT unshared) so the session
 *     can reach the host-local proxy; network confinement is the host firewall's
 *     job (c9315e26), not a per-session net namespace.
 */
export function buildBwrapArgs(
  innerBin: string,
  innerArgs: string[],
  opts: BwrapOptions
): string[] {
  const exists = opts.exists ?? existsSync;
  const args: string[] = [
    "--unshare-user",
    "--unshare-pid",
    "--unshare-ipc",
    "--unshare-uts",
    "--unshare-cgroup-try",
    "--new-session",
    "--die-with-parent",
    "--proc", "/proc",
    "--dev", "/dev",
    "--tmpfs", "/tmp",
  ];

  for (const p of RO_SYSTEM_PATHS) {
    if (exists(p)) args.push("--ro-bind", p, p);
  }

  // Fresh, writable, isolated HOME (no host home bound). The credential-flow
  // layer populates session credentials here; nothing standing is bound in.
  args.push("--tmpfs", SANDBOX_HOME, "--setenv", "HOME", SANDBOX_HOME);

  // The session's own workdir is the only writable host path.
  args.push("--bind", opts.workdir, opts.workdir, "--chdir", opts.workdir);

  // Egress: point the session at the host proxy. Both env vars (honoured by the
  // Anthropic SDK, supabase-js, and git's http backend) and explicit git proxy
  // config, injected via GIT_CONFIG_* so no gitconfig file is written.
  const { httpsProxy, httpProxy, noProxy } = opts.proxy;
  if (httpsProxy) args.push("--setenv", "HTTPS_PROXY", httpsProxy, "--setenv", "https_proxy", httpsProxy);
  if (httpProxy) args.push("--setenv", "HTTP_PROXY", httpProxy, "--setenv", "http_proxy", httpProxy);
  if (noProxy) args.push("--setenv", "NO_PROXY", noProxy, "--setenv", "no_proxy", noProxy);
  const gitProxy = httpProxy ?? httpsProxy;
  if (gitProxy) {
    args.push(
      "--setenv", "GIT_CONFIG_COUNT", "1",
      "--setenv", "GIT_CONFIG_KEY_0", "http.proxy",
      "--setenv", "GIT_CONFIG_VALUE_0", gitProxy
    );
  }

  // Inner command. `bwrap` stops parsing its own options at the first
  // non-option token (the bin name), so the inner `--flags` reach the command.
  args.push(innerBin, ...innerArgs);
  return args;
}

/**
 * Produce the spawn plan for a session: either a bwrap-wrapped command or, when
 * sandboxing is off, the inner command unchanged.
 */
export function planSession(
  innerBin: string,
  innerArgs: string[],
  opts: { env: NodeJS.ProcessEnv; platform: NodeJS.Platform; workdir: string; exists?: (p: string) => boolean }
): SandboxPlan {
  if (sandboxMode(opts.env, opts.platform) === "off") {
    return { bin: innerBin, args: innerArgs, sandboxed: false };
  }
  const args = buildBwrapArgs(innerBin, innerArgs, {
    workdir: opts.workdir,
    proxy: resolveProxy(opts.env),
    exists: opts.exists,
  });
  return { bin: "bwrap", args, sandboxed: true };
}
