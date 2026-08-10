import { describe, expect, it } from "vitest";
import { gatedTargets, type Blocker, type GateEdge } from "./recommended";

function edge(type: string, source: string): GateEdge {
  return { source_id: source, target_id: "target", type };
}

function blocker(id: string, status: string, mergeSha?: string): Blocker {
  return { id, status, merge_sha: mergeSha ?? null };
}

function blockerMap(...list: Blocker[]): Map<string, Blocker> {
  return new Map(list.map((b) => [b.id, b]));
}

const NO_SUBTREES = new Map<string, boolean>();

describe("gatedTargets", () => {
  it("gates on a blocker row that is missing", () => {
    expect(
      gatedTargets([edge("firm_block", "b")], new Map(), NO_SUBTREES),
    ).toEqual(new Set(["target"]));
  });

  it("gates a firm_block until its blocker is done", () => {
    const edges = [edge("firm_block", "b")];
    expect(
      gatedTargets(
        edges,
        blockerMap(blocker("b", "ready_for_pickup")),
        NO_SUBTREES,
      ),
    ).toEqual(new Set(["target"]));
    expect(
      gatedTargets(edges, blockerMap(blocker("b", "done")), NO_SUBTREES),
    ).toEqual(new Set());
  });

  it("releases a firm_block_plan once the plan lands", () => {
    const edges = [edge("firm_block_plan", "b")];
    expect(
      gatedTargets(edges, blockerMap(blocker("b", "pr_raised")), NO_SUBTREES),
    ).toEqual(new Set(["target"]));
    expect(
      gatedTargets(edges, blockerMap(blocker("b", "done")), NO_SUBTREES),
    ).toEqual(new Set());
    expect(
      gatedTargets(
        edges,
        blockerMap(blocker("b", "awaiting_agent_breakdown", "abc123")),
        NO_SUBTREES,
      ),
    ).toEqual(new Set());
  });

  it("releases a broken_down blocker only when its subtree is complete", () => {
    const edges = [edge("reassess_after", "b")];
    const blockers = blockerMap(blocker("b", "broken_down"));
    expect(gatedTargets(edges, blockers, NO_SUBTREES)).toEqual(
      new Set(["target"]),
    );
    expect(gatedTargets(edges, blockers, new Map([["b", false]]))).toEqual(
      new Set(["target"]),
    );
    expect(gatedTargets(edges, blockers, new Map([["b", true]]))).toEqual(
      new Set(),
    );
  });
});
