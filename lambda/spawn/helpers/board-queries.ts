import type { SupabaseClient } from "@supabase/supabase-js";
import {
  AGENT_TURN_STATUSES,
  GATE_EDGE_TYPES,
  type Blocker,
  type GateEdge,
} from "../recommended";
import { rows } from "./supabase-client";

export async function fetchAgentTurnNodeIds(
  sb: SupabaseClient,
  projectId: string,
): Promise<string[]> {
  const result = await sb
    .from("nodes")
    .select("id")
    .eq("project_id", projectId)
    .in("status", AGENT_TURN_STATUSES)
    .is("claimed_by", null);
  return rows<{ id: string }>(result, "nodes query").map((n) => n.id);
}

export async function fetchStaleNodeIds(
  sb: SupabaseClient,
  projectId: string,
): Promise<Set<string>> {
  const result = await sb.rpc("stale_node_ids", { p_project: projectId });
  return new Set(rows<string>(result, "stale_node_ids RPC"));
}

export async function fetchGateEdges(
  sb: SupabaseClient,
  nodeIds: string[],
): Promise<GateEdge[]> {
  const result = await sb
    .from("edges")
    .select("source_id, target_id, type")
    .in("target_id", nodeIds)
    .in("type", GATE_EDGE_TYPES)
    .is("removed_at", null);
  return rows<GateEdge>(result, "edges query");
}

export async function fetchBlockers(
  sb: SupabaseClient,
  ids: string[],
): Promise<Map<string, Blocker>> {
  const result = await sb
    .from("nodes")
    .select("id, status, merge_sha")
    .in("id", ids);
  return new Map(rows<Blocker>(result, "blockers query").map((b) => [b.id, b]));
}

export async function fetchSubtreeComplete(
  sb: SupabaseClient,
  ids: string[],
): Promise<Map<string, boolean>> {
  if (ids.length === 0) return new Map();
  const result = await sb.rpc("subtree_complete", { p_ids: ids });
  const complete = rows<{ id: string; complete: boolean }>(
    result,
    "subtree_complete RPC",
  );
  return new Map(complete.map((r) => [r.id, r.complete]));
}
