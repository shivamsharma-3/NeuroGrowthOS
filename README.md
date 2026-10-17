# GrowthOS AI

GrowthOS AI is a prospect research and qualification workspace. The implemented product area is available at `/prospects` and includes prospect entry/import, company research, and deterministic ICP scoring.

## Prerequisites

- Node.js and npm. The repository uses `package-lock.json`, so install dependencies with `npm ci`.
- An existing Supabase project for database and authentication features.
- Access to that project's SQL Editor (or another deliberate PostgreSQL migration workflow) and project API settings.

The repository does not contain a Supabase CLI project configuration. Creating a Supabase project, applying SQL, and configuring Auth are manual project-level actions; `npm` commands only install, run, test, and build the local Next.js app.

## Database setup

In the Supabase SQL Editor, apply all six migrations in filename order:

1. `supabase/migrations/20260930000000_prospect_database.sql` — prospect, company, and contact foundation plus the prospect-creation function.
2. `supabase/migrations/20260930122443_icp_phase_a.sql` — structured revenue and current-score fields.
3. `supabase/migrations/20260930180000_icp_phase_b.sql` — score-run and factor history plus atomic score persistence.
4. `supabase/migrations/20261001120000_prospect_intelligence_schema.sql` — research runs, evidence, facts, and growth signals.
5. `supabase/migrations/20261009163149_company_evidence_canonical_url_unique.sql` — company/source URL uniqueness for evidence deduplication.
6. `supabase/migrations/20261017000000_restrict_internal_data_access.sql` — removes browser-role access to prospect and score data/functions and preserves service-role access for authorized server routes.

Each later migration depends on objects introduced earlier. Migration application has not been verified against a clean live project from this checkout.

The initial prospect and score migrations contain the prototype's broad anonymous grants. The sixth migration removes those grants and policies; apply it before exposing the app or storing private prospect data. All product data then flows through authorized server routes using the server-only service-role client. The repository still has no tenant model, so one allowlisted internal user can access the whole workspace.

## Environment configuration

Copy `.env.example` to `.env.local`, then replace placeholders with values from your Supabase project:

- `NEXT_PUBLIC_SUPABASE_URL` — project URL used by browser and server clients.
- `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY` — public/publishable client key.
- `SUPABASE_SERVICE_ROLE_KEY` — secret server-only key used for prospect, research, and scoring data access. Never expose it through a `NEXT_PUBLIC_` variable.
- `GROWTHOS_INTERNAL_EMAILS` — comma-separated email addresses allowed to use internal authentication and product data routes.
- `TAVILY_API_KEY` — optional; enables supplementary Tavily search. Official-site research remains available without it.
- `GROWTHOS_TRUSTED_RESEARCH_DOMAINS` — optional comma-separated trusted domains used by research source validation.

Keep `.env.local` private. It is ignored by Git; `.env.example` contains placeholders only.

## Internal authentication

The app implements Supabase email OTP authentication at `/login`. Login and verification requests first check `GROWTHOS_INTERNAL_EMAILS`; an empty allowlist disables internal sign-in. Successful OTP verification creates a cookie-backed Supabase session. Prospect list/create/import, research, current score, score history, and re-score routes verify both the authenticated Supabase user and the allowlist. Cookie-authenticated mutations also require an exact same-origin request.

Before using internal sign-in, configure email authentication and delivery for the Supabase project and ensure each intended user is listed in `GROWTHOS_INTERNAL_EMAILS`. The callback route at `/auth/callback` supports Supabase code exchange, while the login UI supports numeric email OTP verification. Exact hosted redirect/site URL settings depend on the environment and are not configured in this repository.

## Run locally

After the external Supabase setup and local environment configuration are complete:

```bash
npm ci
npm run dev
```

Open [http://localhost:3000](http://localhost:3000); the root route redirects to the prospects workspace. Unauthenticated visitors are sent to `/login` after the protected data request returns 401.

## Checks

```bash
npm test
npm run lint
npx tsc --noEmit
npm run build
```
