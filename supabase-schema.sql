-- Construction Q&A Agent - Supabase schema for local embeddings
--
-- Review and run this file in Supabase SQL Editor before the local ingest.
-- Preflight on 2026-09-09 confirmed public.contracts contains zero rows and
-- public.match_contracts does not yet exist.

begin;

create extension if not exists vector;

create table if not exists public.projects (
  id text primary key,
  name text,
  status text,
  budget numeric,
  city text,
  state text,
  start_date date,
  end_date date
);

create table if not exists public.permits (
  id text primary key,
  permit_number text,
  permit_type text,
  requirements text,
  status text,
  fee numeric,
  issued_date date,
  city text,
  state text
);

-- Recreate the empty Voyage-era table with the local model's dimension.
drop function if exists public.match_contracts(vector, integer);
drop table if exists public.contracts;

create table public.contracts (
  id text primary key,
  name text,
  party text,
  contract_type text,
  governing_law text,
  effective_date date,
  extracted_text text,
  embedding vector(384)
);

create or replace function public.match_contracts(
  query_embedding vector(384),
  match_count integer default 5
)
returns table (
  id text,
  name text,
  party text,
  contract_type text,
  governing_law text,
  extracted_text text,
  similarity double precision
)
language sql
stable
set search_path = public
as $$
  select
    contracts.id,
    contracts.name,
    contracts.party,
    contracts.contract_type,
    contracts.governing_law,
    contracts.extracted_text,
    1 - (contracts.embedding <=> query_embedding) as similarity
  from public.contracts
  where contracts.embedding is not null
  order by contracts.embedding <=> query_embedding
  limit greatest(match_count, 0);
$$;

-- These tables are accessed by server-side code using the service-role key.
-- With no public policies, browser clients cannot query them directly.
alter table public.projects enable row level security;
alter table public.permits enable row level security;
alter table public.contracts enable row level security;

commit;

-- No vector index is needed for the initial 100-contract MVP. PostgreSQL will
-- perform an exact cosine-distance scan, which preserves recall at this size.
-- If the corpus grows materially, create an IVFFlat or HNSW index only after
-- measuring the populated table and choosing parameters for its row count.
