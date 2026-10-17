-- Phase B: ICP Score History + Factor-Level Persistence
-- Additive only — no Phase A columns are removed.

-- ─────────────────────────────────────────────────────────────
-- Tables
-- ─────────────────────────────────────────────────────────────

create table if not exists public.prospect_score_runs (
  id              uuid        primary key default gen_random_uuid(),
  prospect_id     uuid        not null references public.prospects(id) on delete cascade,
  score_version   text        not null,
  total_score     numeric(5,2),
  priority        text        not null check (priority in ('high','medium','low','insufficient_data')),
  coverage        integer     not null check (coverage between 0 and 100),
  scoring_status  text        not null check (scoring_status in ('scored','insufficient_data')),
  scored_at       timestamptz not null default now(),
  created_at      timestamptz not null default now()
);

create index if not exists score_runs_prospect_id_idx on public.prospect_score_runs (prospect_id);
create index if not exists score_runs_scored_at_idx   on public.prospect_score_runs (prospect_id, scored_at desc);

create table if not exists public.prospect_score_factors (
  id           uuid     primary key default gen_random_uuid(),
  score_run_id uuid     not null references public.prospect_score_runs(id) on delete cascade,
  factor_key   text     not null,
  score        numeric(5,2),
  max_score    integer  not null check (max_score > 0),
  status       text     not null check (status in ('strong','partial','poor','unknown')),
  reason       text     not null,
  created_at   timestamptz not null default now(),
  constraint prospect_score_factors_unique_factor unique (score_run_id, factor_key)
);

create index if not exists score_factors_run_id_idx on public.prospect_score_factors (score_run_id);

-- Foreign key from prospects → the latest successful score run.
alter table public.prospects
  add column if not exists current_score_run_id uuid
    references public.prospect_score_runs(id) on delete set null
    deferrable initially deferred;

-- ─────────────────────────────────────────────────────────────
-- Atomic scoring RPC
-- Called by the score API route to persist a full score run.
-- Returns the new score_run id.
-- ─────────────────────────────────────────────────────────────

create or replace function public.persist_icp_score_run(
  p_prospect_id   uuid,
  p_version       text,
  p_total_score   numeric,
  p_priority      text,
  p_coverage      integer,
  p_status        text,
  p_scored_at     timestamptz,
  p_icp_reason    text,
  p_factors       jsonb      -- [{factor_key,score,max_score,status,reason}]
)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_run_id uuid;
  v_factor jsonb;
begin
  -- 1. Insert the score run
  insert into public.prospect_score_runs (
    prospect_id, score_version, total_score, priority,
    coverage, scoring_status, scored_at
  ) values (
    p_prospect_id, p_version, p_total_score, p_priority,
    p_coverage, p_status, p_scored_at
  )
  returning id into v_run_id;

  -- 2. Insert exactly one row per factor (uniqueness enforced by constraint)
  for v_factor in select * from jsonb_array_elements(p_factors)
  loop
    insert into public.prospect_score_factors (
      score_run_id, factor_key, score, max_score, status, reason
    ) values (
      v_run_id,
      v_factor->>'factor_key',
      case when (v_factor->>'score') is null or (v_factor->>'score') = '' then null
           else (v_factor->>'score')::numeric end,
      (v_factor->>'max_score')::integer,
      v_factor->>'status',
      v_factor->>'reason'
    );
  end loop;

  -- 3. Update the prospect's projection columns and current pointer
  update public.prospects set
    icp_score             = p_total_score,
    icp_reason            = p_icp_reason,
    icp_score_version     = p_version,
    icp_scored_at         = p_scored_at,
    icp_coverage          = p_coverage,
    icp_scoring_status    = p_status,
    current_score_run_id  = v_run_id
  where id = p_prospect_id;

  return v_run_id;
end;
$$;

-- ─────────────────────────────────────────────────────────────
-- Row-level security
-- ─────────────────────────────────────────────────────────────

alter table public.prospect_score_runs    enable row level security;
alter table public.prospect_score_factors enable row level security;

drop policy if exists "anon can read score runs"        on public.prospect_score_runs;
create policy         "anon can read score runs"        on public.prospect_score_runs    for select to anon, authenticated using (true);
drop policy if exists "anon can insert score runs"      on public.prospect_score_runs;
create policy         "anon can insert score runs"      on public.prospect_score_runs    for insert to anon, authenticated with check (true);

drop policy if exists "anon can read score factors"     on public.prospect_score_factors;
create policy         "anon can read score factors"     on public.prospect_score_factors for select to anon, authenticated using (true);
drop policy if exists "anon can insert score factors"   on public.prospect_score_factors;
create policy         "anon can insert score factors"   on public.prospect_score_factors for insert to anon, authenticated with check (true);

-- ─────────────────────────────────────────────────────────────
-- Grants
-- ─────────────────────────────────────────────────────────────

grant select, insert on public.prospect_score_runs    to anon, authenticated;
grant select, insert on public.prospect_score_factors to anon, authenticated;
grant execute on function public.persist_icp_score_run(uuid,text,numeric,text,integer,text,timestamptz,text,jsonb) to anon, authenticated;

drop policy if exists "anon can update prospect score" on public.prospects;
create policy "anon can update prospect score" on public.prospects
  for update to anon, authenticated using (true) with check (true);

grant update (
  icp_score, icp_reason, icp_score_version, icp_scored_at,
  icp_coverage, icp_scoring_status, current_score_run_id, updated_at
) on public.prospects to anon, authenticated;
