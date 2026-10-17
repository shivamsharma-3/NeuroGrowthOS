-- Phase A ICP foundation. Legacy estimated_revenue is retained and never
-- interpreted as USD by the scorer.
alter table public.companies
  add column if not exists revenue_amount numeric(18,2),
  add column if not exists revenue_currency text,
  add column if not exists revenue_period text,
  add column if not exists revenue_source text,
  add column if not exists revenue_observed_at timestamptz;

alter table public.companies
  add constraint companies_revenue_amount_nonnegative check (revenue_amount is null or revenue_amount >= 0),
  add constraint companies_revenue_currency_iso check (revenue_currency is null or revenue_currency ~ '^[A-Z]{3}$'),
  add constraint companies_revenue_period_check check (revenue_period is null or revenue_period in ('annual','quarterly','monthly','lifetime','unknown')),
  add constraint companies_revenue_metadata_complete check (
    revenue_amount is null or (revenue_currency is not null and revenue_period is not null and revenue_source is not null and revenue_observed_at is not null)
  );

alter table public.prospects
  add column if not exists icp_score_version text,
  add column if not exists icp_scored_at timestamptz,
  add column if not exists icp_coverage integer check (icp_coverage is null or icp_coverage between 0 and 100),
  add column if not exists icp_scoring_status text not null default 'unscored'
    check (icp_scoring_status in ('unscored','scored','insufficient_data'));

create index if not exists companies_domain_idx on public.companies (domain);
create index if not exists prospects_score_version_idx on public.prospects (icp_score_version);

-- Keep the existing atomic create/import RPC compatible and persist optional
-- revenue metadata from the new form and CSV columns.
create or replace function public.create_prospect_bundle(payload jsonb)
returns jsonb language plpgsql security invoker set search_path = public as $$
declare
  company_row public.companies;
  existing_company_id uuid;
  contact_row public.contacts;
  prospect_row public.prospects;
  company_was_created boolean;
  skip_existing boolean := coalesce((payload ->> 'skip_existing')::boolean, false);
  contact_payload jsonb := payload -> 'contact';
begin
  if nullif(lower(trim(payload #>> '{company,domain}')), '') is not null then
    select id into existing_company_id from public.companies
    where domain = nullif(lower(trim(payload #>> '{company,domain}')), '');
  end if;

  if existing_company_id is not null then
    select * into company_row from public.companies where id = existing_company_id;
    company_was_created := false;
  else
    insert into public.companies (name, website, domain, industry, country, estimated_revenue, revenue_amount, revenue_currency, revenue_period, revenue_source, revenue_observed_at, employee_count, platform, linkedin_url, description)
    values (
      payload #>> '{company,name}', payload #>> '{company,website}', nullif(lower(trim(payload #>> '{company,domain}')), ''),
      payload #>> '{company,industry}', payload #>> '{company,country}', nullif(payload #>> '{company,estimated_revenue}', '')::numeric,
      nullif(payload #>> '{company,revenue_amount}', '')::numeric, nullif(payload #>> '{company,revenue_currency}', ''),
      nullif(payload #>> '{company,revenue_period}', ''), nullif(payload #>> '{company,revenue_source}', ''),
      nullif(payload #>> '{company,revenue_observed_at}', '')::timestamptz,
      nullif(payload #>> '{company,employee_count}', '')::integer, payload #>> '{company,platform}', payload #>> '{company,linkedin_url}', payload #>> '{company,description}'
    )
    on conflict (domain) where domain is not null do nothing
    returning * into company_row;

    company_was_created := found;
    if not company_was_created then
      select * into company_row from public.companies where domain = nullif(lower(trim(payload #>> '{company,domain}')), '');
    end if;
  end if;

  if skip_existing and not company_was_created then
    return jsonb_build_object('company_id', company_row.id, 'company_created', false, 'duplicate', true);
  end if;

  if contact_payload is not null and (
    nullif(trim(contact_payload ->> 'first_name'), '') is not null or nullif(trim(contact_payload ->> 'last_name'), '') is not null or
    nullif(trim(contact_payload ->> 'email'), '') is not null or nullif(trim(contact_payload ->> 'job_title'), '') is not null or
    nullif(trim(contact_payload ->> 'linkedin_url'), '') is not null
  ) then
    insert into public.contacts (company_id, first_name, last_name, email, job_title, linkedin_url)
    values (company_row.id, nullif(trim(contact_payload ->> 'first_name'), ''), nullif(trim(contact_payload ->> 'last_name'), ''), nullif(lower(trim(contact_payload ->> 'email')), ''), nullif(trim(contact_payload ->> 'job_title'), ''), nullif(trim(contact_payload ->> 'linkedin_url'), ''))
    returning * into contact_row;
  end if;

  insert into public.prospects (company_id, contact_id, status, source)
  values (company_row.id, contact_row.id, coalesce(nullif(payload ->> 'status', ''), 'new'), coalesce(nullif(payload ->> 'source', ''), 'manual'))
  returning * into prospect_row;

  return jsonb_build_object('company_id', company_row.id, 'contact_id', contact_row.id, 'prospect_id', prospect_row.id, 'company_created', company_was_created, 'duplicate', false);
end;
$$;

-- The public anon key can update only the current score metadata columns.
grant update (icp_score, icp_reason, icp_score_version, icp_scored_at, icp_coverage, icp_scoring_status, updated_at) on public.prospects to anon;
drop policy if exists "anon can update prospect score" on public.prospects;
create policy "anon can update prospect score" on public.prospects for update to anon using (true) with check (true);
