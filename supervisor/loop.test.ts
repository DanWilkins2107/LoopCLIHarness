import { describe, it, expect, vi, afterEach } from "vitest";
import { EventEmitter } from "node:events";
import type { ChildProcessByStdio } from "node:child_process";
import type { Readable } from "node:stream";
import {
  RESET_MARGIN_S,
  LIMIT_COOLDOWN_S,
  MAX_RETRIES,
  IDLE_INTERVAL_S,
  IDLE_SHUTDOWN_S,
} from "./constants";

const { spawnMock, sleepMsMock } = vi.hoisted(() => ({
  spawnMock: vi.fn(),
  sleepMsMock: vi.fn(),
}));
vi.mock("node:child_process", () => ({ spawn: spawnMock }));
vi.mock("./backoff", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./backoff")>()),
  sleepMs: sleepMsMock,
}));

const NODE = "n1";
const ARGV = process.argv;

// sleepMsMock resolves immediately, so a mutant that breaks the shutdown path
// spins forever. Every loop iteration spawns `aj`, and a throw there is fatal in
// loop.ts, so capping that spawn turns a hang into a failed assertion.
// Exactly the longest legitimate run — the retry-budget test: MAX_RETRIES + 1
// node attempts, then the full idle window. A new longer test must raise this.
const MAX_AJ_SPAWNS = MAX_RETRIES + 1 + IDLE_SHUTDOWN_S / IDLE_INTERVAL_S + 1;

interface Script {
  stdout?: string;
  stderr?: string;
  code?: number | null;
  error?: string;
  onSpawn?: () => void;
}

// Signal handlers main installs, invoked directly — emitting a real SIGINT would
// take the test runner down with it.
let signals: Record<string, (() => void)[]> = {};
const raise = (sig: string) => (signals[sig] ?? []).forEach((h) => h());

// loop only ever spawns with stdio ["ignore", "pipe", "pipe"], so stdin is null
// and the two readable ends are EventEmitters the test drives directly.
type LoopChild = ChildProcessByStdio<null, Readable, Readable>;

function fakeChild(): LoopChild {
  return Object.assign(new EventEmitter(), {
    stdout: new EventEmitter(),
    stderr: new EventEmitter(),
  }) as unknown as LoopChild;
}

// process.exit never returns, so `unwind` makes the stub throw for the one test
// where main exits somewhere other than its final line.
class ExitSignal extends Error {}

const idle = (): Script => ({ stdout: '{"recommended":[]}' });
const recommend = (title?: string): Script => ({
  stdout: JSON.stringify({ recommended: [{ id: NODE, title }] }),
});
const outcome = (o: string, extra: Record<string, unknown> = {}): Script => ({
  stdout: `noise\n${JSON.stringify({ outcome: o, detail: "d", ...extra })}\n`,
  stderr: "runner chatter\n",
});

interface RunOptions {
  argv?: string[];
  tasks?: Script[];
  runs?: Script[];
  spawnThrows?: unknown;
  unwind?: boolean;
}

async function run(opts: RunOptions = {}) {
  const exits: number[] = [];
  const out: string[] = [];
  const err: string[] = [];
  const sleeps: number[] = [];
  const spawns: [string, string[]][] = [];
  let clock = 0;

  let markExited = (): void => {};
  const exited = new Promise<void>((r) => (markExited = r));

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
    markExited();
    if (opts.unwind && exits.length === 1) throw new ExitSignal();
  }) as never);
  vi.spyOn(Date, "now").mockImplementation(() => clock);

  vi.spyOn(process, "on").mockImplementation(((sig: string, h: () => void) => {
    (signals[sig] ??= []).push(h);
    return process;
  }) as never);

  process.argv = ["node", "loop.ts", ...(opts.argv ?? [])];

  sleepMsMock.mockImplementation((ms: number) => {
    sleeps.push(ms);
    clock += ms;
    return Promise.resolve();
  });

  const tasks = opts.tasks ?? [];
  const runs = opts.runs ?? [];
  let ajSpawns = 0;
  spawnMock.mockImplementation(((bin: string, args: string[]) => {
    if (opts.spawnThrows) throw opts.spawnThrows;
    if (bin === "aj" && ++ajSpawns > MAX_AJ_SPAWNS)
      throw new Error("spawn cap");
    spawns.push([bin, args]);
    const s = (bin === "aj" ? tasks.shift() : runs.shift()) ?? idle();
    const child = fakeChild();
    s.onSpawn?.();
    setImmediate(() => {
      if (s.error) return void child.emit("error", new Error(s.error));
      if (s.stdout) child.stdout.emit("data", s.stdout);
      if (s.stderr) child.stderr.emit("data", s.stderr);
      child.emit("close", s.code ?? 0);
    });
    return child;
  }) as never);

  vi.resetModules();
  await import("./loop");
  await exited;

  if (ajSpawns > MAX_AJ_SPAWNS)
    throw new Error(`loop did not terminate: exceeded ${MAX_AJ_SPAWNS} spawns`);

  return {
    code: exits[0],
    stderr: err.join(""),
    sleeps,
    spawns,
    summary: out.length ? JSON.parse(out[0]) : null,
  };
}

afterEach(() => {
  vi.restoreAllMocks();
  spawnMock.mockReset();
  sleepMsMock.mockReset();
  signals = {};
  process.argv = ARGV;
});

describe("arguments", () => {
  it("runs without a project filter by default", async () => {
    const { spawns, stderr } = await run();
    expect(spawns[0]).toEqual(["aj", ["tasks", "--json"]]);
    expect(stderr).toContain("[supervisor] starting\n");
  });

  it.each(["--project", "-p"])(
    "passes %s through to aj tasks",
    async (flag) => {
      const { spawns, stderr } = await run({ argv: [flag, "proj"] });
      expect(spawns[0]).toEqual(["aj", ["tasks", "--json", "-p", "proj"]]);
      expect(stderr).toContain("starting (project proj)");
    },
  );

  it("prints usage and exits 2 on a malformed project argument", async () => {
    const { code, stderr } = await run({ argv: ["--project"], unwind: true });
    expect(code).toBe(2);
    expect(stderr).toContain("Usage: loop [--project <id>]");
  });
});

describe("aj tasks failures", () => {
  it.each([
    ["not runnable", { error: "ENOENT" }, "aj tasks not runnable: ENOENT"],
    ["a nonzero exit", { code: 3 }, "aj tasks exited 3"],
    [
      "unparseable output",
      { stdout: "junk" },
      "aj tasks --json returned unparseable output",
    ],
  ])("aborts on %s", async (_label, script: Script, detail) => {
    const { code, stderr, summary } = await run({ tasks: [script] });
    expect(code).toBe(0);
    expect(stderr).toContain(`aborting: ${detail}`);
    expect(summary.attempted).toBe(0);
  });

  it("mirrors aj stderr and treats a missing recommended list as empty", async () => {
    const { stderr } = await run({ tasks: [{ stdout: "{}", stderr: "hmm" }] });
    expect(stderr).toContain("hmm");
    expect(stderr).toContain("idle — no recommended task");
  });
});

describe("idling", () => {
  it("sleeps between polls, then shuts down once idle long enough", async () => {
    const { code, stderr, sleeps } = await run();
    expect(sleeps).toEqual(
      Array(IDLE_SHUTDOWN_S / IDLE_INTERVAL_S).fill(IDLE_INTERVAL_S * 1000),
    );
    expect(stderr).toContain(
      `idle ${IDLE_SHUTDOWN_S}s with nothing in progress`,
    );
    expect(code).toBe(0);
  });
});

describe("node outcomes", () => {
  it.each(["completed", "asked_user", "errored"])(
    "counts a %s node",
    async (o) => {
      const { summary, spawns } = await run({
        tasks: [recommend()],
        runs: [outcome(o)],
      });
      expect(summary[o]).toBe(1);
      expect(spawns[1][0]).toBe("tsx");
      expect(spawns[1][1][1]).toBe(NODE);
    },
  );

  it("logs the node title when there is one", async () => {
    const { stderr } = await run({
      tasks: [recommend("Coverage gate")],
      runs: [outcome("completed")],
    });
    expect(stderr).toContain(`running ${NODE} — Coverage gate`);
    expect(stderr).toContain(`${NODE} -> completed (d)`);
  });

  it("logs a bare node id when there is no title", async () => {
    const { stderr } = await run({
      tasks: [recommend()],
      runs: [outcome("completed")],
    });
    expect(stderr).toContain(`running ${NODE}\n`);
  });

  it("errors the node when the runner cannot be spawned", async () => {
    const { summary, stderr } = await run({
      tasks: [recommend()],
      runs: [{ error: "ENOENT" }],
    });
    expect(summary.errored).toBe(1);
    expect(stderr).toContain("failed to spawn runner: ENOENT");
  });

  it("errors the node when the runner prints nothing parseable", async () => {
    const { summary, stderr } = await run({
      tasks: [recommend()],
      runs: [{ stdout: "junk" }],
    });
    expect(summary.errored_node_ids).toEqual([NODE]);
    expect(stderr).toContain("runner produced no parseable outcome");
  });

  it("tolerates a runner outcome with no detail", async () => {
    const { stderr } = await run({
      tasks: [recommend()],
      runs: [{ stdout: JSON.stringify({ outcome: "completed" }) }],
    });
    expect(stderr).toContain(`${NODE} -> completed ()`);
  });

  it("never re-runs a node it has already errored", async () => {
    const { spawns } = await run({
      tasks: [recommend(), recommend()],
      runs: [outcome("errored")],
    });
    expect(spawns.filter(([bin]) => bin === "tsx")).toHaveLength(1);
  });
});

describe("usage limits", () => {
  it("sleeps until the reported reset, plus the margin", async () => {
    const { sleeps } = await run({
      tasks: [recommend()],
      runs: [outcome("usage_limited", { reset_at: 100 })],
    });
    expect(sleeps[0]).toBe((100 + RESET_MARGIN_S) * 1000);
  });

  it("falls back to the fixed cooldown when no reset is reported", async () => {
    const { sleeps } = await run({
      tasks: [recommend()],
      runs: [outcome("usage_limited")],
    });
    expect(sleeps[0]).toBe(LIMIT_COOLDOWN_S * 1000);
  });
});

describe("api errors", () => {
  it("backs off and retries, then counts the eventual outcome once", async () => {
    const { summary, stderr, sleeps } = await run({
      tasks: [recommend(), recommend()],
      runs: [outcome("api_error"), outcome("completed")],
    });
    expect(stderr).toContain(`api-error; backoff`);
    expect(stderr).toContain(`(retry 1/${MAX_RETRIES})`);
    expect(sleeps[0]).toBeGreaterThan(0);
    expect(summary.completed).toBe(1);
    expect(summary.errored).toBe(0);
  });

  it("gives up after the retry budget and errors the node", async () => {
    const { summary, stderr } = await run({
      tasks: Array(MAX_RETRIES + 1).fill(recommend()),
      runs: Array(MAX_RETRIES + 1).fill(outcome("api_error")),
    });
    expect(stderr).toContain(`exhausted ${MAX_RETRIES} retries`);
    expect(summary.errored).toBe(1);
    expect(summary.errored_node_ids).toEqual([NODE]);
  });
});

describe("shutdown", () => {
  it("stops after the current node when a signal arrives", async () => {
    const { code, summary, stderr } = await run({
      tasks: [recommend()],
      runs: [{ ...outcome("completed"), onSpawn: () => raise("SIGINT") }],
    });
    expect(stderr).toContain("SIGINT received — stopping after current node");
    expect(summary).toEqual({
      attempted: 1,
      completed: 1,
      asked_user: 0,
      errored: 0,
      errored_node_ids: [],
    });
    expect(code).toBe(0);
  });

  it.each([
    [new Error("boom"), "fatal: boom"],
    ["plain", "fatal: plain"],
  ])("exits 1 on a fatal %s", async (thrown, expected) => {
    const { code, stderr } = await run({ spawnThrows: thrown });
    expect(code).toBe(1);
    expect(stderr).toContain(expected);
  });
});
