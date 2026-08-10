import { describe, it, expect, vi, afterEach } from "vitest";
import { type Script } from "../test-helpers/fake-child";
import { driveEntry } from "./test-harness";

const { spawnMock, preflightMock } = vi.hoisted(() => ({
  spawnMock: vi.fn(),
  preflightMock: vi.fn(),
}));
vi.mock("node:child_process", () => ({ spawn: spawnMock }));
vi.mock("./entrypoint", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./entrypoint")>()),
  preflight: preflightMock,
}));

const NODE = "n1";
const ARGV = process.argv;

interface RunOptions {
  argv?: string[];
  session?: Script;
  preflight?: () => Promise<{ ok: true } | { ok: false; detail: string }>;
  unwind?: boolean;
}

async function run(opts: RunOptions = {}) {
  preflightMock.mockImplementation(
    opts.preflight ?? (() => Promise.resolve({ ok: true })),
  );
  process.argv = ["node", "run-judge.ts", ...(opts.argv ?? [NODE])];
  return driveEntry(() => import("./run-judge"), spawnMock, {
    scripts: [opts.session ?? {}],
    unwind: opts.unwind,
  });
}

const verdictLine = (verdict: string, reason: string) =>
  JSON.stringify({ node_id: NODE, verdict, reason });

afterEach(() => {
  vi.restoreAllMocks();
  process.argv = ARGV;
});

describe("usage", () => {
  it("prints usage and exits 2 with no arguments", async () => {
    const { code, stderr } = await run({ argv: [] });
    expect(code).toBe(2);
    expect(stderr).toContain("Usage: run-judge <node-id>");
  });

  it("prints usage and exits 0 for -h", async () => {
    const { code } = await run({ argv: ["-h"] });
    expect(code).toBe(0);
  });
});

describe("verdicts", () => {
  it("passes a proceed verdict through, unwrapping the json envelope", async () => {
    const { code, result, spawns } = await run({
      session: {
        stdout: JSON.stringify({
          result: `here you go ${verdictLine("proceed", " settled ")}`,
        }),
      },
    });
    expect(code).toBe(0);
    expect(result).toEqual({
      node_id: NODE,
      verdict: "proceed",
      reason: "settled",
    });
    expect(spawns[0][0]).toBe("claude");
  });

  it("reads a verdict from raw stdout when the envelope is malformed", async () => {
    const { code, result } = await run({
      session: { stdout: verdictLine("not_yet", "unsettled") },
    });
    expect(code).toBe(10);
    expect(result.reason).toBe("unsettled");
  });

  it("falls back to not_yet when there is no verdict", async () => {
    const { code, result } = await run({ session: { stdout: "no idea" } });
    expect(code).toBe(10);
    expect(result.reason).toBe("no well-formed verdict in session output");
  });
});

describe("failure paths", () => {
  it("returns not_yet when the aj preflight fails", async () => {
    const { code, result } = await run({
      preflight: () => Promise.resolve({ ok: false, detail: "no auth" }),
    });
    expect(code).toBe(10);
    expect(result.reason).toBe("preflight: no auth");
  });

  it("returns not_yet on a nonzero session exit", async () => {
    const { result } = await run({ session: { stdout: "hi", code: 4 } });
    expect(result.reason).toBe("session error (exit=4)");
  });

  it("returns not_yet when the session envelope reports is_error", async () => {
    const { result } = await run({
      session: { stdout: JSON.stringify({ is_error: true }), code: 0 },
    });
    expect(result.reason).toBe("session error (exit=0 is_error=true)");
  });

  it("returns not_yet when the session cannot be spawned", async () => {
    const { result, stderr } = await run({ session: { error: "ENOENT" } });
    expect(stderr).toContain("failed to spawn session: ENOENT");
    expect(result.reason).toBe("session error (exit=null is_error=true)");
  });

  it("reports a thrown Error", async () => {
    const { code, result } = await run({
      unwind: false,
      preflight: () => Promise.reject(new Error("boom")),
    });
    expect(code).toBe(10);
    expect(result).toEqual({
      node_id: NODE,
      verdict: "not_yet",
      reason: "runner error: boom",
    });
  });

  it("reports a thrown non-Error", async () => {
    const { result } = await run({
      unwind: false,
      argv: [],
      preflight: () => Promise.reject("plain"),
    });
    expect(result).toEqual({
      node_id: null,
      verdict: "not_yet",
      reason: "runner error: plain",
    });
  });
});
