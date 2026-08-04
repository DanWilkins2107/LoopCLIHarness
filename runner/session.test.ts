import { describe, it, expect, vi, afterEach } from "vitest";
import { EventEmitter } from "node:events";
import type { ChildProcess } from "node:child_process";

vi.mock("node:child_process", () => ({ spawn: vi.fn() }));

import { spawn } from "node:child_process";
import { spawnTool, wireSessionOutput, sessionReportedError } from "./session";

afterEach(() => vi.restoreAllMocks());

function fakeChild(): ChildProcess {
  const child = new EventEmitter() as ChildProcess;
  Object.assign(child, {
    stdout: new EventEmitter(),
    stderr: new EventEmitter(),
  });
  return child;
}

describe("spawnTool", () => {
  it("spawns the bin with the given args and stdio", () => {
    const child = fakeChild();
    vi.mocked(spawn).mockReturnValue(child);
    expect(spawnTool("aj", ["whoami"], ["ignore", "pipe", "pipe"])).toBe(child);
    expect(spawn).toHaveBeenCalledWith("aj", ["whoami"], {
      stdio: ["ignore", "pipe", "pipe"],
    });
  });
});

describe("wireSessionOutput", () => {
  it("accumulates stdout and mirrors both streams to stderr", () => {
    const write = vi.spyOn(process.stderr, "write").mockReturnValue(true);
    const child = fakeChild();
    const getStdout = wireSessionOutput(child);

    expect(getStdout()).toBe("");
    child.stdout!.emit("data", "one ");
    child.stdout!.emit("data", "two");
    child.stderr!.emit("data", "warn");

    expect(getStdout()).toBe("one two");
    expect(write.mock.calls.map((c) => c[0])).toEqual(["one ", "two", "warn"]);
  });
});

describe("sessionReportedError", () => {
  it.each([
    ['{"is_error":true}', true],
    ['{"is_error":false}', false],
    ["{}", false],
    ["null", false],
    ["not json", false],
  ])("maps %s to %s", (stdout, expected) => {
    expect(sessionReportedError(stdout)).toBe(expected);
  });
});
