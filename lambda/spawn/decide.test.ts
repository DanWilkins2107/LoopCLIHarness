import { describe, expect, it } from "vitest";
import { decide } from "./decide";

const NOW = new Date("2026-01-01T12:00:00Z");
const TTL_MINUTES = 720;

function agedMinutes(minutes: number): Date {
  return new Date(NOW.getTime() - minutes * 60_000);
}

describe("decide", () => {
  it("spawns when nothing is live and the board has work", () => {
    expect(decide([], NOW, TTL_MINUTES, true)).toEqual({
      terminate: [],
      spawn: true,
    });
  });

  it("does not spawn when the board is empty", () => {
    expect(decide([], NOW, TTL_MINUTES, false)).toEqual({
      terminate: [],
      spawn: false,
    });
  });

  it("does not spawn while an instance is live, even with work", () => {
    const instances = [{ id: "i-1", launchedAt: agedMinutes(10) }];
    expect(decide(instances, NOW, TTL_MINUTES, true)).toEqual({
      terminate: [],
      spawn: false,
    });
  });

  it("terminates instances at or past the TTL and does not spawn that tick", () => {
    const instances = [
      { id: "i-young", launchedAt: agedMinutes(719) },
      { id: "i-exact", launchedAt: agedMinutes(720) },
      { id: "i-old", launchedAt: agedMinutes(1000) },
    ];
    expect(decide(instances, NOW, TTL_MINUTES, true)).toEqual({
      terminate: ["i-exact", "i-old"],
      spawn: false,
    });
  });
});
