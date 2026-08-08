import { describe, it, expect } from "vitest";
import { buildBwrapArgs, parseSandboxEnv, type SandboxEnv } from "./sandbox";

const PROXY = "http://127.0.0.1:3128";
const WORKDIR = "/srv/session-work";
const PROXY_DETAIL =
  "LOOP_SESSION_PROXY: must be a proxy URL, e.g. http://127.0.0.1:3128";

const RO_SYSTEM_PATHS = [
  "/usr",
  "/bin",
  "/sbin",
  "/lib",
  "/lib32",
  "/lib64",
  "/etc",
  "/opt",
];

const env = (over: Partial<SandboxEnv> = {}): SandboxEnv => ({
  LOOP_SESSION_PROXY: PROXY,
  LOOP_SESSION_WORKDIR: WORKDIR,
  ...over,
});

const build = (
  opts: { env?: SandboxEnv; exists?: (p: string) => boolean } = {},
) =>
  buildBwrapArgs("claude", ["--print", "hello"], {
    env: opts.env ?? env(),
    exists: opts.exists ?? (() => true),
  });

function hasSeq(args: string[], seq: string[]): boolean {
  return args.some((_, i) => seq.every((s, j) => args[i + j] === s));
}

function countOf(args: string[], value: string): number {
  return args.filter((a) => a === value).length;
}

describe("buildBwrapArgs", () => {
  it.each([
    "--unshare-user",
    "--unshare-pid",
    "--unshare-ipc",
    "--unshare-uts",
    "--unshare-cgroup-try",
    "--new-session",
    "--die-with-parent",
  ])("sets the %s confinement flag", (flag) => {
    expect(build()).toContain(flag);
  });

  it("mounts a private /proc, /dev and /tmp", () => {
    const args = build();
    expect(hasSeq(args, ["--proc", "/proc"])).toBe(true);
    expect(hasSeq(args, ["--dev", "/dev"])).toBe(true);
    expect(hasSeq(args, ["--tmpfs", "/tmp"])).toBe(true);
  });

  it("gives the session a throwaway HOME", () => {
    expect(
      hasSeq(build(), [
        "--tmpfs",
        "/home/agent",
        "--setenv",
        "HOME",
        "/home/agent",
      ]),
    ).toBe(true);
  });

  it("makes the workdir the only writable host bind", () => {
    const args = build();
    expect(hasSeq(args, ["--bind", WORKDIR, WORKDIR, "--chdir", WORKDIR])).toBe(
      true,
    );
    expect(countOf(args, "--bind")).toBe(1);
  });

  it("sets every proxy env var, including the git http.proxy trio", () => {
    const args = build();
    for (const key of [
      "HTTPS_PROXY",
      "https_proxy",
      "HTTP_PROXY",
      "http_proxy",
    ]) {
      expect(hasSeq(args, ["--setenv", key, PROXY])).toBe(true);
    }
    expect(hasSeq(args, ["--setenv", "GIT_CONFIG_COUNT", "1"])).toBe(true);
    expect(hasSeq(args, ["--setenv", "GIT_CONFIG_KEY_0", "http.proxy"])).toBe(
      true,
    );
    expect(hasSeq(args, ["--setenv", "GIT_CONFIG_VALUE_0", PROXY])).toBe(true);
  });

  it("omits NO_PROXY unless it was supplied", () => {
    expect(build()).not.toContain("NO_PROXY");
  });

  it("sets both NO_PROXY spellings when supplied", () => {
    const args = build({ env: env({ NO_PROXY: "localhost,127.0.0.1" }) });
    expect(hasSeq(args, ["--setenv", "NO_PROXY", "localhost,127.0.0.1"])).toBe(
      true,
    );
    expect(hasSeq(args, ["--setenv", "no_proxy", "localhost,127.0.0.1"])).toBe(
      true,
    );
  });

  it("ro-binds no system paths when none exist", () => {
    expect(build({ exists: () => false })).not.toContain("--ro-bind");
  });

  it("ro-binds only the system paths the exists seam confirms", () => {
    const args = build({ exists: (p) => p === "/usr" });
    expect(countOf(args, "--ro-bind")).toBe(1);
    expect(hasSeq(args, ["--ro-bind", "/usr", "/usr"])).toBe(true);
    expect(args).not.toContain("/etc");
  });

  it("probes exactly the expected system paths, read-only every time", () => {
    const probed: string[] = [];
    const args = build({
      exists: (p) => {
        probed.push(p);
        return true;
      },
    });
    expect(probed).toEqual(RO_SYSTEM_PATHS);
    expect(countOf(args, "--ro-bind")).toBe(RO_SYSTEM_PATHS.length);
    for (const p of RO_SYSTEM_PATHS) {
      expect(hasSeq(args, ["--ro-bind", p, p])).toBe(true);
      expect(hasSeq(args, ["--bind", p, p])).toBe(false);
    }
  });

  it("falls back to the real fs when no exists seam is given", () => {
    expect(() => buildBwrapArgs("claude", [], { env: env() })).not.toThrow();
  });

  it.each([
    ["without NO_PROXY", env()],
    ["with NO_PROXY", env({ NO_PROXY: "localhost" })],
  ])("puts the inner command and its args last %s", (_label, sandboxEnv) => {
    expect(build({ env: sandboxEnv }).slice(-3)).toEqual([
      "claude",
      "--print",
      "hello",
    ]);
  });
});

describe("parseSandboxEnv", () => {
  const detailOf = (raw: NodeJS.ProcessEnv): string => {
    const result = parseSandboxEnv(raw);
    expect(result.ok).toBe(false);
    return result.ok === false ? result.detail : "";
  };

  it("accepts a well-formed environment", () => {
    const result = parseSandboxEnv({
      LOOP_SESSION_PROXY: PROXY,
      LOOP_SESSION_WORKDIR: WORKDIR,
    });
    expect(result).toEqual({
      ok: true,
      env: { LOOP_SESSION_PROXY: PROXY, LOOP_SESSION_WORKDIR: WORKDIR },
    });
  });

  it.each<[string, NodeJS.ProcessEnv, string]>([
    [
      "a malformed proxy URL",
      { LOOP_SESSION_PROXY: "127.0.0.1:3128", LOOP_SESSION_WORKDIR: WORKDIR },
      PROXY_DETAIL,
    ],
    ["a missing proxy URL", { LOOP_SESSION_WORKDIR: WORKDIR }, PROXY_DETAIL],
    [
      "a blank workdir",
      { LOOP_SESSION_PROXY: PROXY, LOOP_SESSION_WORKDIR: "   " },
      "LOOP_SESSION_WORKDIR: must be a non-empty path",
    ],
    [
      "a missing workdir",
      { LOOP_SESSION_PROXY: PROXY },
      "LOOP_SESSION_WORKDIR: must be a path",
    ],
  ])("rejects %s with the exact detail", (_label, raw, detail) => {
    expect(detailOf(raw)).toBe(detail);
  });

  it("joins every issue into a single detail string", () => {
    expect(detailOf({})).toBe(
      `${PROXY_DETAIL}; LOOP_SESSION_WORKDIR: must be a path`,
    );
  });

  it("accepts NO_PROXY and trims it", () => {
    const result = parseSandboxEnv({
      LOOP_SESSION_PROXY: PROXY,
      LOOP_SESSION_WORKDIR: WORKDIR,
      NO_PROXY: "  localhost,127.0.0.1  ",
    });
    expect(result).toEqual({
      ok: true,
      env: {
        LOOP_SESSION_PROXY: PROXY,
        LOOP_SESSION_WORKDIR: WORKDIR,
        NO_PROXY: "localhost,127.0.0.1",
      },
    });
  });

  it("rejects a blank NO_PROXY", () => {
    expect(
      detailOf({
        LOOP_SESSION_PROXY: PROXY,
        LOOP_SESSION_WORKDIR: WORKDIR,
        NO_PROXY: "   ",
      }),
    ).toMatch(/^NO_PROXY: /);
  });
});
