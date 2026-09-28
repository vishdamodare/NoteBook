-- Note: initial schema.
-- Ownership model: notebooks.user_id is the single source of truth.
-- pages -> notebooks -> user; videos -> pages; summaries -> videos.
-- processing_jobs carries user_id so rate limits can be counted without joins.

-- ---------------------------------------------------------------------------
-- Helpers
-- ---------------------------------------------------------------------------

create or replace function public.set_updated_at()
returns trigger language plpgsql as $$
begin
  new.updated_at = now();
  return new;
end $$;

-- ---------------------------------------------------------------------------
-- profiles
-- ---------------------------------------------------------------------------

create table public.profiles (
  id uuid primary key references auth.users (id) on delete cascade,
  display_name text check (char_length(display_name) <= 80),
  avatar_url text check (avatar_url is null or avatar_url ~ '^https://'),
  preferences jsonb not null default '{}'::jsonb check (jsonb_typeof(preferences) = 'object'),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create trigger profiles_updated_at before update on public.profiles
  for each row execute function public.set_updated_at();

-- A profile row is created for every new auth user.
create or replace function public.handle_new_user()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  insert into public.profiles (id, display_name)
  values (new.id, nullif(left(coalesce(new.raw_user_meta_data ->> 'display_name', ''), 80), ''));
  return new;
end $$;

create trigger on_auth_user_created after insert on auth.users
  for each row execute function public.handle_new_user();

-- ---------------------------------------------------------------------------
-- notebooks
-- ---------------------------------------------------------------------------

create table public.notebooks (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null default auth.uid() references auth.users (id) on delete cascade,
  title text not null default '' check (char_length(title) <= 200),
  description text not null default '' check (char_length(description) <= 1000),
  cover_color text not null default 'sage' check (cover_color ~ '^[a-z]{1,20}$'),
  is_favorite boolean not null default false,
  last_opened_at timestamptz,
  search_vector tsvector generated always as (
    setweight(to_tsvector('simple', title), 'A') || setweight(to_tsvector('simple', description), 'B')
  ) stored,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index notebooks_user_updated_idx on public.notebooks (user_id, updated_at desc);
create index notebooks_search_idx on public.notebooks using gin (search_vector);

-- Opening a notebook (last_opened_at) is not an edit, so it keeps updated_at.
create or replace function public.notebooks_before_update()
returns trigger language plpgsql as $$
begin
  if new.last_opened_at is distinct from old.last_opened_at
     and (new.title, new.description, new.cover_color, new.is_favorite)
         is not distinct from (old.title, old.description, old.cover_color, old.is_favorite)
     and new.updated_at is not distinct from old.updated_at then
    return new;
  end if;
  new.updated_at := now();
  return new;
end $$;

create trigger notebooks_before_update before update on public.notebooks
  for each row execute function public.notebooks_before_update();

-- ---------------------------------------------------------------------------
-- pages
-- ---------------------------------------------------------------------------

create table public.pages (
  id uuid primary key default gen_random_uuid(),
  notebook_id uuid not null references public.notebooks (id) on delete cascade,
  title text not null default '' check (char_length(title) <= 300),
  content_json jsonb not null default '{"type":"doc","content":[{"type":"paragraph"}]}'::jsonb
    check (jsonb_typeof(content_json) = 'object' and content_json ->> 'type' = 'doc'
           and pg_column_size(content_json) <= 2000000),
  -- Plain text extracted from content_json by trigger; used only for search.
  content_text text not null default '',
  page_type text not null default 'note' check (page_type in ('note', 'youtube')),
  -- Fractional ordering: a reorder is one row update to the midpoint of its neighbours.
  position double precision not null,
  -- Bumped on every content/title change. Clients save with "where revision = expected"
  -- so a stale tab can never silently overwrite newer content.
  revision integer not null default 1,
  search_vector tsvector generated always as (
    setweight(to_tsvector('simple', title), 'A') || setweight(to_tsvector('simple', content_text), 'B')
  ) stored,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index pages_notebook_position_idx on public.pages (notebook_id, position);
create index pages_search_idx on public.pages using gin (search_vector);

create or replace function public.pages_before_write()
returns trigger language plpgsql as $$
begin
  if tg_op = 'INSERT' and new.position is null then
    select coalesce(max(position), 0) + 1 into new.position
    from public.pages where notebook_id = new.notebook_id;
  end if;

  if tg_op = 'INSERT' or new.content_json is distinct from old.content_json then
    new.content_text := left(coalesce((
      select string_agg(t #>> '{}', ' ')
      from jsonb_path_query(new.content_json, 'strict $.**.text') as t
    ), ''), 200000);
  end if;

  if tg_op = 'UPDATE' then
    new.updated_at := now();
    if new.content_json is distinct from old.content_json or new.title is distinct from old.title then
      new.revision := old.revision + 1;
    else
      new.revision := old.revision;
    end if;
  end if;
  return new;
end $$;

create trigger pages_before_write before insert or update on public.pages
  for each row execute function public.pages_before_write();

-- Keep a notebook's "last updated" meaningful when its pages change.
create or replace function public.touch_notebook()
returns trigger language plpgsql as $$
begin
  if tg_op <> 'INSERT' then
    update public.notebooks set updated_at = now() where id = old.notebook_id;
  end if;
  if tg_op <> 'DELETE' and (tg_op = 'INSERT' or new.notebook_id <> old.notebook_id) then
    update public.notebooks set updated_at = now() where id = new.notebook_id;
  end if;
  return null;
end $$;

create trigger pages_touch_notebook after insert or update or delete on public.pages
  for each row execute function public.touch_notebook();

-- ---------------------------------------------------------------------------
-- videos (at most one per YouTube page)
-- ---------------------------------------------------------------------------

create table public.videos (
  id uuid primary key default gen_random_uuid(),
  page_id uuid not null unique references public.pages (id) on delete cascade,
  video_id text not null check (video_id ~ '^[A-Za-z0-9_-]{11}$'),
  video_url text not null,
  video_title text,
  channel_name text,
  thumbnail_url text,
  duration_seconds integer check (duration_seconds is null or duration_seconds >= 0),
  description text,
  metadata_status text not null default 'pending'
    check (metadata_status in ('pending', 'available', 'unavailable')),
  transcript_status text not null default 'pending'
    check (transcript_status in ('pending', 'available', 'unavailable')),
  transcript_source text check (transcript_source in ('provider', 'manual')),
  -- [{ "text": string, "start": number|null, "duration": number|null }]
  transcript_segments jsonb check (transcript_segments is null or jsonb_typeof(transcript_segments) = 'array'),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create trigger videos_updated_at before update on public.videos
  for each row execute function public.set_updated_at();

-- ---------------------------------------------------------------------------
-- summaries (append-only history; the newest row is current)
-- ---------------------------------------------------------------------------

create table public.summaries (
  id uuid primary key default gen_random_uuid(),
  video_id uuid not null references public.videos (id) on delete cascade,
  summary_json jsonb not null check (jsonb_typeof(summary_json) = 'object'),
  model text not null,
  prompt_version text not null,
  created_at timestamptz not null default now()
);

create index summaries_video_created_idx on public.summaries (video_id, created_at desc);

-- ---------------------------------------------------------------------------
-- processing_jobs
-- ---------------------------------------------------------------------------

create table public.processing_jobs (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  video_id uuid not null references public.videos (id) on delete cascade,
  status text not null default 'pending' check (status in
    ('pending', 'fetching_metadata', 'fetching_transcript', 'processing', 'completed', 'failed')),
  error_code text,
  error_message text,
  attempts integer not null default 0 check (attempts >= 0),
  summary_id uuid references public.summaries (id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  completed_at timestamptz
);

-- Idempotency: at most one active job per video.
create unique index processing_jobs_one_active_idx on public.processing_jobs (video_id)
  where status not in ('completed', 'failed');
create index processing_jobs_user_created_idx on public.processing_jobs (user_id, created_at desc);
create index processing_jobs_video_created_idx on public.processing_jobs (video_id, created_at desc);

create trigger processing_jobs_updated_at before update on public.processing_jobs
  for each row execute function public.set_updated_at();

-- ---------------------------------------------------------------------------
-- Row Level Security
-- ---------------------------------------------------------------------------

alter table public.profiles enable row level security;
alter table public.notebooks enable row level security;
alter table public.pages enable row level security;
alter table public.videos enable row level security;
alter table public.summaries enable row level security;
alter table public.processing_jobs enable row level security;

-- profiles: own row only. Inserts happen via the auth trigger.
create policy profiles_select on public.profiles for select to authenticated
  using (id = (select auth.uid()));
create policy profiles_update on public.profiles for update to authenticated
  using (id = (select auth.uid())) with check (id = (select auth.uid()));

-- notebooks: owner has full CRUD; user_id can never be set to someone else.
create policy notebooks_select on public.notebooks for select to authenticated
  using (user_id = (select auth.uid()));
create policy notebooks_insert on public.notebooks for insert to authenticated
  with check (user_id = (select auth.uid()));
create policy notebooks_update on public.notebooks for update to authenticated
  using (user_id = (select auth.uid())) with check (user_id = (select auth.uid()));
create policy notebooks_delete on public.notebooks for delete to authenticated
  using (user_id = (select auth.uid()));

-- pages: access follows the parent notebook. The with-check on insert/update
-- also blocks creating or moving a page into another user's notebook.
create policy pages_select on public.pages for select to authenticated
  using (exists (select 1 from public.notebooks n where n.id = pages.notebook_id and n.user_id = (select auth.uid())));
create policy pages_insert on public.pages for insert to authenticated
  with check (exists (select 1 from public.notebooks n where n.id = pages.notebook_id and n.user_id = (select auth.uid())));
create policy pages_update on public.pages for update to authenticated
  using (exists (select 1 from public.notebooks n where n.id = pages.notebook_id and n.user_id = (select auth.uid())))
  with check (exists (select 1 from public.notebooks n where n.id = pages.notebook_id and n.user_id = (select auth.uid())));
create policy pages_delete on public.pages for delete to authenticated
  using (exists (select 1 from public.notebooks n where n.id = pages.notebook_id and n.user_id = (select auth.uid())));

-- videos / summaries / processing_jobs: users may read their own.
-- Writes are performed by the server (service role) after it has verified
-- ownership, so users cannot forge job state or bypass AI rate limits.
-- Deletion happens through the page -> video cascade.
create policy videos_select on public.videos for select to authenticated
  using (exists (
    select 1 from public.pages p join public.notebooks n on n.id = p.notebook_id
    where p.id = videos.page_id and n.user_id = (select auth.uid())));

create policy summaries_select on public.summaries for select to authenticated
  using (exists (
    select 1 from public.videos v
    join public.pages p on p.id = v.page_id
    join public.notebooks n on n.id = p.notebook_id
    where v.id = summaries.video_id and n.user_id = (select auth.uid())));

create policy processing_jobs_select on public.processing_jobs for select to authenticated
  using (user_id = (select auth.uid()));

-- ---------------------------------------------------------------------------
-- Search (security invoker, so RLS applies)
-- ---------------------------------------------------------------------------

create or replace function public.search_content(q text, max_results integer default 20)
returns table (
  kind text,
  notebook_id uuid,
  page_id uuid,
  title text,
  notebook_title text,
  excerpt text,
  updated_at timestamptz,
  rank real
)
language sql stable security invoker set search_path = public as $$
  with query as (
    select websearch_to_tsquery('simple', q) as tsq,
           '%' || replace(replace(replace(q, '\', '\\'), '%', '\%'), '_', '\_') || '%' as pattern
  )
  select * from (
    select 'notebook'::text, n.id, null::uuid, n.title, n.title,
           nullif(left(n.description, 160), ''), n.updated_at,
           ts_rank(n.search_vector, query.tsq) + (case when n.title ilike query.pattern then 1 else 0 end)
    from public.notebooks n, query
    where n.search_vector @@ query.tsq or n.title ilike query.pattern
    union all
    select 'page'::text, p.notebook_id, p.id, p.title, n.title,
           nullif(ts_headline('simple', left(p.content_text, 20000), query.tsq,
             'StartSel=«,StopSel=»,MaxWords=24,MinWords=8,MaxFragments=1'), ''),
           p.updated_at,
           ts_rank(p.search_vector, query.tsq) + (case when p.title ilike query.pattern then 1 else 0 end)
    from public.pages p join public.notebooks n on n.id = p.notebook_id, query
    where p.search_vector @@ query.tsq or p.title ilike query.pattern
  ) r (kind, notebook_id, page_id, title, notebook_title, excerpt, updated_at, rank)
  where length(trim(q)) > 0
  order by rank desc, updated_at desc
  limit least(greatest(max_results, 1), 50);
$$;

grant execute on function public.search_content(text, integer) to authenticated;
