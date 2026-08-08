import type { SupabaseClient } from "@supabase/supabase-js";
import { gatedTargets } from "./recommended";
import {
  fetchAgentTurnNodeIds,
  fetchBlockers,
  fetchGateEdges,
  fetchStaleNodeIds,
  fetchSubtreeComplete,
} from "./helpers/board-queries";
import { connectToBoard } from "./helpers/supabase-client";

// Stale (an ancestor is currently invalidated) is derived, not stored, so it
// takes its own RPC rather than a column filter.
async function unstaleCandidates(
  sb: SupabaseClient,
  projectId: string,
): Promise<string[]> {
  const candidates = await fetchAgentTurnNodeIds(sb, projectId);
  if (candidates.length === 0) return [];
  const stale = await fetchStaleNodeIds(sb, projectId);
  return candidates.filter((id) => !stale.has(id));
}

async function gatedNodeIds(
  sb: SupabaseClient,
  nodeIds: string[],
): Promise<Set<string>> {
  const edges = await fetchGateEdges(sb, nodeIds);
  if (edges.length === 0) return new Set();

  const blockers = await fetchBlockers(sb, [
    ...new Set(edges.map((e) => e.source_id)),
  ]);
  const brokenDown = [...blockers.values()]
    .filter((b) => b.status === "broken_down")
    .map((b) => b.id);
  return gatedTargets(
    edges,
    blockers,
    await fetchSubtreeComplete(sb, brokenDown),
  );
}

export async function hasRecommendedWork(
  secretArn: string,
  projectId: string,
): Promise<boolean> {
  const sb = await connectToBoard(secretArn);
  const candidates = await unstaleCandidates(sb, projectId);
  if (candidates.length === 0) return false;

  const gated = await gatedNodeIds(sb, candidates);
  return candidates.some((id) => !gated.has(id));
}
