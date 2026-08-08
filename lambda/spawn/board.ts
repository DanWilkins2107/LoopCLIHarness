import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import {
  AGENT_TURN_STATUSES,
  GATE_EDGE_TYPES,
  gatedTargets,
  type Blocker,
  type GateEdge,
} from "./recommended";
import { loadBoardCredentials } from "./secret";

function rows<T>(
  res: { data: T[] | null; error: { message: string } | null },
  what: string,
): T[] {
  if (res.error) throw new Error(`${what} failed: ${res.error.message}`);
  return res.data ?? [];
}

async function connect(secretArn: string): Promise<SupabaseClient> {
  const cfg = await loadBoardCredentials(secretArn);
  const sb = createClient(cfg.url, cfg.anon_key, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const { error } = await sb.auth.signInWithPassword({
    email: cfg.email,
    password: cfg.password,
  });
  if (error) throw new Error(`board login failed: ${error.message}`);
  return sb;
}

async function fetchSubtreeComplete(
  sb: SupabaseClient,
  blockers: Map<string, Blocker>,
): Promise<Map<string, boolean>> {
  const ids = [...blockers.values()]
    .filter((b) => b.status === "broken_down")
    .map((b) => b.id);
  if (ids.length === 0) return new Map();
  const data = rows<{ id: string; complete: boolean }>(
    await sb.rpc("subtree_complete", { p_ids: ids }),
    "subtree_complete RPC",
  );
  return new Map(data.map((r) => [r.id, r.complete]));
}

async function fetchBlockers(
  sb: SupabaseClient,
  edges: GateEdge[],
): Promise<Map<string, Blocker>> {
  const ids = [...new Set(edges.map((e) => e.source_id))];
  const blockers = rows<Blocker>(
    await sb.from("nodes").select("id, status, merge_sha").in("id", ids),
    "blockers query",
  );
  return new Map(blockers.map((b) => [b.id, b]));
}

async function fetchGatedNodeIds(
  sb: SupabaseClient,
  nodeIds: string[],
): Promise<Set<string>> {
  const edges = rows<GateEdge>(
    await sb
      .from("edges")
      .select("source_id, target_id, type")
      .in("target_id", nodeIds)
      .in("type", GATE_EDGE_TYPES)
      .is("removed_at", null),
    "edges query",
  );
  if (edges.length === 0) return new Set();

  const blockers = await fetchBlockers(sb, edges);
  return gatedTargets(
    edges,
    blockers,
    await fetchSubtreeComplete(sb, blockers),
  );
}

async function fetchUnstaleCandidates(
  sb: SupabaseClient,
  projectId: string,
): Promise<string[]> {
  const candidates = rows<{ id: string }>(
    await sb
      .from("nodes")
      .select("id")
      .eq("project_id", projectId)
      .in("status", AGENT_TURN_STATUSES)
      .is("claimed_by", null),
    "nodes query",
  );
  if (candidates.length === 0) return [];

  // Stale (an ancestor is currently invalidated) is derived, not stored.
  const stale = new Set(
    rows<string>(
      await sb.rpc("stale_node_ids", { p_project: projectId }),
      "stale_node_ids RPC",
    ),
  );
  return candidates.map((n) => n.id).filter((id) => !stale.has(id));
}

export async function hasRecommendedWork(
  secretArn: string,
  projectId: string,
): Promise<boolean> {
  const sb = await connect(secretArn);
  const candidates = await fetchUnstaleCandidates(sb, projectId);
  if (candidates.length === 0) return false;

  const gated = await fetchGatedNodeIds(sb, candidates);
  return candidates.some((id) => !gated.has(id));
}
