import { describe, it, expect } from "vitest";
import { classifyError } from "./classify-error";

const envelope = (result: string) => JSON.stringify({ result });

describe("classifyError", () => {
  it("extracts reset_at from a usage-limit result", () => {
    expect(
      classifyError(envelope("Claude AI usage limit reached|1712345678")),
    ).toEqual({
      outcome: "usage_limited",
      reset_at: 1712345678,
    });
  });

  it.each([
    "API Error: 529 overloaded_error",
    "503 Service Unavailable",
    "read ECONNRESET",
    "getaddrinfo EAI_AGAIN api.anthropic.com",
    "connection error while streaming",
  ])("classifies %j as api_error", (result) => {
    expect(classifyError(envelope(result))).toEqual({ outcome: "api_error" });
  });

  it.each([
    ["empty stdout", ""],
    ["non-JSON output", "the session crashed\nno envelope here"],
    ["an envelope with no string result", JSON.stringify({ is_error: true })],
    ["a result matching no pattern", envelope("node done")],
  ])("returns unknown for %s", (_label, stdout) => {
    expect(classifyError(stdout)).toEqual({ outcome: "unknown" });
  });

  it("uses the last valid envelope when several are present", () => {
    const stdout = [
      envelope("Claude AI usage limit reached|1712345678"),
      envelope("read ECONNRESET"),
    ].join("\n");
    expect(classifyError(stdout)).toEqual({ outcome: "api_error" });
  });

  it("scans back past trailing junk to the last valid envelope", () => {
    const stdout = [envelope("read ECONNRESET"), "not json", "  "].join("\n");
    expect(classifyError(stdout)).toEqual({ outcome: "api_error" });
  });
});
