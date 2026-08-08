export const AGENT_TURN_STATUSES = [
  "awaiting_agent_breakdown",
  "split_approved",
  "awaiting_agent_spec",
  "ready_for_pickup",
  "evaluating_soft_block",
  "pr_changes_requested",
];

// Edge types that make a target not-recommended. Soft blocks only annotate.
export const GATE_EDGE_TYPES = [
  "firm_block",
  "firm_block_plan",
  "reassess_after",
];

export interface GateEdge {
  source_id: string;
  target_id: string;
  type: string;
}

export interface Blocker {
  id: string;
  status: string;
  merge_sha: string | null;
}

// A plan-variant blocker is satisfied once its plan lands (done, or a merge sha
// recorded); a broken_down blocker once its whole subtree is complete;
// everything else once it is done.
function isSatisfied(
  edgeType: string,
  blocker: Blocker | undefined,
  subtreeComplete: Map<string, boolean>,
): boolean {
  if (!blocker) return false;
  if (edgeType === "firm_block_plan")
    return blocker.status === "done" || blocker.merge_sha !== null;
  if (blocker.status === "broken_down")
    return subtreeComplete.get(blocker.id) === true;
  return blocker.status === "done";
}

export function gatedTargets(
  edges: GateEdge[],
  blockers: Map<string, Blocker>,
  subtreeComplete: Map<string, boolean>,
): Set<string> {
  return new Set(
    edges
      .filter(
        (e) => !isSatisfied(e.type, blockers.get(e.source_id), subtreeComplete),
      )
      .map((e) => e.target_id),
  );
}
