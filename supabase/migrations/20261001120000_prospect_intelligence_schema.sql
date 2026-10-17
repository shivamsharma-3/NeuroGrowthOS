-- Step 4 Phase 1: Prospect intelligence schema and data contracts.
-- Additive only. Research tables are intentionally not exposed to anon/authenticated
-- clients until a server-side research API and authorization model are implemented.

create table if not exists public.company_research_runs (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies(id) on delete cascade,
  status text not null default 'queued'
    check (status in ('queued', 'running', 'completed', 'failed', 'cancelled')),
  provider text,
  profile_version text,
  started_at timestamptz,
  completed_at timestamptz,
  error_code text,
  summary text,
  created_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  constraint company_research_runs_time_order
    check (completed_at is null or started_at is null or completed_at >= started_at),
  constraint company_research_runs_lifecycle
    check (
      (status = 'queued' and started_at is null and completed_at is null)
      or (status = 'running' and started_at is not null and completed_at is null)
      or (status in ('completed', 'failed', 'cancelled') and completed_at is not null)
    ),
  constraint company_research_runs_id_company_unique unique (id, company_id)
);

create index if not exists company_research_runs_company_created_idx
  on public.company_research_runs (company_id, created_at desc);
create index if not exists company_research_runs_status_created_idx
  on public.company_research_runs (status, created_at);

create table if not exists public.company_evidence (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies(id) on delete cascade,
  research_run_id uuid,
  source_type text not null
    check (source_type in ('official_website', 'search_result', 'user_provided', 'third_party', 'platform_detection', 'other')),
  source_name text not null check (length(trim(source_name)) > 0),
  source_url text,
  observed_at timestamptz not null,
  retrieved_at timestamptz not null default now(),
  excerpt text,
  content_hash text,
  confidence numeric(4,3) check (confidence is null or confidence between 0 and 1),
  status text not null default 'candidate'
    check (status in ('candidate', 'accepted', 'rejected', 'conflicted', 'stale')),
  created_at timestamptz not null default now(),
  constraint company_evidence_url_http
    check (source_url is null or source_url ~* '^https?://'),
  constraint company_evidence_source_url_required
    check (source_type = 'user_provided' or source_url is not null),
  constraint company_evidence_research_run_same_company_fk
    foreign key (research_run_id, company_id)
    references public.company_research_runs(id, company_id) on delete set null (research_run_id),
  constraint company_evidence_id_company_unique unique (id, company_id)
);

create index if not exists company_evidence_company_observed_idx
  on public.company_evidence (company_id, observed_at desc);
create index if not exists company_evidence_run_idx
  on public.company_evidence (research_run_id) where research_run_id is not null;
create index if not exists company_evidence_company_status_idx
  on public.company_evidence (company_id, status);
create unique index if not exists company_evidence_company_hash_unique
  on public.company_evidence (company_id, content_hash) where content_hash is not null;

create table if not exists public.company_facts (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies(id) on delete cascade,
  fact_key text not null
    check (fact_key in ('industry', 'geography', 'company_size', 'revenue', 'platform')),
  value_jsonb jsonb not null,
  status text not null default 'candidate'
    check (status in ('candidate', 'accepted', 'rejected', 'conflicted', 'stale')),
  confidence numeric(4,3) check (confidence is null or confidence between 0 and 1),
  source_evidence_id uuid not null,
  observed_at timestamptz not null,
  valid_until timestamptz,
  created_at timestamptz not null default now(),
  constraint company_facts_evidence_same_company_fk
    foreign key (source_evidence_id, company_id)
    references public.company_evidence(id, company_id) on delete restrict,
  constraint company_facts_validity_order
    check (valid_until is null or valid_until >= observed_at),
  constraint company_facts_value_matches_key
    check (
      (fact_key in ('industry', 'geography', 'platform') and jsonb_typeof(value_jsonb) = 'string')
      or (fact_key = 'company_size' and jsonb_typeof(value_jsonb) = 'number'
        and value_jsonb::text ~ '^[0-9]+$')
      or (fact_key = 'revenue' and jsonb_typeof(value_jsonb) = 'object'
        and value_jsonb ?& array['amount', 'currency', 'period']
        and jsonb_typeof(value_jsonb->'amount') = 'number'
        and (value_jsonb->>'amount')::numeric >= 0
        and jsonb_typeof(value_jsonb->'currency') = 'string'
        and value_jsonb->>'currency' ~ '^[A-Z]{3}$'
        and jsonb_typeof(value_jsonb->'period') = 'string'
        and value_jsonb->>'period' in ('annual', 'quarterly', 'monthly', 'lifetime', 'unknown'))
    )
);

create index if not exists company_facts_company_key_created_idx
  on public.company_facts (company_id, fact_key, created_at desc);
create index if not exists company_facts_company_status_idx
  on public.company_facts (company_id, status);
create unique index if not exists company_facts_one_accepted_current_idx
  on public.company_facts (company_id, fact_key) where status = 'accepted';

create table if not exists public.company_growth_signals (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies(id) on delete cascade,
  signal_type text not null
    check (signal_type in ('recent_funding', 'relevant_hiring', 'market_expansion', 'verified_growth', 'verified_contraction')),
  observed_at timestamptz not null,
  confidence numeric(4,3) not null check (confidence between 0 and 1),
  status text not null default 'candidate'
    check (status in ('candidate', 'accepted', 'rejected', 'conflicted', 'stale')),
  evidence_id uuid not null,
  summary text,
  valid_until timestamptz,
  created_at timestamptz not null default now(),
  constraint company_growth_signals_evidence_same_company_fk
    foreign key (evidence_id, company_id)
    references public.company_evidence(id, company_id) on delete restrict,
  constraint company_growth_signals_validity_order
    check (valid_until is null or valid_until >= observed_at),
  constraint company_growth_signals_evidence_unique
    unique (company_id, signal_type, observed_at, evidence_id)
);

create index if not exists company_growth_signals_company_observed_idx
  on public.company_growth_signals (company_id, observed_at desc);
create index if not exists company_growth_signals_company_status_idx
  on public.company_growth_signals (company_id, status);

-- RLS is enabled with no client policies, so anon/authenticated roles cannot
-- read or write research material. A future server-side API must use an
-- appropriately protected database role and add narrowly scoped access rules.
alter table public.company_research_runs enable row level security;
alter table public.company_evidence enable row level security;
alter table public.company_facts enable row level security;
alter table public.company_growth_signals enable row level security;

revoke all on public.company_research_runs from public, anon, authenticated;
revoke all on public.company_evidence from public, anon, authenticated;
revoke all on public.company_facts from public, anon, authenticated;
revoke all on public.company_growth_signals from public, anon, authenticated;
