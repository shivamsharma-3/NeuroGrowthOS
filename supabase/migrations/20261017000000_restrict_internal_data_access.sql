-- Restrict prospect and scoring data to authorized server routes.
-- Earlier prototype migrations intentionally exposed these objects to browser
-- roles. The application now uses the server-only service-role client after
-- verifying a Supabase session and the internal email allowlist.

begin;

drop policy if exists "anon can read companies" on public.companies;
drop policy if exists "anon can read contacts" on public.contacts;
drop policy if exists "anon can read prospects" on public.prospects;
drop policy if exists "anon can create prospect bundles" on public.companies;
drop policy if exists "anon can create contacts" on public.contacts;
drop policy if exists "anon can create prospects" on public.prospects;
drop policy if exists "anon can update prospect score" on public.prospects;
drop policy if exists "anon can read score runs" on public.prospect_score_runs;
drop policy if exists "anon can insert score runs" on public.prospect_score_runs;
drop policy if exists "anon can read score factors" on public.prospect_score_factors;
drop policy if exists "anon can insert score factors" on public.prospect_score_factors;

revoke all on table public.companies from public, anon, authenticated;
revoke all on table public.contacts from public, anon, authenticated;
revoke all on table public.prospects from public, anon, authenticated;
revoke all on table public.prospect_score_runs from public, anon, authenticated;
revoke all on table public.prospect_score_factors from public, anon, authenticated;

revoke execute on function public.create_prospect_bundle(jsonb) from public, anon, authenticated;
revoke execute on function public.persist_icp_score_run(uuid,text,numeric,text,integer,text,timestamptz,text,jsonb)
  from public, anon, authenticated;

grant all on table public.companies to service_role;
grant all on table public.contacts to service_role;
grant all on table public.prospects to service_role;
grant all on table public.prospect_score_runs to service_role;
grant all on table public.prospect_score_factors to service_role;
grant execute on function public.create_prospect_bundle(jsonb) to service_role;
grant execute on function public.persist_icp_score_run(uuid,text,numeric,text,integer,text,timestamptz,text,jsonb)
  to service_role;

commit;
