create extension if not exists pgcrypto;

create table if not exists public.companies (
  id uuid primary key default gen_random_uuid(),
  name text not null check (length(trim(name)) > 0),
  website text,
  domain text,
  industry text,
  country text,
  estimated_revenue numeric(18, 2) check (estimated_revenue is null or estimated_revenue >= 0),
  employee_count integer check (employee_count is null or employee_count >= 0),
  platform text,
  linkedin_url text,
  description text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create unique index if not exists companies_domain_unique on public.companies (domain) where domain is not null;

create table if not exists public.contacts (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies(id) on delete cascade,
  first_name text,
  last_name text,
  email text,
  job_title text,
  linkedin_url text,
  email_status text,
  created_at timestamptz not null default now()
);

create index if not exists contacts_company_id_idx on public.contacts (company_id);
create index if not exists contacts_email_idx on public.contacts (lower(email)) where email is not null;

create table if not exists public.prospects (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies(id) on delete cascade,
  contact_id uuid references public.contacts(id) on delete set null,
  icp_score numeric(5, 2) check (icp_score is null or icp_score between 0 and 100),
  icp_reason text,
  status text not null default 'new' check (status in ('new', 'researching', 'qualified', 'contacted', 'in_progress', 'converted', 'disqualified')),
  source text not null default 'manual',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists prospects_company_id_idx on public.prospects (company_id);
create index if not exists prospects_status_idx on public.prospects (status);
create index if not exists prospects_icp_score_idx on public.prospects (icp_score desc nulls last);

create or replace function public.set_updated_at()
returns trigger language plpgsql as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

drop trigger if exists companies_set_updated_at on public.companies;
create trigger companies_set_updated_at before update on public.companies
for each row execute function public.set_updated_at();

drop trigger if exists prospects_set_updated_at on public.prospects;
create trigger prospects_set_updated_at before update on public.prospects
for each row execute function public.set_updated_at();

-- Each submission is atomic. A normalized domain prevents duplicate companies,
-- while an existing company can still receive a new contact and prospect record.
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
    insert into public.companies (name, website, domain, industry, country, estimated_revenue, employee_count, platform, linkedin_url, description)
    values (
      payload #>> '{company,name}', payload #>> '{company,website}', nullif(lower(trim(payload #>> '{company,domain}')), ''),
      payload #>> '{company,industry}', payload #>> '{company,country}', nullif(payload #>> '{company,estimated_revenue}', '')::numeric,
      nullif(payload #>> '{company,employee_count}', '')::integer, payload #>> '{company,platform}', payload #>> '{company,linkedin_url}', payload #>> '{company,description}'
    )
    on conflict (domain) where domain is not null do nothing
    returning * into company_row;

    company_was_created := found;
    if not company_was_created then
      select * into company_row from public.companies
      where domain = nullif(lower(trim(payload #>> '{company,domain}')), '');
    end if;
  end if;

  if skip_existing and not company_was_created then
    return jsonb_build_object('company_id', company_row.id, 'company_created', false, 'duplicate', true);
  end if;

  if contact_payload is not null and (
    nullif(trim(contact_payload ->> 'first_name'), '') is not null or
    nullif(trim(contact_payload ->> 'last_name'), '') is not null or
    nullif(trim(contact_payload ->> 'email'), '') is not null or
    nullif(trim(contact_payload ->> 'job_title'), '') is not null or
    nullif(trim(contact_payload ->> 'linkedin_url'), '') is not null
  ) then
    insert into public.contacts (company_id, first_name, last_name, email, job_title, linkedin_url)
    values (company_row.id, nullif(trim(contact_payload ->> 'first_name'), ''), nullif(trim(contact_payload ->> 'last_name'), ''), nullif(lower(trim(contact_payload ->> 'email')), ''), nullif(trim(contact_payload ->> 'job_title'), ''), nullif(trim(contact_payload ->> 'linkedin_url'), ''))
    returning * into contact_row;
  end if;

  insert into public.prospects (company_id, contact_id, status, source)
  values (company_row.id, contact_row.id, coalesce(nullif(payload ->> 'status', ''), 'new'), coalesce(nullif(payload ->> 'source', ''), 'manual'))
  returning * into prospect_row;

  return jsonb_build_object(
    'company_id', company_row.id, 'contact_id', contact_row.id, 'prospect_id', prospect_row.id,
    'company_created', company_was_created, 'duplicate', false
  );
end;
$$;

alter table public.companies enable row level security;
alter table public.contacts enable row level security;
alter table public.prospects enable row level security;

-- Portfolio-stage access for the configured anon key. Replace these policies
-- with authenticated team policies before exposing this database to the public.
drop policy if exists "anon can read companies" on public.companies;
create policy "anon can read companies" on public.companies for select to anon using (true);
drop policy if exists "anon can read contacts" on public.contacts;
create policy "anon can read contacts" on public.contacts for select to anon using (true);
drop policy if exists "anon can read prospects" on public.prospects;
create policy "anon can read prospects" on public.prospects for select to anon using (true);
drop policy if exists "anon can create prospect bundles" on public.companies;
create policy "anon can create prospect bundles" on public.companies for insert to anon with check (true);
drop policy if exists "anon can create contacts" on public.contacts;
create policy "anon can create contacts" on public.contacts for insert to anon with check (true);
drop policy if exists "anon can create prospects" on public.prospects;
create policy "anon can create prospects" on public.prospects for insert to anon with check (true);

grant select, insert on public.companies to anon;
grant select, insert on public.contacts to anon;
grant select, insert on public.prospects to anon;
grant execute on function public.create_prospect_bundle(jsonb) to anon;
