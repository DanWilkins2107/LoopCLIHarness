import { existsSync } from "node:fs";
import { z } from "zod";

const SandboxEnvSchema = z.object({
  LOOP_SESSION_PROXY: z.url("must be a proxy URL, e.g. http://127.0.0.1:3128"),
  LOOP_SESSION_WORKDIR: z.string({ error: "must be a path" }).trim().min(1, "must be a non-empty path"),
  NO_PROXY: z.string().trim().min(1).optional(),
});

export type SandboxEnv = z.infer<typeof SandboxEnvSchema>;

export type EnvResult =
  | { ok: true; env: SandboxEnv }
  | { ok: false; detail: string };

export function parseSandboxEnv(env: NodeJS.ProcessEnv): EnvResult {
  const parsed = SandboxEnvSchema.safeParse(env);
  if (parsed.success) return { ok: true, env: parsed.data };
  const detail = parsed.error.issues
    .map((i) => `${i.path.join(".") || "(env)"}: ${i.message}`)
    .join("; ");
  return { ok: false, detail };
}

const RO_SYSTEM_PATHS = ["/usr", "/bin", "/sbin", "/lib", "/lib32", "/lib64", "/etc", "/opt"];

const SANDBOX_HOME = "/home/agent";

export interface BwrapOptions {
  env: SandboxEnv;
  exists?: (p: string) => boolean;
}

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

  args.push("--tmpfs", SANDBOX_HOME, "--setenv", "HOME", SANDBOX_HOME);
  args.push("--bind", workdir, workdir, "--chdir", workdir);

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

  // The network namespace is deliberately NOT unshared: the session must reach
  // the host-local proxy. Network confinement is the host firewall's job (c9315e26).
  args.push(innerBin, ...innerArgs);
  return args;
}
