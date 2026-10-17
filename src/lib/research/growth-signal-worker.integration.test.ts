import { beforeEach, describe, expect, it, vi } from "vitest";

const { createAdmin, collectOfficial } = vi.hoisted(() => ({ createAdmin: vi.fn(), collectOfficial: vi.fn() }));
vi.mock("server-only", () => ({}));
vi.mock("@/lib/supabase/admin", () => ({ createSupabaseAdminClient: createAdmin }));
vi.mock("@/lib/research/official-website", () => ({ collectOfficialWebsiteEvidence: collectOfficial }));

import { adaptAcceptedGrowthSignals, attachIcpGrowthSignalProvenance } from "@/lib/icp/research-adapter";
import { scoreIcp } from "@/lib/icp/scorer";
import { processResearchRun } from "@/lib/research/worker";
import type { IcpCompanyInput } from "@/types/icp";

const companyId = "4fda1d3f-569d-491d-99ec-f42803b42b3d";
const runId = "aa054407-5e28-49b6-aceb-0284df07c8ff";
const evidenceId = "da054407-5e28-49b6-aceb-0284df07c8ff";
const company = {
  id: companyId, name: "Bombas", website: "https://bombas.com", domain: "bombas.com", industry: null, country: null,
  estimated_revenue: null, employee_count: null, platform: null, linkedin_url: null, description: null,
};
const evidence = {
  id: evidenceId, company_id: companyId, research_run_id: runId, source_type: "official_website",
  source_name: "Official website", source_url: "https://bombas.com/news", observed_at: "2026-10-10T07:00:00.000Z",
  retrieved_at: "2026-10-10T07:00:00.000Z",
  excerpt: JSON.stringify({ pageTitle: "Bombas News", readableTextExcerpt: "Bombas raised Series B funding on September 14, 2026." }),
  content_hash: "growth-signal-fixture", confidence: 0.8, status: "candidate", created_at: "2026-10-10T07:00:00.000Z",
};

function memoryDb() {
  const state = {
    company_research_runs: [{ id: runId, company_id: companyId, status: "queued", summary: null }],
    companies: [company], company_evidence: [] as Array<Record<string, unknown>>,
    company_facts: [] as Array<Record<string, unknown>>, company_growth_signals: [] as Array<Record<string, unknown>>,
  };
  let idCount = 0;
  return {
    state,
    client: {
      from(table: keyof typeof state) {
        let operation: "select" | "update" | "insert" = "select";
        let values: Array<Record<string, unknown>> = [];
        const filters: Array<{ key: string; value: unknown; many: boolean }> = [];
        const builder = {
          select() { return builder; },
          update(row: Record<string, unknown>) { operation = "update"; values = [row]; return builder; },
          insert(input: unknown) { operation = "insert"; values = Array.isArray(input) ? input as Array<Record<string, unknown>> : [input as Record<string, unknown>]; return builder; },
          upsert(input: unknown) { operation = "insert"; values = Array.isArray(input) ? input as Array<Record<string, unknown>> : [input as Record<string, unknown>]; return builder; },
          eq(key: string, value: unknown) { filters.push({ key, value, many: false }); return builder; },
          in(key: string, value: unknown[]) { filters.push({ key, value, many: true }); return builder; },
          execute(single: boolean) {
            const rows = state[table] as Array<Record<string, unknown>>;
            if (operation === "insert") {
              const inserted = values.map((value) => ({ ...value,
                id: value.id ?? `00000000-0000-4000-8000-${String(++idCount).padStart(12, "0")}`,
                created_at: value.created_at ?? "2026-10-10T10:00:00.000Z",
              }));
              rows.push(...inserted);
              return { data: single ? inserted[0] ?? null : inserted, error: null };
            }
            const selected = rows.filter((row) => filters.every(({ key, value, many }) => many
              ? Array.isArray(value) && value.includes(row[key]) : row[key] === value));
            if (operation === "update") selected.forEach((row) => Object.assign(row, values[0]));
            return { data: single ? selected[0] ?? null : selected, error: null };
          },
          maybeSingle() { return Promise.resolve(builder.execute(true)); },
          single() { return Promise.resolve(builder.execute(true)); },
          then(resolve: (value: { data: unknown; error: null }) => unknown, reject?: (error: unknown) => unknown) {
            return Promise.resolve(builder.execute(false)).then(resolve, reject);
          },
        };
        return builder;
      },
    },
  };
}

describe("research worker to persisted growth signal to scorer", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubEnv("TAVILY_API_KEY", "");
    collectOfficial.mockResolvedValue({ evidence: [evidence], metadata: {} });
  });

  it("persists and accepts a current-run, explicitly dated signal, then passes its provenance to scoring", async () => {
    const db = memoryDb();
    createAdmin.mockReturnValue(db.client);
    const run = await processResearchRun(runId);
    expect(run.status).toBe("completed");
    expect(db.state.company_growth_signals).toHaveLength(1);
    const [storedSignal] = db.state.company_growth_signals;
    expect(storedSignal).toMatchObject({ signal_type: "recent_funding", status: "accepted", evidence_id: evidenceId, observed_at: "2026-09-14T00:00:00.000Z" });

    const canonical: IcpCompanyInput = {
      revenue: { amount: null, currency: null, period: null, source: null, observedAt: null },
      industry: null, platform: null, country: null, employeeCount: null, growthSignals: null,
    };
    const adapted = adaptAcceptedGrowthSignals(canonical, db.state.company_growth_signals, db.state.company_evidence,
      "2026-10-10T10:00:00.000Z", new Date("2026-10-10T12:00:00.000Z"), companyId);
    const scored = attachIcpGrowthSignalProvenance(scoreIcp(adapted.input, new Date("2026-10-10T12:00:00.000Z")), adapted.provenance);
    expect(scored.factors.growth_signal.score).toBe(5);
    expect(scored.factors.growth_signal.evidence).toMatchObject({
      sourceSignalIds: storedSignal.id, sourceEvidenceIds: evidenceId,
    });
  });
});
