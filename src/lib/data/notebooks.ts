// Notebook data access. Takes any Supabase client (browser, server, or a
// future Expo app); authorization is enforced by RLS, not by this code.
import type { SupabaseClient } from "@supabase/supabase-js";
import type { NotebookInput } from "@/lib/validation/notebooks";
import type { Notebook, SearchResult } from "@/types/models";

const COLUMNS = "id,user_id,title,description,cover_color,is_favorite,last_opened_at,created_at,updated_at,pages(count)";

type NotebookRow = Omit<Notebook, "page_count"> & { pages?: { count: number }[] };
const toNotebook = ({ pages, ...row }: NotebookRow): Notebook => ({ ...row, page_count: pages?.[0]?.count ?? 0 });

export async function listNotebooks(sb: SupabaseClient): Promise<Notebook[]> {
  const { data, error } = await sb.from("notebooks").select(COLUMNS).order("updated_at", { ascending: false });
  if (error) throw error;
  return (data as NotebookRow[]).map(toNotebook);
}

export async function getNotebook(sb: SupabaseClient, id: string): Promise<Notebook | null> {
  const { data, error } = await sb.from("notebooks").select(COLUMNS).eq("id", id).maybeSingle();
  if (error) throw error;
  return data ? toNotebook(data as NotebookRow) : null;
}

export async function createNotebook(sb: SupabaseClient, input: NotebookInput): Promise<Notebook> {
  const { data, error } = await sb
    .from("notebooks")
    .insert({ title: input.title, description: input.description, cover_color: input.coverColor })
    .select(COLUMNS)
    .single();
  if (error) throw error;
  return toNotebook(data as NotebookRow);
}

export async function updateNotebook(
  sb: SupabaseClient,
  id: string,
  patch: Partial<{ title: string; description: string; cover_color: string; is_favorite: boolean }>,
): Promise<void> {
  const { error } = await sb.from("notebooks").update(patch).eq("id", id);
  if (error) throw error;
}

export async function deleteNotebook(sb: SupabaseClient, id: string): Promise<void> {
  const { error } = await sb.from("notebooks").delete().eq("id", id);
  if (error) throw error;
}

export async function markNotebookOpened(sb: SupabaseClient, id: string): Promise<void> {
  // Does not change updated_at (see notebooks_before_update trigger).
  await sb.from("notebooks").update({ last_opened_at: new Date().toISOString() }).eq("id", id);
}

export async function searchContent(sb: SupabaseClient, query: string): Promise<SearchResult[]> {
  const q = query.trim().slice(0, 200);
  if (!q) return [];
  const { data, error } = await sb.rpc("search_content", { q, max_results: 20 });
  if (error) throw error;
  return data as SearchResult[];
}
