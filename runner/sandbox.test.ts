import { describe, it, expect } from "vitest";
import { buildBwrapArgs, parseSandboxEnv, type SandboxEnv } from "./sandbox";

const PROXY = "http://127.0.0.1:3128";
const WORKDIR = "/srv/session-work";

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

  it("binds the workdir and chdirs into it", () => {
    expect(
      hasSeq(build(), ["--bind", WORKDIR, WORKDIR, "--chdir", WORKDIR]),
    ).toBe(true);
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

  it("consults the exists seam for every system path it ro-binds", () => {
    const probed: string[] = [];
    const args = build({
      exists: (p) => {
        probed.push(p);
        return true;
      },
    });
    expect(probed).toEqual([
      "/usr",
      "/bin",
      "/sbin",
      "/lib",
      "/lib32",
      "/lib64",
      "/etc",
      "/opt",
    ]);
    expect(countOf(args, "--ro-bind")).toBe(probed.length);
    for (const p of probed)
      expect(hasSeq(args, ["--ro-bind", p, p])).toBe(true);
  });

  it("puts the inner command and its args last", () => {
    expect(build().slice(-3)).toEqual(["claude", "--print", "hello"]);
  });
});

describe("parseSandboxEnv", () => {
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

  it("keeps NO_PROXY when supplied, trimmed", () => {
    expect(
      parseSandboxEnv({
        LOOP_SESSION_PROXY: PROXY,
        LOOP_SESSION_WORKDIR: WORKDIR,
        NO_PROXY: "  localhost,127.0.0.1  ",
      }),
    ).toEqual({
      ok: true,
      env: {
        LOOP_SESSION_PROXY: PROXY,
        LOOP_SESSION_WORKDIR: WORKDIR,
        NO_PROXY: "localhost,127.0.0.1",
      },
    });
  });

  const detailOf = (raw: NodeJS.ProcessEnv): string => {
    const result = parseSandboxEnv(raw);
    if (result.ok) throw new Error("expected a rejection");
    return result.detail;
  };

  it.each([
    [
      "a malformed proxy URL",
      { LOOP_SESSION_PROXY: "127.0.0.1:3128", LOOP_SESSION_WORKDIR: WORKDIR },
      "LOOP_SESSION_PROXY: must be a proxy URL, e.g. http://127.0.0.1:3128",
    ],
    [
      "a missing proxy URL",
      { LOOP_SESSION_WORKDIR: WORKDIR },
      "LOOP_SESSION_PROXY: must be a proxy URL, e.g. http://127.0.0.1:3128",
    ],
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
    [
      "a blank NO_PROXY",
      {
        LOOP_SESSION_PROXY: PROXY,
        LOOP_SESSION_WORKDIR: WORKDIR,
        NO_PROXY: "   ",
      },
      "NO_PROXY: Too small: expected string to have >=1 characters",
    ],
  ])("rejects %s, naming the field", (_label, raw, detail) => {
    expect(detailOf(raw)).toBe(detail);
  });

  it("joins every issue into one detail line", () => {
    expect(detailOf({})).toBe(
      "LOOP_SESSION_PROXY: must be a proxy URL, e.g. http://127.0.0.1:3128; LOOP_SESSION_WORKDIR: must be a path",
    );
  });
});
