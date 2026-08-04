import { describe, it, expect, vi, afterEach } from "vitest";
import { EventEmitter } from "node:events";
import type { ChildProcess } from "node:child_process";

vi.mock("./session", () => ({ spawnTool: vi.fn() }));

import { spawnTool } from "./session";
import { makeLog, emitResult, preflight } from "./entrypoint";

afterEach(() => vi.restoreAllMocks());

function fakeChild(): ChildProcess {
  const child = new EventEmitter() as ChildProcess;
  Object.assign(child, {
    stdout: new EventEmitter(),
    stderr: new EventEmitter(),
  });
  return child;
}

// Drive preflight to completion by emitting on the child it spawned.
function runPreflight(drive: (child: ChildProcess) => void) {
  const child = fakeChild();
  vi.mocked(spawnTool).mockReturnValue(child);
  const result = preflight();
  drive(child);
  return result;
}

describe("makeLog", () => {
  it("writes prefixed, space-joined lines to stderr", () => {
    const write = vi.spyOn(process.stderr, "write").mockReturnValue(true);
    makeLog("run-task")("a", "b");
    expect(write).toHaveBeenCalledWith("[run-task] a b\n");
  });
});

describe("emitResult", () => {
  it("prints one result line with the node id and exits with the code", () => {
    const write = vi.spyOn(process.stdout, "write").mockReturnValue(true);
    const exit = vi
      .spyOn(process, "exit")
      .mockImplementation((() => {}) as never);

    emitResult("n1", 21, { outcome: "usage_limited", reset_at: 5 });

    expect(write).toHaveBeenCalledWith(
      '{"node_id":"n1","outcome":"usage_limited","reset_at":5}\n',
    );
    expect(exit).toHaveBeenCalledWith(21);
  });
});

describe("preflight", () => {
  it("queries aj whoami as json", async () => {
    await runPreflight((child) => {
      child.stdout!.emit("data", "{}");
      child.emit("close", 0);
    });
    expect(spawnTool).toHaveBeenCalledWith(
      "aj",
      ["whoami", "--json"],
      ["ignore", "pipe", "pipe"],
    );
  });

  it("passes on a clean exit with parseable json", async () => {
    const result = await runPreflight((child) => {
      child.stdout!.emit("data", '{"user"');
      child.stdout!.emit("data", ':"me"}');
      child.emit("close", 0);
    });
    expect(result).toEqual({ ok: true });
  });

  it("fails when aj is not runnable", async () => {
    const result = await runPreflight((child) =>
      child.emit("error", new Error("ENOENT")),
    );
    expect(result).toEqual({
      ok: false,
      detail: "`aj` not runnable: ENOENT",
    });
  });

  it("fails on a nonzero exit, quoting stderr", async () => {
    const result = await runPreflight((child) => {
      child.stderr!.emit("data", "no token\n");
      child.emit("close", 1);
    });
    expect(result.ok).toBe(false);
    expect(result.ok === false && result.detail).toBe(
      "`aj` not authenticated (whoami exit=1): no token",
    );
  });

  it("fails on a nonzero exit with no stderr, naming the env fallback", async () => {
    const result = await runPreflight((child) => child.emit("close", 1));
    expect(result.ok === false && result.detail).toContain(
      "no auth resolved from env vars",
    );
  });

  it("fails on unparseable output", async () => {
    const result = await runPreflight((child) => {
      child.stdout!.emit("data", "not json");
      child.emit("close", 0);
    });
    expect(result).toEqual({
      ok: false,
      detail: "`aj whoami` returned unparseable output",
    });
  });
});
