-- Search and official-site URLs are normalized with URL.toString() before
-- storage (including stripping fragments). This guard closes the race between
-- concurrent workers that both look up a URL before inserting evidence.
create unique index if not exists company_evidence_company_source_url_unique
  on public.company_evidence (company_id, source_url);
