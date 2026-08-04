import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { EventEmitter } from "node:events";
import type { ChildProcess } from "node:child_process";

vi.mock("./session", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./session")>()),
  spawnTool: vi.fn(),
}));
vi.mock("./entrypoint", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./entrypoint")>()),
  preflight: vi.fn(),
}));

const NODE = "n1";
const ARGV = process.argv;

interface Script {
  stdout?: string;
  stderr?: string;
  code?: number | null;
  error?: string;
}

function fakeChild(): ChildProcess {
  const child = new EventEmitter() as ChildProcess;
  Object.assign(child, {
    stdout: new EventEmitter(),
    stderr: new EventEmitter(),
    stdin: Object.assign(new EventEmitter(), { write: vi.fn(), end: vi.fn() }),
  });
  return child;
}

// process.exit never returns, so the stub throws to unwind main the way the real
// thing does. The module's top-level .catch then exits once more on its way out —
// that second exit must return, or the throw escapes as an unhandled rejection.
// `unwind: false` is for the tests where main throws on its own.
class ExitSignal extends Error {}

interface RunOptions {
  argv?: string[];
  scripts?: Script[];
  preflight?: () => Promise<{ ok: true } | { ok: false; detail: string }>;
  unwind?: boolean;
}

async function run(opts: RunOptions = {}) {
  const exits: number[] = [];
  const out: string[] = [];
  const err: string[] = [];
  vi.spyOn(process.stdout, "write").mockImplementation((c) => {
    out.push(String(c));
    return true;
  });
  vi.spyOn(process.stderr, "write").mockImplementation((c) => {
    err.push(String(c));
    return true;
  });
  vi.spyOn(process, "exit").mockImplementation(((code = 0) => {
    exits.push(code);
    if ((opts.unwind ?? true) && exits.length === 1) throw new ExitSignal();
  }) as never);

  process.argv = ["node", "run-task.ts", ...(opts.argv ?? [NODE])];

  vi.resetModules();
  const session = await import("./session");
  const entrypoint = await import("./entrypoint");

  const scripts = opts.scripts ?? [];
  const spawns: [string, string[]][] = [];
  vi.mocked(session.spawnTool).mockImplementation((bin, args) => {
    spawns.push([bin, args]);
    const child = fakeChild();
    const s = scripts.shift() ?? {};
    setImmediate(() => {
      if (child.stdin!.listenerCount("error"))
        child.stdin!.emit("error", new Error("EPIPE"));
      if (s.error) return void child.emit("error", new Error(s.error));
      if (s.stdout) child.stdout!.emit("data", s.stdout);
      if (s.stderr) child.stderr!.emit("data", s.stderr);
      child.emit("close", s.code ?? 0);
    });
    return child;
  });
  vi.mocked(entrypoint.preflight).mockImplementation(
    opts.preflight ?? (() => Promise.resolve({ ok: true })),
  );

  await import("./run-task");
  await vi.waitFor(() => expect(exits.length).toBeGreaterThan(0));

  return {
    code: exits[0],
    stderr: err.join(""),
    spawns,
    result: out.length ? JSON.parse(out[0]) : null,
  };
}

const envelope = (result: string) => JSON.stringify({ result });
const OK_BWRAP: Script = { code: 0 };
const OK_SESSION: Script = { stdout: envelope("done"), code: 0 };
const status = (s: string): Script => ({
  stdout: JSON.stringify({ node: { status: s } }),
  stderr: "aj chatter\n",
  code: 0,
});

beforeEach(() => {
  vi.stubEnv("LOOP_SESSION_PROXY", "http://127.0.0.1:3128");
  vi.stubEnv("LOOP_SESSION_WORKDIR", "/srv/session-work");
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  process.argv = ARGV;
});

describe("usage", () => {
  it("prints usage and exits 2 with no arguments", async () => {
    const { code, stderr } = await run({ argv: [] });
    expect(code).toBe(2);
    expect(stderr).toContain("Usage: run-task <node-id>");
  });

  it("prints usage and exits 0 for --help", async () => {
    const { code, stderr } = await run({ argv: ["--help"] });
    expect(code).toBe(0);
    expect(stderr).toContain("Usage: run-task <node-id>");
  });
});

describe("preflight gates", () => {
  it("errors when the sandbox env is invalid", async () => {
    vi.stubEnv("LOOP_SESSION_PROXY", "127.0.0.1:3128");
    const { code, result } = await run();
    expect(code).toBe(20);
    expect(result.outcome).toBe("errored");
    expect(result.detail).toContain("env: LOOP_SESSION_PROXY");
  });

  it("errors when the aj preflight fails", async () => {
    const { code, result } = await run({
      preflight: () => Promise.resolve({ ok: false, detail: "no auth" }),
    });
    expect(code).toBe(20);
    expect(result.detail).toBe("preflight: no auth");
  });

  it("errors when bwrap is not runnable", async () => {
    const { result } = await run({ scripts: [{ error: "ENOENT" }] });
    expect(result.detail).toContain("`bwrap` is not runnable (ENOENT)");
  });

  it("errors when bwrap --version exits nonzero", async () => {
    const { result } = await run({
      scripts: [{ stderr: "broken\n", code: 3 }],
    });
    expect(result.detail).toBe("sandbox: `bwrap --version` exit=3: broken");
  });
});

describe("session outcomes", () => {
  it("completes and sandboxes the session via bwrap", async () => {
    const { code, result, spawns } = await run({
      scripts: [OK_BWRAP, OK_SESSION, status("done")],
    });
    expect(code).toBe(0);
    expect(result).toEqual({
      node_id: NODE,
      outcome: "completed",
      detail: "node status=done",
    });
    expect(spawns[0]).toEqual(["bwrap", ["--version"]]);
    expect(spawns[1][0]).toBe("bwrap");
    expect(spawns[1][1]).toContain("claude");
    expect(spawns[2]).toEqual(["aj", ["context", NODE, "--json"]]);
  });

  it("reports asked_user when the node ends awaiting a human", async () => {
    const { code, result } = await run({
      scripts: [OK_BWRAP, OK_SESSION, status("awaiting_human_response")],
    });
    expect(code).toBe(10);
    expect(result.outcome).toBe("asked_user");
  });

  it("errors when the status lookup output is unparseable", async () => {
    const { result } = await run({
      scripts: [OK_BWRAP, OK_SESSION, { stdout: "junk", code: 0 }],
    });
    expect(result.detail).toBe("clean exit but node status lookup failed");
  });

  it("errors when the status lookup cannot be spawned", async () => {
    const { result } = await run({
      scripts: [OK_BWRAP, OK_SESSION, { error: "ENOENT" }],
    });
    expect(result.outcome).toBe("errored");
  });

  it("errors on a nonzero session exit", async () => {
    const { code, result } = await run({
      scripts: [OK_BWRAP, { stdout: envelope("bye"), code: 7 }, status("done")],
    });
    expect(code).toBe(20);
    expect(result.detail).toBe("session exit=7, node status=done");
  });

  it("errors when the session envelope reports is_error", async () => {
    const { result } = await run({
      scripts: [
        OK_BWRAP,
        { stdout: JSON.stringify({ is_error: true, result: "bad" }), code: 0 },
        status("done"),
      ],
    });
    expect(result.detail).toBe(
      "session exit=0 is_error=true, node status=done",
    );
  });

  it("says the status is unknown when both the session and the lookup fail", async () => {
    const { result } = await run({
      scripts: [OK_BWRAP, { code: 7 }, { stdout: "junk", code: 0 }],
    });
    expect(result.detail).toBe("session exit=7, node status=unknown");
  });

  it("errors when the session cannot be spawned", async () => {
    const { result, stderr } = await run({
      scripts: [OK_BWRAP, { error: "ENOENT" }, status("done")],
    });
    expect(stderr).toContain("failed to spawn session: ENOENT");
    expect(result.detail).toContain("session exit=null is_error=true");
  });
});

describe("error escalation", () => {
  it("escalates a usage limit to usage_limited with the reset epoch", async () => {
    const { code, result } = await run({
      scripts: [
        OK_BWRAP,
        {
          stdout: envelope("Claude AI usage limit reached|1750000000"),
          code: 1,
        },
        status("done"),
      ],
    });
    expect(code).toBe(21);
    expect(result.outcome).toBe("usage_limited");
    expect(result.reset_at).toBe(1750000000);
  });

  it("escalates a transient API failure to api_error", async () => {
    const { code, result } = await run({
      scripts: [
        OK_BWRAP,
        { stdout: envelope("overloaded_error"), code: 1 },
        status("done"),
      ],
    });
    expect(code).toBe(22);
    expect(result.outcome).toBe("api_error");
    expect(result.reset_at).toBeUndefined();
  });
});

describe("fatal errors", () => {
  it("reports a thrown Error", async () => {
    const { code, result } = await run({
      unwind: false,
      preflight: () => Promise.reject(new Error("boom")),
    });
    expect(code).toBe(20);
    expect(result).toEqual({
      node_id: NODE,
      outcome: "errored",
      detail: "runner error: boom",
    });
  });

  it("reports a thrown non-Error", async () => {
    const { result } = await run({
      unwind: false,
      preflight: () => Promise.reject("plain"),
    });
    expect(result.detail).toBe("runner error: plain");
  });
});
