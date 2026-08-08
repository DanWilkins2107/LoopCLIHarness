import {
  GetSecretValueCommand,
  SecretsManagerClient,
} from "@aws-sdk/client-secrets-manager";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { z } from "zod";

const AGENT_TURN_STATUSES = [
  "awaiting_agent_breakdown",
  "split_approved",
  "awaiting_agent_spec",
  "ready_for_pickup",
  "evaluating_soft_block",
  "pr_changes_requested",
];

// Edge types that make a target not-recommended. Soft blocks only annotate.
const GATE_EDGE_TYPES = ["firm_block", "firm_block_plan", "reassess_after"];

const BoardSecretSchema = z.object({
  url: z.url(),
  anon_key: z.string().min(1),
  email: z.email(),
  password: z.string().min(1),
});

interface GateEdge {
  source_id: string;
  target_id: string;
  type: string;
}

interface Blocker {
  id: string;
  status: string;
  merge_sha: string | null;
}

type Response<T> = { data: T[] | null; error: { message: string } | null };

function rows<T>(res: Response<T>, what: string): T[] {
  if (res.error) throw new Error(`${what} failed: ${res.error.message}`);
  return res.data ?? [];
}

async function connect(secretArn: string): Promise<SupabaseClient> {
  const secrets = new SecretsManagerClient({});
  const { SecretString } = await secrets.send(
    new GetSecretValueCommand({ SecretId: secretArn }),
  );
  if (!SecretString) throw new Error("board secret has no SecretString");
  const cfg = BoardSecretSchema.parse(JSON.parse(SecretString));

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

// Mirrors the "recommended" rule of AgentJira's `aj tasks`: a plan-variant
// blocker is satisfied once its plan lands, a broken_down blocker once its
// whole subtree is complete, everything else once it is done.
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

async function fetchSubtreeComplete(
  sb: SupabaseClient,
  ids: string[],
): Promise<Map<string, boolean>> {
  if (ids.length === 0) return new Map();
  const data = rows<{ id: string; complete: boolean }>(
    await sb.rpc("subtree_complete", { p_ids: ids }),
    "subtree_complete RPC",
  );
  return new Map(data.map((r) => [r.id, r.complete]));
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

  const blockerIds = [...new Set(edges.map((e) => e.source_id))];
  const blockers = new Map(
    rows<Blocker>(
      await sb
        .from("nodes")
        .select("id, status, merge_sha")
        .in("id", blockerIds),
      "blockers query",
    ).map((b) => [b.id, b]),
  );
  const subtreeComplete = await fetchSubtreeComplete(
    sb,
    [...blockers.values()]
      .filter((b) => b.status === "broken_down")
      .map((b) => b.id),
  );

  return new Set(
    edges
      .filter(
        (e) => !isSatisfied(e.type, blockers.get(e.source_id), subtreeComplete),
      )
      .map((e) => e.target_id),
  );
}

export async function hasRecommendedWork(
  secretArn: string,
  projectId: string,
): Promise<boolean> {
  const sb = await connect(secretArn);

  const candidates = rows<{ id: string }>(
    await sb
      .from("nodes")
      .select("id")
      .eq("project_id", projectId)
      .in("status", AGENT_TURN_STATUSES)
      .is("claimed_by", null),
    "nodes query",
  );
  if (candidates.length === 0) return false;

  // Stale (an ancestor is currently invalidated) is derived, not stored.
  const stale = new Set(
    rows<string>(
      await sb.rpc("stale_node_ids", { p_project: projectId }),
      "stale_node_ids RPC",
    ),
  );
  const live = candidates.filter((n) => !stale.has(n.id));
  if (live.length === 0) return false;

  const gated = await fetchGatedNodeIds(
    sb,
    live.map((n) => n.id),
  );
  return live.some((n) => !gated.has(n.id));
}
