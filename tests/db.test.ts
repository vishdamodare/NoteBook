// Runs the real migration in PGlite (in-process Postgres) with a minimal stub of
// Supabase's auth schema, then exercises RLS, triggers and search as real users.
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { beforeAll, describe, expect, it } from "vitest";

const A = "00000000-0000-0000-0000-00000000000a";
const B = "00000000-0000-0000-0000-00000000000b";
let db: PGlite;

const AUTH_STUB = `
  create role anon nologin; create role authenticated nologin; create role service_role nologin bypassrls;
  create schema auth;
  create table auth.users (id uuid primary key, email text, raw_user_meta_data jsonb default '{}'::jsonb);
  create function auth.uid() returns uuid language sql stable as
    $$ select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $$;
  grant usage on schema auth to authenticated, anon, service_role;
`;

async function as<T>(user: string, fn: () => Promise<T>): Promise<T> {
  await db.exec(`set role authenticated; set request.jwt.claim.sub = '${user}';`);
  try {
    return await fn();
  } finally {
    await db.exec("reset role; reset request.jwt.claim.sub;");
  }
}

const q = async <T = Record<string, unknown>>(sql: string, params: unknown[] = []) =>
  (await db.query<T>(sql, params)).rows;

beforeAll(async () => {
  db = new PGlite();
  await db.exec(AUTH_STUB);
  const dir = join(__dirname, "..", "supabase", "migrations");
  for (const file of readdirSync(dir).sort()) await db.exec(readFileSync(join(dir, file), "utf8"));
  await db.exec(`
    grant usage on schema public to authenticated, service_role;
    grant all on all tables in schema public to authenticated, service_role;
    insert into auth.users (id, email, raw_user_meta_data) values
      ('${A}', 'a@example.com', '{"display_name":"Ada"}'), ('${B}', 'b@example.com', '{}');
  `);
});

describe("database schema and RLS", () => {
  let notebookA = "";
  let pageA = "";

  it("creates a profile for each new auth user", async () => {
    const rows = await q<{ display_name: string | null }>("select display_name from profiles order by id");
    expect(rows.map((r) => r.display_name)).toEqual(["Ada", null]);
  });

  it("lets a user create a notebook owned by the session user", async () => {
    const [nb] = await as(A, () => q<{ id: string; user_id: string }>(
      "insert into notebooks (title) values ('Physics') returning id, user_id"));
    expect(nb.user_id).toBe(A);
    notebookA = nb.id;
  });

  it("does not treat opening a notebook as an edit", async () => {
    const [before] = await q<{ updated_at: string }>("select updated_at from notebooks where id = $1", [notebookA]);
    await as(A, () => q("update notebooks set last_opened_at = now() + interval '1 minute' where id = $1", [notebookA]));
    const [after] = await q<{ updated_at: string; last_opened_at: string | null }>(
      "select updated_at, last_opened_at from notebooks where id = $1", [notebookA]);
    expect(after.updated_at).toEqual(before.updated_at);
    expect(after.last_opened_at).not.toBeNull();
  });

  it("rejects notebooks created for another user id", async () => {
    await expect(as(A, () => q(`insert into notebooks (title, user_id) values ('x', '${B}')`))).rejects.toThrow(
      /row-level security/);
  });

  it("assigns page positions, extracts search text and bumps revision", async () => {
    const doc = { type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text: "Entropy rises" }] }] };
    const [first] = await as(A, () => q<{ id: string; position: number; content_text: string; revision: number }>(
      "insert into pages (notebook_id, title, content_json) values ($1, 'Thermo', $2) returning id, position, content_text, revision",
      [notebookA, doc]));
    expect(first).toMatchObject({ position: 1, content_text: "Entropy rises", revision: 1 });
    pageA = first.id;

    const [second] = await as(A, () => q<{ position: number }>(
      "insert into pages (notebook_id) values ($1) returning position", [notebookA]));
    expect(second.position).toBe(2);

    const [updated] = await as(A, () => q<{ revision: number }>(
      "update pages set title = 'Thermodynamics' where id = $1 and revision = 1 returning revision", [pageA]));
    expect(updated.revision).toBe(2);

    const stale = await as(A, () => q("update pages set title = 'stale' where id = $1 and revision = 1 returning id", [pageA]));
    expect(stale).toHaveLength(0);
  });

  it("hides one user's notebooks and pages from another", async () => {
    expect(await as(B, () => q("select id from notebooks"))).toHaveLength(0);
    expect(await as(B, () => q("select id from pages"))).toHaveLength(0);
    expect(await as(B, () => q("update pages set title = 'hacked' where id = $1 returning id", [pageA]))).toHaveLength(0);
    expect(await as(B, () => q("delete from notebooks where id = $1 returning id", [notebookA]))).toHaveLength(0);
  });

  it("blocks creating or moving pages into another user's notebook", async () => {
    await expect(as(B, () => q("insert into pages (notebook_id) values ($1)", [notebookA]))).rejects.toThrow(
      /row-level security/);

    const [nbB] = await as(B, () => q<{ id: string }>("insert into notebooks (title) values ('Mine') returning id"));
    const [pageB] = await as(B, () => q<{ id: string }>(
      "insert into pages (notebook_id) values ($1) returning id", [nbB.id]));
    await expect(as(B, () => q("update pages set notebook_id = $1 where id = $2", [notebookA, pageB.id]))).rejects.toThrow(
      /row-level security/);
  });

  it("does not let users write videos directly", async () => {
    await expect(as(A, () => q(
      "insert into videos (page_id, video_id, video_url) values ($1, 'dQw4w9WgXcQ', 'https://youtu.be/dQw4w9WgXcQ')",
      [pageA]))).rejects.toThrow(/row-level security/);
  });

  it("allows only one active processing job per video", async () => {
    const [video] = await q<{ id: string }>(
      "insert into videos (page_id, video_id, video_url) values ($1, 'dQw4w9WgXcQ', 'https://youtu.be/dQw4w9WgXcQ') returning id",
      [pageA]);
    await q("insert into processing_jobs (user_id, video_id) values ($1, $2)", [A, video.id]);
    await expect(q("insert into processing_jobs (user_id, video_id) values ($1, $2)", [A, video.id])).rejects.toThrow(
      /duplicate key/);
    await q("update processing_jobs set status = 'failed' where video_id = $1", [video.id]);
    await q("insert into processing_jobs (user_id, video_id) values ($1, $2)", [A, video.id]);

    expect(await as(A, () => q("select id from processing_jobs"))).toHaveLength(2);
    expect(await as(A, () => q("select id from videos"))).toHaveLength(1);
    expect(await as(B, () => q("select id from processing_jobs"))).toHaveLength(0);
    expect(await as(B, () => q("select id from videos"))).toHaveLength(0);
  });

  it("searches notebooks and page text within the caller's data only", async () => {
    const hits = await as(A, () => q<{ kind: string; title: string; excerpt: string | null }>(
      "select kind, title, excerpt from search_content('entropy')"));
    expect(hits).toHaveLength(1);
    expect(hits[0]).toMatchObject({ kind: "page", title: "Thermodynamics" });
    expect(hits[0].excerpt).toContain("«Entropy»");

    expect(await as(A, () => q("select * from search_content('phys')"))).toHaveLength(1); // partial title via ilike
    expect(await as(B, () => q("select * from search_content('entropy')"))).toHaveLength(0);
    expect(await as(A, () => q("select * from search_content('100%_')"))).toHaveLength(0);
  });

  it("cascades notebook deletion to pages, videos and jobs", async () => {
    await as(A, () => q("delete from notebooks where id = $1", [notebookA]));
    const [counts] = await q<{ p: number; v: number; j: number }>(
      "select (select count(*)::int from pages where notebook_id = $1) p, (select count(*)::int from videos) v, (select count(*)::int from processing_jobs) j",
      [notebookA]);
    expect(counts).toEqual({ p: 0, v: 0, j: 0 });
  });
});
