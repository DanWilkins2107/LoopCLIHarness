import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { loadBoardCredentials } from "./secret";

export async function connectToBoard(
  secretArn: string,
): Promise<SupabaseClient> {
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

export function rows<T>(
  result: { data: T[] | null; error: { message: string } | null },
  queryDescription: string,
): T[] {
  if (result.error)
    throw new Error(`${queryDescription} failed: ${result.error.message}`);
  return result.data ?? [];
}
