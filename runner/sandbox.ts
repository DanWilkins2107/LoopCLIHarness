import { existsSync } from "node:fs";
import { z } from "zod";

const SandboxEnvSchema = z.object({
  /**
   * The proxy every session's egress is forced through. A single URL, which
   * satisfies either form of node c9315e26's per-session proxy-identity scheme
   * (a per-sandbox loopback port or a per-sandbox credential) without pinning it.
   */
  LOOP_SESSION_PROXY: z.url("must be a proxy URL, e.g. http://127.0.0.1:3128"),
  /** The session's own working directory — the ONLY host path bound writable. */
  LOOP_SESSION_WORKDIR: z.string({ error: "must be a path" }).trim().min(1, "must be a non-empty path"),
  /** Optional hosts bypassing the proxy (e.g. the metadata service). */
  NO_PROXY: z.string().trim().min(1).optional(),
});

export type SandboxEnv = z.infer<typeof SandboxEnvSchema>;

export type EnvResult =
  | { ok: true; env: SandboxEnv }
  | { ok: false; detail: string };

/** Validate the sandbox env up front so a misconfigured session fails before it spawns. */
export function parseSandboxEnv(env: NodeJS.ProcessEnv): EnvResult {
  const parsed = SandboxEnvSchema.safeParse(env);
  if (parsed.success) return { ok: true, env: parsed.data };
  const detail = parsed.error.issues
    .map((i) => `${i.path.join(".") || "(env)"}: ${i.message}`)
    .join("; ");
  return { ok: false, detail };
}

// Read-only host paths the runtime needs (binaries, libraries, system config
// incl. CA certs + resolv.conf). Bound read-only so a confined session cannot
// tamper with them. Absent paths are skipped so the same rule set works across
// merged-usr and non-merged-usr layouts.
const RO_SYSTEM_PATHS = ["/usr", "/bin", "/sbin", "/lib", "/lib32", "/lib64", "/etc", "/opt"];

const SANDBOX_HOME = "/home/agent";

export interface BwrapOptions {
  env: SandboxEnv;
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
  const { LOOP_SESSION_PROXY: proxy, LOOP_SESSION_WORKDIR: workdir, NO_PROXY: noProxy } = opts.env;
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
  args.push("--bind", workdir, workdir, "--chdir", workdir);

  // Egress: point the session at the host proxy. Both env vars (honoured by the
  // Anthropic SDK, supabase-js, and git's http backend) and explicit git proxy
  // config, injected via GIT_CONFIG_* so no gitconfig file is written.
  args.push(
    "--setenv", "HTTPS_PROXY", proxy,
    "--setenv", "https_proxy", proxy,
    "--setenv", "HTTP_PROXY", proxy,
    "--setenv", "http_proxy", proxy,
    "--setenv", "GIT_CONFIG_COUNT", "1",
    "--setenv", "GIT_CONFIG_KEY_0", "http.proxy",
    "--setenv", "GIT_CONFIG_VALUE_0", proxy
  );
  if (noProxy) args.push("--setenv", "NO_PROXY", noProxy, "--setenv", "no_proxy", noProxy);

  // Inner command. `bwrap` stops parsing its own options at the first
  // non-option token (the bin name), so the inner `--flags` reach the command.
  args.push(innerBin, ...innerArgs);
  return args;
}

/** Spawn plan for a session: always `bwrap` — there is no unconfined path. */
export function planSession(
  innerBin: string,
  innerArgs: string[],
  opts: BwrapOptions
): { bin: string; args: string[] } {
  return { bin: "bwrap", args: buildBwrapArgs(innerBin, innerArgs, opts) };
}
