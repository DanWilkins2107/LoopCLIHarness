import { describe, it, expect } from "vitest";
import { extractVerdict } from "./verdict";

describe("extractVerdict", () => {
  it("returns the last well-formed verdict object", () => {
    const text = [
      'Thinking out loud: {"verdict": "proceed", "reason": "early guess"}',
      '{"node_id": "abc", "verdict": "not_yet", "reason": "still unsettled"}',
    ].join("\n");
    expect(extractVerdict(text)).toEqual({ verdict: "not_yet", reason: "still unsettled" });
  });

  it("skips malformed candidates and falls back to an earlier valid one", () => {
    const text = [
      '{"verdict": "not_yet", "reason": "unsettled"}',
      '{"verdict": "proceed", reason: not-json}',
    ].join("\n");
    expect(extractVerdict(text)).toEqual({ verdict: "not_yet", reason: "unsettled" });
  });

  it("rejects an unrecognised verdict string", () => {
    expect(extractVerdict('{"verdict": "maybe", "reason": "unsure"}')).toBeNull();
  });

  it("returns null when there is no verdict object at all", () => {
    expect(extractVerdict("I could not decide.")).toBeNull();
  });

  it("substitutes a placeholder for a blank or missing reason", () => {
    expect(extractVerdict('{"verdict": "proceed", "reason": "   "}')).toEqual({
      verdict: "proceed",
      reason: "(no reason given)",
    });
    expect(extractVerdict('{"verdict": "proceed"}')).toEqual({
      verdict: "proceed",
      reason: "(no reason given)",
    });
  });

  it("trims the reason", () => {
    expect(extractVerdict('{"verdict": "proceed", "reason": "  settled  "}')?.reason).toBe("settled");
  });
});
