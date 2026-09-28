import "server-only";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { serverEnv } from "@/lib/env";

/**
 * Service-role client that bypasses RLS. Only use it after verifying ownership
 * with a user-scoped client. Returns null when the key isn't configured.
 */
export function createAdminClient(): SupabaseClient | null {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  if (!url || !serverEnv.supabaseServiceRoleKey) return null;
  return createClient(url, serverEnv.supabaseServiceRoleKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
}
