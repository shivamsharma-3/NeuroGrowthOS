# GrowthOS AI — Project Context

Last verified: **2026-10-18** (Asia/Calcutta). This document describes the repository at the time of inspection. It contains no credentials.

## 1. Project Overview

GrowthOS AI is a Next.js web app for organizing target companies and contacts, researching company evidence, and qualifying prospects with a deterministic ideal-customer-profile (ICP) score. The implemented user-facing area is `/prospects`; the sidebar presents other product areas as coming soon.

- **Target users:** growth and go-to-market teams. The UI labels the sample workspace “Growth Team”; deployment and customer/user research are not present in the repository.
- **Current stage:** working product foundation/prototype with prospect entry and import, internal email-allowlisted authorization for product data routes, company research, and versioned ICP score persistence. Production deployment and live Supabase migration state are unverified.
- **Important qualification:** The reviewed product baseline is committed at `c31966c4c24b28f64df509866b8d6d57a60cbbdd` on top of the Create Next App bootstrap commit. The repository still cannot establish the original author or exact development date for implementation work that predates this baseline.

## 2. Technology Stack

- Next.js **16.3.7**, App Router, React **19.2.8**, TypeScript **5.x** in strict mode.
- Tailwind CSS 4 and `lucide-react` for styles/icons; Papa Parse for CSV import; Zod 4 for request/data validation; Vitest 4 for tests.
- Supabase Postgres and Supabase Auth, using `@supabase/supabase-js` and `@supabase/ssr`.
- Tavily Search API is an optional research provider. Direct HTTP(S) requests collect evidence from the company’s official website.
- `openai` and `recharts` appear in `package.json`, but no current import/use was found during this inspection. No OpenAI-powered feature is implemented in the inspected source.
- `npm` scripts and `package-lock.json` are present. No deployment manifest, CI workflow, Docker configuration, or Supabase CLI configuration was found. The README describes manual SQL Editor migration setup. Actual hosting is unknown.

## 3. Architecture and Data Flow

1. The client page at `app/prospects/page.tsx` fetches prospect data from `/api/prospects`, then provides local search/filter/pagination, create, CSV import, scoring, research, and score inspection UI.
2. Prospect create/import APIs authorize the internal user, require same-origin mutations, validate payloads, and call the Postgres `create_prospect_bundle(jsonb)` RPC through the server-only service-role client. Company domains are normalized before submission.
3. Internal sign-in uses Supabase email OTP and a server-side email allowlist. Prospect, research, and score endpoints call `requireInternalUser()` before privileged work; browser roles are removed from direct product-data access by the final migration.
4. A research request inserts a queued `company_research_runs` row and then invokes `processResearchRun()` synchronously in the same request. This is not a separate queue consumer/background deployment in this repository.
5. Research attempts safe official-site collection and, when `TAVILY_API_KEY` exists, supplementary bounded Tavily searches. Evidence is persisted and deduplicated by company/source URL; facts and growth signals are extracted as candidates and separately validated against their evidence.
6. The score endpoint loads canonical company fields plus accepted research facts, growth signals, their evidence, and the latest completed research date. Adapters fail closed on invalid, conflicted, stale, or ineligible rows. `scoreIcp()` computes a deterministic result; `persist_icp_score_run(...)` writes one score run, six factor rows, and the current prospect projection atomically.

Next.js 16 calls request interception `proxy.ts` (the former middleware convention). This Proxy refreshes Supabase claims/cookies; it is not the authorization boundary. Route handlers use the promise-based dynamic `params` shape used by the installed Next.js version.

## 4. Directory Map

- `app/` — App Router pages, global styles, auth callback, and API handlers.
  - `app/prospects/page.tsx` — implemented prospects workspace.
  - `app/login/page.tsx` — internal login UI.
  - `app/api/prospects/` — list/create, CSV import, research trigger, score, current score, and score history routes.
  - `app/api/internal-auth/` — OTP login, OTP verification, session status, and logout.
  - `app/auth/callback/route.ts` — Supabase auth callback.
- `src/components/` — client components for login, prospect table/filter/form/CSV import, and score details modal.
- `src/config/icp/ecom-d2c-v1.0.0.ts` — the versioned scoring profile.
- `src/lib/auth/` — internal email allowlist and authorization helper.
- `src/lib/icp/` — scorer, accepted-fact/growth-signal adapters, and score persistence mapping.
- `src/lib/prospects/` — input normalization and research-action client helper.
- `src/lib/research/` — evidence schemas, search/official-site collection, fact and growth-signal extraction/validation, and research worker.
- `src/lib/supabase/` — browser, server/session, proxy, and server-only admin Supabase clients.
- `src/types/` — prospect, ICP, research, and score-history types.
- `supabase/migrations/` — ordered SQL schema/function/policy changes (see Database Reference).
- `public/` — stock Create Next App SVG assets retained from the scaffold; the root page now redirects to `/prospects` and does not use them.
- Root config: `package.json`, `package-lock.json`, `tsconfig.json`, `next.config.ts`, `eslint.config.mjs`, `postcss.config.mjs`, `vitest.config.ts`.
- `AGENTS.md` — managed Next.js rules plus mandatory project-context update protocol. `CLAUDE.md` points to it with `@AGENTS.md`.
- `README.md` — clean setup, all six migrations, environment variables, internal authentication prerequisites, local commands, and checks.

## 5. Database Reference

The six SQL files below define the schema and access-policy changes in migration order. The filenames establish intended chronology; whether any environment has applied them is **unverified**.

### Tables

- `public.companies` — `id`, `name`, `website`, `domain`, `industry`, `country`, legacy `estimated_revenue`, `employee_count`, `platform`, `linkedin_url`, `description`, `created_at`, `updated_at`; ICP Phase A adds `revenue_amount`, `revenue_currency`, `revenue_period`, `revenue_source`, `revenue_observed_at`. Domain has a partial unique index when non-null. Revenue checks require nonnegative amount, uppercase three-letter currency, allowed period, and complete metadata when amount is set.
- `public.contacts` — `id`, `company_id` (cascade to company), `first_name`, `last_name`, `email`, `job_title`, `linkedin_url`, `email_status`, `created_at`; indexes by company and lowercased email.
- `public.prospects` — `id`, `company_id` (cascade), nullable `contact_id` (set null on contact delete), legacy score/reason, status/source, timestamps; Phase A adds `icp_score_version`, `icp_scored_at`, `icp_coverage`, `icp_scoring_status`; Phase B adds nullable `current_score_run_id` (set null on run delete). Status is constrained to `new`, `researching`, `qualified`, `contacted`, `in_progress`, `converted`, `disqualified`.
- `public.prospect_score_runs` — `id`, `prospect_id` (cascade), `score_version`, nullable `total_score`, `priority`, `coverage`, `scoring_status`, `scored_at`, `created_at`. Priority and scoring status are constrained; coverage is 0–100.
- `public.prospect_score_factors` — `id`, `score_run_id` (cascade), `factor_key`, nullable `score`, `max_score`, `status`, `reason`, `created_at`; one factor key per run, factor status constrained to `strong`, `partial`, `poor`, `unknown`.
- `public.company_research_runs` — `id`, `company_id` (cascade), `status`, `provider`, `profile_version`, `started_at`, `completed_at`, `error_code`, `summary`, nullable `created_by` referencing `auth.users` with set-null, `created_at`; checks enforce lifecycle/time ordering and `(id, company_id)` is unique.
- `public.company_evidence` — `id`, `company_id` (cascade), nullable `research_run_id`, `source_type`, `source_name`, nullable `source_url`, `observed_at`, `retrieved_at`, `excerpt`, `content_hash`, nullable `confidence`, `status`, `created_at`; composite run/company foreign key, HTTP(S) URL constraint, `(id, company_id)` unique. Partial unique index on `(company_id, content_hash)` and later unique `(company_id, source_url)` index prevent duplicates.
- `public.company_facts` — `id`, `company_id` (cascade), `fact_key`, `value_jsonb`, `status`, nullable `confidence`, required `source_evidence_id`, `observed_at`, nullable `valid_until`, `created_at`; composite same-company evidence FK with delete restrict, validity-order and value/key-shape checks. Partial unique index permits one accepted current row per company/fact key.
- `public.company_growth_signals` — `id`, `company_id` (cascade), `signal_type`, `observed_at` (event date), `confidence`, `status`, required `evidence_id`, nullable `summary`, nullable `valid_until`, `created_at`; composite same-company evidence FK with delete restrict, validity-order check, unique `(company_id, signal_type, observed_at, evidence_id)`, indexes by company/date and company/status.

### Functions, indexes, and access rules

- `set_updated_at()` trigger maintains `companies.updated_at` and `prospects.updated_at`.
- `create_prospect_bundle(payload jsonb)` is `SECURITY INVOKER`, normalizes/looks up domains, optionally skips existing companies, and atomically adds a contact and prospect. Phase A replaces it to preserve revenue metadata.
- `persist_icp_score_run(...)` is `SECURITY DEFINER` with `search_path = public`; inserts a run and factor rows and updates the prospect projection in one transaction. Phase B initially grants browser-role execution; the final access migration revokes it and grants execution to `service_role` only.
- RLS is enabled on all application tables. The initial prospect and score migrations grant broad prototype access to `anon`/`authenticated`; `20261017000000_restrict_internal_data_access.sql` drops those policies, revokes table/function privileges from browser roles, and grants required access to `service_role`. This creates a server-only internal-workspace boundary, not tenant isolation.
- Research tables have RLS enabled and all privileges revoked from `public`, `anon`, and `authenticated`; no client policies/grants are defined there. Server code uses the service-role admin client after authorization for protected paths.
- There are no `company_growth_signals` date/provenance schema gaps: event date is `observed_at`, and `evidence_id` points to same-company evidence. No further schema migration was required by the growth-signal implementation.

### Migration chronology

1. `20260930000000_prospect_database.sql` — companies/contacts/prospects, indexes, timestamps, atomic prospect RPC, initial anon policies/grants.
2. `20260930122443_icp_phase_a.sql` — structured revenue fields, score projection metadata, RPC compatibility, limited score update.
3. `20260930180000_icp_phase_b.sql` — score run/factor history, current-run pointer, atomic persistence RPC, RLS/grants.
4. `20261001120000_prospect_intelligence_schema.sql` — research runs/evidence/facts/growth signals, validation constraints/indexes, private research tables.
5. `20261009163149_company_evidence_canonical_url_unique.sql` — company/source URL unique index to close duplicate insert races.
6. `20261017000000_restrict_internal_data_access.sql` — revoke browser-role prospect/score access and retain service-role access for authorized server routes.

## 6. Feature Inventory

### Implemented

- Prospect listing and local search/status/industry/score filters, 10-row pagination, add form, and CSV import in the prospects workspace.
- Domain normalization and dedupe behavior through the database RPC; up to 500 rows per import request.
- Deterministic six-factor ICP scoring, score history persistence, score detail UI, and research provenance in factor reasons/evidence fields.
- Email OTP internal login with exact normalized email allowlist authorization for prospect, research, and score endpoints; same-origin checks protect cookie-authenticated mutations.
- Official-site and optional search evidence collection, fact extraction/validation, and growth-signal extraction/validation.

### Partial, planned, or unavailable

- Sidebar destinations for overview/dashboard, research, audits, outreach/campaigns, pipeline, analytics, and settings are marked “Soon”; no matching pages were found.
- Prospect API supports listing and creation/import but no update/delete route was found. Contact management beyond create/display is not implemented.
- Research execution is synchronous in the trigger HTTP request, not an independently deployed background worker/queue consumer.
- No application settings/tenant/team model, deployment instructions beyond local setup, CI, or production runbook are present.
- Production data was inspected in one authorized live Bombas run on 2026-10-13 (run ID `b60194fd-8242-49f7-ae2b-c02262537e22`); zero growth signals were created. Deployment state and external provider credentials remain unverified. No score was recomputed.

## 7. Business Logic

Scoring is in `src/lib/icp/scorer.ts`; the fixed profile is `src/config/icp/ecom-d2c-v1.0.0.ts`. Do not change thresholds/weights without an explicitly versioned profile decision.

- Version: `ecom-d2c-v1.0.0`; total factor weights: revenue 25, industry 20, platform 15, geography 10, company size 10, growth signal 20 (100 total).
- Coverage counts factors whose score is known. A total score is emitted only with at least 60% weight coverage, at least three assessed factors, and at least one of revenue or industry known. The total is the weighted normalized score rescaled to 100 and rounded to an integer.
- Priority is high at 80+, medium at 60–79, otherwise low; no total yields `insufficient_data`.
- Factor statuses: strong at score/max ≥0.8; poor at ≤0.25; otherwise partial. Unknown fields have null scores.
- Revenue requires amount, currency, and an annualizable annual/quarterly/monthly period. `lifetime` and `unknown` periods are unknown. Fixed USD conversion rates are labeled as based on ECB reference data dated 2026-09-29; quarterly/monthly amounts annualize ×4/×12. Legacy `estimated_revenue` is never interpreted as USD without currency/period.
- Revenue score bands (annual USD): 0–1m:4; 1–5m:12; 5–10m:20; 10–75m:25; 75–150m:20; 150–250m:12; 250m+:4.
- Industry maps configured core/adjacent/related/non-target/unrelated aliases to 20/14/10/4/0; unknown labels remain unknown. Platform maps Shopify Plus 15, Shopify 14, BigCommerce 12, other known commerce 10, custom commerce 8, no commerce 0; unknown labels remain unknown. Geography tiers score priority 10, supported 6, limited 3, excluded 0; unknown labels remain unknown. Employee bands score 0–1:2, 2–9:4, 10–19:7, 20–500:10, 501–1,000:7, 1,001–5,000:4, 5,001+:2.
- Growth signal types earn 5 points each for recent funding, relevant hiring, market expansion, and verified growth, capped at 20; a verified contraction forces the growth signal score to zero. Confidence minimum is 0.6. If research is current (≤365 days) but has no eligible signal, the factor gets configured 8 points. Per-type max ages are funding 548 days, hiring 180 days, market expansion 365 days, verified growth/contraction 180 days. These are current source values, despite prior prompt shorthand describing a general 180-day window. The event's `observed_at`, not retrieval time, controls signal freshness.
- Research fact adapter admits only accepted schema-valid same-company facts supported by non-stale/non-rejected/non-conflicted evidence; multiple distinct accepted values for one key fail closed. A newer accepted fact marks its predecessor stale and records `valid_until` in the fact validator.

## 8. Research Pipeline

### Providers, collection, and deduplication

- `src/lib/research/official-website.ts` fetches homepage plus relevant same-origin pages; attempts same-origin homepage links/sitemaps and conventional paths if homepage content is not useful. It limits a request to 8 seconds, 1 MB per response, three redirects, five page fetches, two auxiliary fetches, and 30 seconds total. Evidence is candidate, confidence 0.7, with excerpt, URL, content hash, observed/retrieved timestamps.
- `src/lib/research/tavily-provider.ts` is disabled when `TAVILY_API_KEY` is absent. When enabled, it creates domain-qualified company queries, prioritizes configured trusted-source searches (LinkedIn, Shopify, B Corp), and then broader profile/industry/platform/geography/size/revenue queries. Max two results/query, 8-second timeout. `src/lib/research/search-research.ts` caps normalized results at 10/run, validates URLs, bounds snippets, strips URL fragments, hashes excerpts, and stores them as candidate evidence. Trusted-domain search results receive confidence 0.7, other search results 0.35; the optional configured allowlist is in `GROWTHOS_TRUSTED_RESEARCH_DOMAINS`.
- Evidence URLs are unique per company; a prior row is reused unchanged so original source and research-run provenance remain intact. On insert races, the worker re-queries and reuses the winner. The uniqueness migration protects this invariant in the database.
- Search run summaries now carry a bounded set (up to 40) of per-result diagnostics with sanitized HTTP(S) URL/domain, disposition (`eligible`, `persisted`, `reused`, `filtered`, or `rejected`), safe reason code, and, on reuse, evidence ID plus original research-run ID. Query strings/fragments and URL credentials are omitted from diagnostics; snippets, provider payloads, headers, and secrets are not copied. Company-wide URL deduplication and original evidence rows remain unchanged.

### Extraction, validation, freshness, and provenance

- `src/lib/research/website-facts.ts` extracts explicit industry, platform, geography, exact employee count, and revenue claims. Search-result facts require company identity text. Historical platform-transition language (including “migrated/switched to Shopify Plus”) is not treated as current usage. Approximate/ranged headcount and unsupported revenue estimates stay unknown.
- `src/lib/research/fact-validation.ts` verifies source type, URL/excerpt, confidence ≥0.7, fact/evidence timestamp match, company identity and explicit extraction. Untrusted sources are rejected, ambiguous/multiple values conflict, replaced accepted facts become stale. Only current-run or explicitly reused evidence rows can be changed by the worker; original evidence provenance is preserved.
- `src/lib/research/source-quality.ts` is the shared identity matcher for fact, growth-signal, and search-result paths. A standalone one-token brand/name is not identity proof: matching uses canonical company host with exact company context, exact verified profile URL, explicit canonical-domain mention, or exact name-bearing URL slug. Composite names such as Bombas Klassen/Rodase are rejected. Source identity remains separate from trust, confidence, freshness, and conflict checks.
- `src/lib/research/growth-signals.ts` extracts explicit date-bearing funding, relevant hiring, market expansion, verified revenue/sales/GMV/traffic growth or contraction events from official-site and search evidence. It requires identity text, HTTP(S), trusted configured search host or exact official company host, and evidence confidence ≥0.6. Undated, unsupported, future-dated, or unrelated claims do not become candidates.
- `src/lib/research/growth-signal-validation.ts` only accepts same-company signals linked to evidence retrieved in the same run; validates source trust, identity, explicit claim/date, confidence and date freshness. It uses event date for stale classification and marks conflicting same-type/date claims conflicted. Existing reused historical evidence is not promoted by a later run.
- `src/lib/icp/research-adapter.ts` and `app/api/prospects/[id]/score/route.ts` load database rows and only pass accepted, sufficiently confident, fresh signals with valid same-company evidence to scoring. Signal/evidence IDs are attached as provenance.
- Worker stage errors become safe error codes and failed run status. Search failure is supplementary and does not discard official-site evidence; diagnostics record counts/codes while avoiding provider secrets/raw payloads.

### Bombas / Shopify evidence: scope of available records

`src/lib/research/website-facts.test.ts` rejects historical/transition snippets such as “Bombas migrated to Shopify Plus” as proof of current platform, while testing current-use wording separately. `src/lib/research/fact-validation.test.ts` rejects that migration-only platform candidate and a founding-year-as-headcount candidate; it accepts an exact “Employees / Now: 296” fixture. `src/lib/research/worker-validation.integration.test.ts` tests that a reused historical founding-year candidate is rejected without rewriting its value or evidence provenance. Growth-signal tests use synthetic Bombas-named snippets. One authorized live Bombas research run was completed on 2026-10-13; its result is recorded below and in Change History. No score/re-score was run.

### Live Bombas research run (2026-10-13)

- Run `b60194fd-8242-49f7-ae2b-c02262537e22` completed through Tavily from 07:01:54Z to 07:02:18Z, with no run error. Search diagnostics: 18 results returned, 0 filtered irrelevant, 0 rejected for safety, 6 skipped duplicates, 6 reused, 4 persisted, and no Tavily failure code. Official website collection failed with `website_http_error`.
- Four evidence rows were newly persisted, all candidate at confidence 0.7: LinkedIn pages for **Bombas Klassen** and **Bombas Rodase** (unrelated namesakes); Shopify's white-glove migration article (historical migration/cost/sales context without an explicit event date); and a B Lab roundup (cumulative donation/founding context without a qualifying dated growth event). Their text did not yield growth signals. The two unrelated LinkedIn pages generated six newly extracted company-fact rows, all `conflicted`; none were accepted and canonical company fields were not overwritten.
- Six results were reported reused. The worker preserves original evidence provenance, but the stored run summary records only reuse counts, not reused row IDs/URLs. Therefore the exact six reused rows cannot be attributed to this run from persisted diagnostics alone. Older stored evidence includes a 2024 revenue claim and 2023 lifetime-sales claim at confidence 0.35; neither was promoted into a signal.
- `company_growth_signals` had **zero rows** for Bombas after the run. There was no accepted, rejected, stale, conflicted, or candidate signal to enumerate. No signal met the extractor's explicit event-type + event-date requirements from eligible evidence; retrieval time was not substituted for event time. The old low-confidence/historical claims remained evidence only.
- Canonical company values remained Bombas / `bombas.com`; optional industry, country, revenue, employee count, platform, and description remained null. The prospect remained at its prior 40% coverage / insufficient-data state, scored 2026-10-10. No score action was triggered.
- **Issue discovered:** identity matching accepts a standalone domain-brand token `bombas`; that token also appears in “Bombas Klassen” and “Bombas Rodase”. Those unrelated pages passed identity matching far enough to create candidate facts, which were later conflicted against existing accepted company facts. They did not affect canonical fields or growth signals in this run, but the matcher is too permissive and should be corrected before another live research run. A second operational issue is that run diagnostics do not persist per-result reused evidence provenance.

## 9. Authentication and Security

- `src/lib/auth/email-allowlist.ts` normalizes a comma-separated `GROWTHOS_INTERNAL_EMAILS` list. Empty/unconfigured list returns 503; unauthenticated returns 401; signed-in non-allowlisted email returns 403.
- OTP login/verification enforce same-origin `Origin` headers. Login returns a generic response to avoid disclosing allowlist membership. Callback checks confirmed email and allowlist. `requireInternalUser()` verifies the current user server-side, fails closed on missing configuration/session-client failure, and Proxy only refreshes claims/cookies.
- Prospect list/create/import, research, current score, score history, and re-score routes require internal authorization before service-role access. All cookie-authenticated mutation routes require an exact same-origin request. Database failures return generic client messages, and server logs retain only bounded database error codes plus a CSV row number where applicable.
- `SUPABASE_SERVICE_ROLE_KEY` is read only in `src/lib/supabase/admin.ts` marked `server-only`; never expose it in a `NEXT_PUBLIC_` variable. Session/browser clients use the public publishable key.
- Official and search URLs are restricted to HTTP(S), reject credentials/nonstandard ports, reject private/non-public IPs including DNS results, pin resolved addresses for the request, disallow cross-origin redirects, downgrade redirects, and bound time/size. Search result hostnames are revalidated before collection.
- Requests use Zod validation, UUID checks, CSV row limits, bounded text/snippet sizes. No formal multi-tenant/team authorization or tenant-scoped database policy is implemented.
- The initial migrations contain broad browser-role policies, so environments remain exposed until the final restriction migration is applied. Source review and fixtures verify the migration text, not its deployment to a real Supabase project.

## 10. Environment Configuration

Only variable names and purposes are recorded; no local environment values were inspected or copied here.

| Variable | Purpose | Requirement/status |
| --- | --- | --- |
| `NEXT_PUBLIC_SUPABASE_URL` | Supabase project URL used by browser, server, proxy, and admin clients | Required for database/auth features |
| `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY` | Supabase public/publishable key for client/session clients | Required for database/auth features; safe for browser by design |
| `SUPABASE_SERVICE_ROLE_KEY` | Privileged server-side prospect/research/scoring reads/writes | Required for product-data paths; secret; server only |
| `GROWTHOS_INTERNAL_EMAILS` | Comma-separated authorized internal user email allowlist | Required for internal routes; missing/empty denies with 503; included as a reserved-domain placeholder in `.env.example` |
| `TAVILY_API_KEY` | Enables supplementary Tavily search | Optional; absent disables search provider |
| `GROWTHOS_TRUSTED_RESEARCH_DOMAINS` | Comma-separated trusted domain allowlist for stronger search confidence and evidence eligibility | Optional syntactically, but needed for third-party search claims to meet trust policy; no secret |

`.env.example` contains placeholders for the Supabase URL, publishable key, internal-email allowlist, and server-only service-role key. Tavily and trusted-domain values are present but empty because they are optional. `.env.local` presence was observed, but its contents were deliberately not read. There is no `OPENAI_API_KEY` usage in current source.

## 11. Testing and Verification

Package scripts: `npm test` (`vitest run`), `npm run lint` (`eslint`), `npx tsc --noEmit`, `npm run build`.

Important tests include:

- `src/lib/icp/scorer.test.ts`, `src/lib/icp/research-adapter.test.ts`, `src/lib/icp/persistence.test.ts`.
- `src/lib/research/website-facts.test.ts`, `fact-validation.test.ts`, `official-website.test.ts`, `search-research.test.ts`, `tavily-provider.test.ts`, `worker.test.ts`, `worker-validation.integration.test.ts`.
- Growth-signal coverage: `growth-signals.test.ts`, `growth-signal-worker.integration.test.ts`, `growth-signal-scoring.integration.test.ts`.
- End-to-end in-memory pipeline: `research-scoring.integration.test.ts`.
- Auth and route tests: `src/lib/auth/internal-authorization.test.ts`, `src/lib/auth/research-access.test.ts`, `app/api/internal-auth/verify/route.test.ts`, `app/api/prospects/[id]/research/route.test.ts`, `src/lib/prospects/research-action.test.ts`.

**Last verified 2026-10-13:** 21 test files / 206 tests passed; ESLint passed; `tsc --noEmit` passed; Next.js production build passed. In this Windows environment `npm` was not on PATH, so the checks used the installed Node CLIs: `node node_modules/vitest/vitest.mjs run`, `node node_modules/eslint/bin/eslint.js`, `node node_modules/typescript/bin/tsc --noEmit`, and `node node_modules/next/dist/bin/next build`. `git diff --check` also passed after the baseline documentation corrections. No live network research, company rescoring, SQL migration application, or live database validation was performed. The build generated ignored `.next/` output.

**Coverage gaps:** Vitest integration tests use fixture/mocked providers and in-memory repository clients; they do not exercise a real Supabase instance, actual SQL/RLS behavior, or an end-to-end browser session. There is no E2E test framework/config in the repository.

## 12. Setup and Operations

1. Install dependencies with the package manager matching the committed npm lockfile (`npm ci` when npm is available).
2. Create a Supabase project. Copy `.env.example` to `.env.local`, supply the public Supabase URL/publishable key and server-only service-role key. Configure `GROWTHOS_INTERNAL_EMAILS`; optionally configure Tavily and trusted research domains.
3. Apply all six SQL migrations in filename order through Supabase SQL Editor or another deliberate PostgreSQL migration workflow; this repository has no Supabase CLI project configuration. The final `20261017000000_restrict_internal_data_access.sql` migration depends on the prospect and scoring tables/functions created by the earlier migrations and must be applied last.
4. Start with `npm run dev`; open `/prospects`. Internal scoring/research requires a confirmed allowlisted Supabase Auth email. Research will use official site collection even without Tavily; search is disabled without its key.
5. Checks: `npm test`, `npm run lint`, `npx tsc --noEmit`, `npm run build`.

Safe testing uses Vitest fixtures and mocked providers/database clients. Do not use a real prospect or call research while validating implementation unless explicitly requested. No live database migration, deployment, or operational secrets have been verified here.

## 13. Important Decisions and Rationale

- Keep scoring deterministic and versioned so profile changes can be reviewed and historical score runs identify their version.
- Never reinterpret legacy `estimated_revenue` as USD without currency and reporting period; preserve unknowns rather than manufacture score inputs.
- Preserve evidence provenance and original run/source for reused URLs; deduplicate at database level to handle worker races.
- Search snippets remain candidate evidence; trust/identity/confidence and exact support are checked separately before accepting facts/signals.
- Research data is protected from anon/authenticated direct access; privileged server routes use service-role client only after internal authorization.
- Do not change scoring thresholds, reuse historical low-confidence claims, or promote old Bombas evidence without new trusted evidence and explicit validation.
- Keep Next.js-managed `AGENTS.md` block intact; Next dev regenerates it. Project protocol is appended outside its managed block.

## 14. Known Bugs and Risks

Confirmed from source/config:

1. Research runs inline within the trigger request; large/slow work can exceed host request limits. No durable async worker scheduling is configured.
2. The database calls the event timestamp `observed_at`; documentation/product copy should explain that growth-signal extraction interprets it as event date, while evidence `retrieved_at` is retrieval time.
3. The application has one internal workspace and no tenant/team ownership model. Applying the final access migration prevents direct browser-role access, but every allowlisted internal user can access all workspace records.
4. No application-level or verified hosting-edge rate limiting is implemented for OTP requests or privileged operations.
5. **Observed in the prior live Bombas run; fixed in the current source and covered by regression fixtures:** the old identity helper accepted a standalone `bombas` token, allowing Bombas Klassen and Bombas Rodase pages to produce candidate facts. `src/lib/research/source-quality.ts` now requires stronger identity context and the tests cover both namesakes plus supported company profiles/case studies. Post-fix live provider behavior remains unverified because the follow-up run was skipped.
6. **Verified in live Bombas run, fixed in source and covered by integration tests:** old run summaries retained reuse counts but not reused evidence IDs/URLs. Summaries now include bounded row-level attribution. The prior run cannot be retroactively annotated; its official Bombas-site fetch returned `website_http_error`, while Tavily completed without provider error.
7. **Found in read-only tree-diff review; now fixed in source and fixture tests:** canonical-domain mentions previously used punctuation-stripped text, allowing a lookalike hostname such as `bombas.com.evil.example`; the matcher now compares complete hostnames and intentional subdomains. Diagnostic attribution previously dropped queries while evidence deduplication retained them; the collector now associates rows by the same normalized URL key and marks unavailable or ambiguous attribution without guessing. Optional provider diagnostics now pass runtime shape/field validation, URL sanitization, reason allowlisting, and size limits before summary storage. No post-fix live Bombas verification has run.

Unverified: migration deployment state (including the access-restriction migration), any real accepted Bombas facts/signals, whether trusted research domains are configured in a deployed environment, rate limiting/abuse protection at hosting edge, backups/monitoring, security headers, and actual deployment configuration.

## 15. Current Project State

- The identity/diagnostics fixes and the 2026-10-17 access-control stabilization pass 221 tests across 22 files, ESLint, TypeScript, and the production build. A post-fix live Bombas request has not run. No re-score occurred.
- Growth-signal capability is part of the committed product baseline, including explicit extraction, validation, candidate persistence, accepted-only database-to-scorer adapter, and synthetic integration fixtures. No migrations were applied in this task.
- Git branch `master` contains product-baseline commit `c31966c4c24b28f64df509866b8d6d57a60cbbdd` (`Establish GrowthOS AI product baseline`) with parent `24e2798b675655319b56aba226131ab9cc7a474c` (`Initial commit from Create Next App`). The baseline commit tree is `60e76aec74c0c18f11070a8e914696ae0ad76493`.
- Environment has Node 24 and Next.js 16.3.7 installed; npm is absent from PATH. `.env.local` exists; this inventory inspected its key names only, not its values.
- The documented 2026-10-13 Bombas research run is recorded as completed against the configured database (run `b60194fd-8242-49f7-ae2b-c02262537e22`; see section 8). This historical record does not establish current database connectivity, migration application state, or deployment status; those remain unverified.
- Baseline inventory before final staging: 19 tracked files (9 modified), 101 untracked files, and no staged changes. The untracked set includes product source/tests/routes, 24 `.gitkeep` placeholders, six SQL migrations, `PROJECT_CONTEXT.md`, and `.env.example`. Ignored local/build material includes `.env.local`, `supabase/.temp/`, `node_modules/`, `.next/`, `next-env.d.ts`, and `tsconfig.tsbuildinfo`. No configured remote or alternate local GrowthOS checkout was found in the checked project locations. Unreachable Git tree objects contain possible product snapshots, including a 119-file tree (`4af8d654`) matching the earlier pre-stabilization checkout and a 118-file tree (`a2911027`) that differs from it in 15 research files plus this context. These objects have no commit metadata or verified authority and may be pruned; they are comparison clues, not a recovered history.
- Read-only snapshot comparison confirmed tree `a291102761f2249526563f000dd17f412c96408f` (118 files) contains the earlier product implementation: 103 files match the current checkout, 14 existing research files and this context differ, and it lacks only `src/lib/research/source-quality.test.ts`. Tree `4af8d6540b9b1b1dd4cec7440ef68f9eb0747308` (119 files) has the same nonignored file list as the checkout at comparison time and matched 118 file contents; only this context had changed since. The two trees differ in exactly the 15 research files involved in the identity/diagnostics fix plus this context. All other source, tests, migrations, and configuration match between those trees. Their provenance and order cannot be proved from Git commits; they must not be treated as authoritative history. A separate private local backup of the working tree and `.git` was created after the final diff review; 641 copied files were hash-checked with no missing/mismatched files. It includes `.env.local` and excludes dependency/build output. That backup predates later documentation changes.
- The pre-stabilization private backup was verified before edits and remains preserved. A separate post-stabilization private backup contains 661 working-tree/Git files with zero SHA-256 mismatches and a 96-path baseline manifest; `.env.local` is stored separately under protected access controls and is absent from the product manifest. Private backup paths are intentionally not recorded here.
- The baseline commit contains exactly the 96 approved manifest paths: 86 additions/modifications relative to the scaffold commit plus 10 unchanged tracked scaffold files. Its tree matches the pre-commit reviewed index exactly, with no missing, extra, secret, generated, dependency, cache, or local Supabase paths. The remaining 24 untracked paths are empty `.gitkeep` placeholders intentionally excluded from the baseline.
- Publication is blocked pending an explicit history-privacy decision: a full reachable-history scan found that the original scaffold commit stores a non-noreply author and committer email. The two GrowthOS commits use the intended repository-local GitHub noreply identity. No remote was added or queried and no push occurred.

## 16. Pending Tasks and Roadmap

Prioritized from confirmed gaps; not a committed roadmap:

1. **Apply and verify the final access migration before real customer use.** Local source/tests now guard every product-data route and revoke browser-role database access, but no real Supabase project was changed. Acceptance: the sixth migration is applied in a controlled environment and anon/authenticated direct queries are denied while authorized server routes work.
2. **Move research execution to a durable worker.** Keep trigger API authorization but enqueue to a separately scheduled/managed worker. Acceptance: request returns without waiting on external fetch/search, retry/failure behavior is durable and tested.
3. **Decide whether prospect operations need CRUD beyond create/import.** UI presently lacks update/delete routes.
4. **Verify deployment operations only when environment access and authorization are available:** apply migrations, secrets, hosting, error monitoring, backups, and rate limits. None are verified by this checkout.
5. **Verify the post-fix identity and diagnostics behavior in one live Bombas run.** This request was authorized, but local browser control denied `http://localhost:3000/prospects`; run only when the local prospects page is available in a supported browser surface. Do not retry automatically, loosen validation, or re-score.
6. **Treat live Bombas growth as unverified.** The 2026-10-13 prior run produced no growth-signal rows and no score action. Do not promote historical migration claims or low-confidence evidence.
7. **Resolve original-commit metadata privacy before publication.** The scaffold commit contains a non-noreply author/committer email. Decide explicitly whether to publish that metadata or authorize a controlled history rewrite; then repeat the complete history scan before configuring or pushing a remote. Never rewrite or force-push automatically.

## 17. Change History

Dates below use migration filenames or the current task record. Git now preserves the scaffold, product-baseline, and follow-up documentation commits; most implementation chronology before the product baseline cannot be recovered from Git.

- **2026-09-30 (migration filename chronology):** initial prospect/contact schema, atomic create RPC, and portfolio-stage anon policies (`20260930000000_prospect_database.sql`); structured revenue and score projection (`20260930122443_icp_phase_a.sql`); score history and atomic score persistence (`20260930180000_icp_phase_b.sql`). Whether applied is unknown.
- **2026-10-01 (migration filename chronology):** evidence, research runs, facts, growth signals, status/provenance constraints, and private research-table access (`20261001120000_prospect_intelligence_schema.sql`).
- **2026-10-09 (migration filename chronology):** unique company/source URL index added to prevent duplicate evidence insert races (`20261009163149_company_evidence_canonical_url_unique.sql`).
- **2026-10-13:** inspected the existing growth-signal extraction → validation → persistence → scoring path and ran 181 tests, lint, TypeScript, and production build successfully. Exact authorship/date of the underlying uncommitted pipeline implementation is unavailable from Git.
- **2026-10-13:** with the user's authorization, ran exactly one live Bombas research request (`b60194fd-8242-49f7-ae2b-c02262537e22`). Tavily completed (18 returned, 6 reused, 4 persisted; no provider error); official-site fetch failed `website_http_error`. Four new evidence rows were candidate (confidence 0.7), six results were reused without persisted row-level run links, and no growth signals were written. Unrelated Bombas Klassen/Rodase pages produced six conflicted facts; canonical fields and the existing 40%-coverage score projection remained unchanged. No re-score or code change was performed. This revealed a permissive brand-token identity match; see Known Bugs and Risks.
- **2026-10-13:** added this project context and the mandatory documentation protocol to `AGENTS.md`; documentation-only change, with no application behavior changed. A local Node check confirmed all 18 required sections, all 85 referenced repository paths, and no trailing whitespace; `git diff --check -- AGENTS.md` reported no whitespace errors (only the repository's CRLF conversion warning).
- **2026-10-13:** reviewed the Git baseline and corrected this context: the tracked history is one Create Next App bootstrap commit, with the product implementation and reviewed research files untracked in the working tree and root configuration/application changes also present. Updated the identity issue to reflect the code-level fix while keeping post-fix live behavior unverified, and clarified that the prior documented database run does not prove current connectivity or deployment state.
- **2026-10-13:** fixed permissive one-token Bombas identity matching and applied shared identity validation to search-result, fact, and growth-signal paths. Added bounded, sanitized per-result research diagnostics with persisted/reused/filtered/rejected dispositions and reused evidence/original-run IDs, preserving URL deduplication and evidence rows. Files changed: `src/lib/research/source-quality.ts`, its test, `src/lib/research/search-provider.ts`, `src/lib/research/tavily-provider.ts` and tests, `src/lib/research/search-research.ts` and tests, `src/lib/research/worker.ts`, `src/lib/research/worker-validation.integration.test.ts`, `src/lib/research/website-facts.ts` and tests, `src/lib/research/fact-validation.ts` and tests, `src/lib/research/growth-signals.ts`, and `src/lib/research/growth-signal-validation.ts`. Regression coverage includes Bombas Klassen/Rodase rejection, genuine profile/case-study matches, reuse provenance/confidence, sanitized URLs, and completed worker-summary integration. No schema, scoring-threshold, canonical-company-field, or production-configuration changes. Verification: 21 test files / 193 tests passed; lint, TypeScript, and production build passed. The authorized follow-up live request could not start because browser-control security policy rejected the local prospects URL; no provider request or re-score was made.
- **2026-10-13:** inventoried the checkout for a safe Git baseline. Found 19 tracked files, 8 tracked modifications, 100 untracked files, no staged changes, no remote, and only the scaffold commit/reflog. Inspected filenames, ignore rules, manifest, environment key names (no values), local project locations, and unreachable Git tree inventories. Found potential uncommitted product snapshots but no authoritative product commit. Classified `supabase/.temp/cli-latest` as local CLI data and identified 24 untracked placeholders for review. No application code/configuration or Git state changed; no tests or live research were run.
- **2026-10-13:** compared unreachable Git trees `a291102761f2249526563f000dd17f412c96408f` and `4af8d6540b9b1b1dd4cec7440ef68f9eb0747308` with read-only Git and file-hash operations. The earlier tree preserves pre-fix research code; the later tree matches all current nonignored files except the subsequently edited context document. This provides a useful comparison for reviewing the 15 research files, but no recoverable commit history or verified provenance. No separate backup was found in checked local locations. Only this context was updated; no application tests, live research, staging, or commit were performed.
- **2026-10-13:** completed a read-only review of the 15 research-file delta and found three source-level issues in identity and diagnostic attribution/sanitization (see Known Bugs and Risks); verdict: needs fixes before baseline. Scoring, schema, migration, and production-configuration paths did not differ between the trees. Created a separate local backup of the working tree including `.git` and `.env.local`, excluding dependency/build output; 641 files passed SHA-256 comparison. This context was then updated with the review result and backup location. No application code/tests, Git index/configuration, live research, or score changed; no tests were run in this review.
- **2026-10-13:** fixed the three review defects in `src/lib/research/source-quality.ts` and `src/lib/research/search-research.ts`; added regression cases in their test files and `src/lib/research/fact-validation.test.ts`. Canonical-domain evidence now requires a complete matching hostname or intentional subdomain. Search diagnostics use the same query-preserving, fragment-free URL key as evidence deduplication; duplicates link to the actual stored row, and uncertain attribution is labeled rather than guessed. Provider diagnostic entries are validated at runtime, bounded, allowlisted, and stripped of query/fragment and provider-supplied database IDs; suspicious credential-bearing paths are excluded. A genuine trusted Bombas profile fact reaches accepted status in fixture validation, while namesakes and deceptive domains are rejected. No scoring, canonical fields, schema, migrations, or production configuration changed. Checks: focused 58 tests passed, then full 21 files / 206 tests passed; ESLint, TypeScript, and Next.js production build passed using installed Node entrypoints because npm is unavailable. A refreshed private local backup was hash-verified and includes `.git` and private `.env.local` while excluding dependencies/build output. No live research or re-score occurred. Fixture checks do not establish post-fix provider or database behavior.
- **2026-10-13:** resolved the baseline file-review content blockers without changing the 94-path candidate list. Updated `README.md` to document the five ordered migrations, distinguish local npm commands from manual Supabase project/Auth setup, and describe the implemented email OTP allowlist flow and environment prerequisites. Corrected `.env.example` claims and removed user-specific backup paths from this context. Replaced the personal-looking auth test email with reserved `example.com` fixtures. Added `/supabase/.temp/` to `.gitignore` while leaving migrations visible to Git. No application logic, scoring rules, research logic, schema, migration, or production configuration changed. Verification: 21 test files / 206 tests passed; ESLint, TypeScript, production build, and `git diff --check` passed through installed Node tools because npm is unavailable. No live research, re-score, staging, or commit occurred.
- **2026-10-17:** stabilization review closed the internal-data access gaps identified earlier. Prospect list/create/import, current score, score history, re-score, and research mutations now require internal authorization; mutations also require exact same-origin requests. Product-data routes use the server-only service-role client, return generic database failure messages, and log only bounded error codes rather than raw database error objects. Added the sixth additive migration to remove browser-role table/function access while preserving service-role access, plus route/access regression tests. `requireInternalUser()` now fails closed with a safe 503 result when authentication setup is unavailable. Root `/` redirects to `/prospects`, and the prospects page redirects expired sessions to `/login`. No scoring weights/thresholds, research trust/identity/freshness rules, canonical company fields, or provider configuration changed. No live research, re-score, or real database migration was run. Verification passed: 22 files / 221 tests, ESLint, TypeScript, production build, and whitespace checks. A refreshed private backup of 661 files and the revised 96-path manifest passed SHA-256 verification before staging. The index was then verified to contain exactly those 96 paths (86 staged changes plus 10 unchanged tracked files), with no secret-pattern findings or unintended indexed files; no commit was created.
- **2026-10-18:** corrected the current setup instructions to require all six migrations and state that `20261017000000_restrict_internal_data_access.sql` depends on the earlier prospect/scoring objects and runs last. `README.md`, the database reference, and the six-file migration inventory already agreed; the historical 2026-10-13 five-migration entry remains unchanged because it describes the state before the security migration was added. Only `PROJECT_CONTEXT.md` changed and was restaged. Both staged and unstaged whitespace checks passed, and the Git index still matched the approved 96-path manifest with zero missing or extra paths. Application tests were not rerun because this was documentation-only. No migration was applied or live-verified.
- **2026-10-18:** created product-baseline commit `c31966c4c24b28f64df509866b8d6d57a60cbbdd` (`Establish GrowthOS AI product baseline`) with parent `24e2798b675655319b56aba226131ab9cc7a474c`. Its tree `60e76aec74c0c18f11070a8e914696ae0ad76493` exactly matches the reviewed pre-commit index and all 96 approved manifest paths. A refreshed private backup was created first: 707 project/Git files plus the unchanged manifest and separately protected `.env.local` passed SHA-256 verification with zero mismatches. The repository-local Git author identity was configured without changing global settings. No application tests were rerun; no remote was configured or pushed, and no live research, re-score, migration application, or database connection occurred. This context update is committed separately so the reviewed baseline remains unchanged.
- **2026-10-18:** performed a public-history security review across all three reachable commits before configuring GitHub. No prohibited paths, private/local backup paths, private-key markers, JWT-like values, service-role assignments, or known GitHub/OpenAI/AWS token patterns were found. The credential-shaped provider fixture and non-reserved email-shaped strings were confirmed as deliberate sanitization tests or generic UI placeholders. The original scaffold commit stores a non-noreply author and committer email, so publication stopped before remote configuration or network access. Gitleaks was unavailable; the review used bounded pattern scans of every committed path/blob and metadata inspection. No history was rewritten, no files were pushed, and application tests were not rerun.

## 18. Verification References

- Baseline history: `24e2798b675655319b56aba226131ab9cc7a474c` (`Initial commit from Create Next App`) followed by `c31966c4c24b28f64df509866b8d6d57a60cbbdd` (`Establish GrowthOS AI product baseline`).
- Migration sequence: `supabase/migrations/20260930000000_prospect_database.sql`; `20260930122443_icp_phase_a.sql`; `20260930180000_icp_phase_b.sql`; `20261001120000_prospect_intelligence_schema.sql`; `20261009163149_company_evidence_canonical_url_unique.sql`; `20261017000000_restrict_internal_data_access.sql`.
- Main score entry points: `src/config/icp/ecom-d2c-v1.0.0.ts`, `src/lib/icp/scorer.ts`, `src/lib/icp/research-adapter.ts`, `app/api/prospects/[id]/score/route.ts`, `src/lib/icp/persistence.ts`.
- Main research entry points: `app/api/prospects/[id]/research/route.ts`, `src/lib/research/worker.ts`, `src/lib/research/official-website.ts`, `src/lib/research/search-research.ts`, `src/lib/research/tavily-provider.ts`, `src/lib/research/website-facts.ts`, `src/lib/research/fact-validation.ts`, `src/lib/research/growth-signals.ts`, `src/lib/research/growth-signal-validation.ts`.
- Key regression references: `app/api/prospects/access.test.ts` (route authorization, mutation origin checks, admin-client isolation, generic errors, and access-migration grants); `src/lib/research/website-facts.test.ts` (Shopify transition claim/headcount/revenue); `src/lib/research/fact-validation.test.ts` (historical migration-only platform claim and Bombas-style employee fixture); `src/lib/research/worker-validation.integration.test.ts` (reused historical evidence); `src/lib/research/growth-signals.test.ts`; `src/lib/research/growth-signal-worker.integration.test.ts`; `src/lib/research/growth-signal-scoring.integration.test.ts`.
- Latest verification: `node node_modules/vitest/vitest.mjs run` — 22 files passed, 221 tests passed (2026-10-17); `node node_modules/eslint/bin/eslint.js` — pass; `node node_modules/typescript/bin/tsc --noEmit` — pass; `node node_modules/next/dist/bin/next build` — pass on Next.js 16.3.7; `git diff --check` — pass. These installed Node entrypoints were used because npm is unavailable on PATH.
- Documentation correction verification (2026-10-18): `git diff --cached --check` and `git diff --check` passed; the index matched all 96 approved manifest paths with no missing or extra paths. No application test, migration application, database connection, live research, or re-score was performed.
- Baseline commit verification (2026-10-18): commit `c31966c4c24b28f64df509866b8d6d57a60cbbdd` has parent `24e2798b675655319b56aba226131ab9cc7a474c`, tree `60e76aec74c0c18f11070a8e914696ae0ad76493`, and exactly the 96 approved paths. No prohibited local or generated path entered the commit.
- Publication security review (2026-10-18): all reachable commit trees and metadata were scanned. Source/path checks passed, but scaffold commit `24e2798b675655319b56aba226131ab9cc7a474c` contains a non-noreply author/committer email. Remote configuration and push remain blocked pending explicit user direction; the email value is intentionally omitted from this document.
- Live run `b60194fd-8242-49f7-ae2b-c02262537e22` is verified in the configured database, status completed; details and limits are documented in section 8. Migration application records and deployed environment identifiers remain unverified.
