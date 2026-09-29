-- CHE Postgres + pgvector schema.
-- Run this once in the Postgres database exposed to CHE through PostgREST
-- (Supabase works). Keep the service credential on the Cloudflare Worker only.

create extension if not exists vector;
create extension if not exists pgcrypto;

create table if not exists public.che_memory (
  id uuid primary key default gen_random_uuid(),
  external_id text not null unique,
  kind text not null default 'knowledge',
  title text not null default '',
  content text not null,
  source text not null default '',
  metadata jsonb not null default '{}'::jsonb,
  embedding vector(768) not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table public.che_memory enable row level security;

-- No public RLS policy is created. CHE should access this with a server-side
-- service credential only. Do not put that credential in the Flutter app.

create index if not exists che_memory_embedding_hnsw
  on public.che_memory
  using hnsw (embedding vector_cosine_ops);

create index if not exists che_memory_kind_idx
  on public.che_memory (kind);

create or replace function public.match_che_memory(
  query_embedding vector(768),
  match_threshold double precision default 0.58,
  match_count integer default 8
)
returns table (
  id uuid,
  external_id text,
  kind text,
  title text,
  content text,
  source text,
  metadata jsonb,
  similarity double precision
)
language sql
stable
security definer
set search_path = public
as $$
  select
    m.id,
    m.external_id,
    m.kind,
    m.title,
    m.content,
    m.source,
    m.metadata,
    1 - (m.embedding <=> query_embedding) as similarity
  from public.che_memory as m
  where 1 - (m.embedding <=> query_embedding) >= match_threshold
  order by m.embedding <=> query_embedding
  limit greatest(1, least(match_count, 20));
$$;

revoke all on function public.match_che_memory(vector, double precision, integer) from public;

-- Supabase/PostgREST: allow the server-side service role to call the search
-- function while keeping it unavailable to anonymous/public roles. On a
-- generic Postgres install without a service_role role, this block is a no-op.
do $
begin
  if exists (select 1 from pg_roles where rolname = 'service_role') then
    execute 'grant execute on function public.match_che_memory(vector, double precision, integer) to service_role';
  end if;
end
$;
