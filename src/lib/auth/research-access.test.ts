import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const phaseOneMigration = readFileSync(
  resolve(process.cwd(), "supabase/migrations/20261001120000_prospect_intelligence_schema.sql"),
  "utf8",
);
const researchTables = [
  "company_research_runs",
  "company_evidence",
  "company_facts",
  "company_growth_signals",
] as const;

describe("research table browser access posture", () => {
  it.each(researchTables)("keeps %s behind RLS and revoked client grants", (table) => {
    expect(phaseOneMigration).toMatch(new RegExp(`alter table public\\.${table} enable row level security`, "i"));
    expect(phaseOneMigration).toMatch(new RegExp(`revoke all on public\\.${table} from public, anon, authenticated`, "i"));
    expect(phaseOneMigration).not.toMatch(new RegExp(`create policy[^;]*on public\\.${table}`, "i"));
    expect(phaseOneMigration).not.toMatch(new RegExp(`grant[^;]*on public\\.${table}[^;]*to (public|anon|authenticated)`, "i"));
  });

  it("does not expose privileged credentials through the browser client config", () => {
    const browserClient = readFileSync(resolve(process.cwd(), "src/lib/supabase/client.ts"), "utf8");
    expect(browserClient).toContain("NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY");
    expect(browserClient).not.toMatch(/SERVICE_ROLE|SECRET_KEY/i);
  });
});
