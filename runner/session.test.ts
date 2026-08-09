import { describe, it, expect, vi, afterEach } from "vitest";
import { wireSessionOutput, sessionReportedError } from "./session";
import { pipedChild } from "./test-harness";

afterEach(() => vi.restoreAllMocks());

describe("wireSessionOutput", () => {
  it("accumulates stdout and mirrors both streams to stderr", () => {
    const write = vi.spyOn(process.stderr, "write").mockReturnValue(true);
    const child = pipedChild();
    const getStdout = wireSessionOutput(child);

    expect(getStdout()).toBe("");
    child.stdout.emit("data", "one ");
    child.stdout.emit("data", "two");
    child.stderr.emit("data", "warn");

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
