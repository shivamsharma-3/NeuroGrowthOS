import { beforeEach, describe, expect, it, vi } from "vitest";

const { mockCreateSupabaseAdminClient, mockCollectOfficialWebsiteEvidence } = vi.hoisted(() => ({
  mockCreateSupabaseAdminClient: vi.fn(),
  mockCollectOfficialWebsiteEvidence: vi.fn(),
}));

vi.mock("server-only", () => ({}));
vi.mock("@/lib/supabase/admin", () => ({ createSupabaseAdminClient: mockCreateSupabaseAdminClient }));
vi.mock("@/lib/research/official-website", () => ({
  collectOfficialWebsiteEvidence: mockCollectOfficialWebsiteEvidence,
  OfficialWebsiteResearchError: class OfficialWebsiteResearchError extends Error {
    constructor(readonly code: string) { super(code); }
  },
}));

import { adaptAcceptedResearchFacts, attachIcpResearchProvenance } from "@/lib/icp/research-adapter";
import { scoreIcp } from "@/lib/icp/scorer";
import { validateCandidateCompanyFact, type FactValidationRepository } from "@/lib/research/fact-validation";
import { processResearchRun } from "@/lib/research/worker";
import type { IcpCompanyInput } from "@/types/icp";

const qaProspectId = "99a276e3-a216-4ae2-ab96-d98f57ee4c1b";
const companyId = "af2b7bb2-21cc-46f2-97c3-b83bfdc990a2";
const researchRunId = "b3054407-5e28-49b6-aceb-0284df07c8ff";
const evidenceId = "ccddeeff-21cc-46f2-97c3-b83bfdc990a2";
const asOf = new Date("2026-10-06T12:00:00.000Z");
const observedAt = "2026-10-06T10:00:00.000Z";

const qaCompany = {
  id: companyId,
  name: "GrowthOS AI Local Connection Test",
  website: "https://growthos-ai-local-test.example",
  domain: "growthos-ai-local-test.example",
  industry: null,
  country: null,
  estimated_revenue: null,
  employee_count: null,
  platform: null,
  linkedin_url: null,
  description: null,
};
const qaProspect = { id: qaProspectId, company_id: companyId, company: qaCompany };

const pageText = [
  "Industry: D2C.",
  "Platform: Shopify Plus.",
  "Headquartered in United States.",
  "Company size: 50 employees.",
  "Annual revenue of USD 10 million.",
].join(" ");

function newState() {
  return {
    company_research_runs: [{ id: researchRunId, company_id: companyId, status: "queued", summary: null }],
    companies: [qaCompany],
    company_evidence: [] as Array<Record<string, unknown>>,
    company_facts: [] as Array<Record<string, unknown>>,
    company_growth_signals: [] as Array<Record<string, unknown>>,
  };
}

function createMemorySupabase(state: ReturnType<typeof newState>) {
  let nextId = 0;
  return {
    from(table: keyof typeof state) {
      let operation: "select" | "update" | "insert" = "select";
      let payload: unknown;
      const filters: Array<[string, unknown]> = [];
      const inFilters = new Set<string>();
      const builder = {
        select: () => builder,
        update: (values: unknown) => { operation = "update"; payload = values; return builder; },
        insert: (values: unknown) => { operation = "insert"; payload = values; return builder; },
        upsert: (values: unknown) => { operation = "insert"; payload = values; return builder; },
        eq: (column: string, value: unknown) => { filters.push([column, value]); return builder; },
        in: (column: string, value: unknown[]) => { filters.push([column, value]); inFilters.add(column); return builder; },
        async maybeSingle() { return execute(true); },
        async single() { return execute(true); },
        then(resolve: (value: { data: unknown; error: null }) => unknown, reject?: (error: unknown) => unknown) {
          return Promise.resolve(execute(false)).then(resolve, reject);
        },
      };
      const matches = (row: Record<string, unknown>) => filters.every(([key, value]) =>
        inFilters.has(key) ? Array.isArray(value) && value.includes(row[key]) : row[key] === value,
      );
      function execute(single: boolean) {
        const tableRows = state[table] as Array<Record<string, unknown>>;
        if (operation === "insert") {
          const values = Array.isArray(payload) ? payload : [payload];
          const inserted = values.map((value) => {
            const row = {
              ...(value as Record<string, unknown>),
              id: (value as Record<string, unknown>).id ?? `00000000-0000-4000-8000-${String(++nextId).padStart(12, "0")}`,
              created_at: (value as Record<string, unknown>).created_at ?? observedAt,
            };
            tableRows.push(row);
            return row;
          });
          return { data: single ? inserted[0] ?? null : inserted, error: null };
        }
        const selected = tableRows.filter(matches);
        if (operation === "update") {
          selected.forEach((row) => Object.assign(row, payload));
          return { data: single ? selected[0] ?? null : selected, error: null };
        }
        return { data: single ? selected[0] ?? null : selected, error: null };
      }
      return builder;
    },
  };
}

function createMemoryValidationRepository(state: ReturnType<typeof newState>): FactValidationRepository {
  return {
    async getCompanyIdentity(company) {
      const row = state.companies.find((item) => item.id === company);
      return row ? { name: row.name, domain: row.domain, website: row.website } : null;
    },
    async listCompanyFacts(company) {
      return state.company_facts.filter((row) => row.company_id === company);
    },
    async listCompanyEvidence(company, ids) {
      return state.company_evidence.filter((row) => row.company_id === company && ids.includes(String(row.id)));
    },
    async updateFact(company, id, expectedStatus, patch) {
      const row = state.company_facts.find((item) => item.company_id === company && item.id === id && item.status === expectedStatus);
      if (!row) return false;
      Object.assign(row, patch);
      return true;
    },
  };
}

function baseScoringInput(): IcpCompanyInput {
  return {
    revenue: { amount: null, currency: null, period: null, source: null, observedAt: null, legacyEstimatedRevenue: null },
    industry: null,
    platform: null,
    country: null,
    employeeCount: null,
    growthSignals: null,
  };
}

function scoreFrom(state: ReturnType<typeof newState>) {
  const facts = state.company_facts.filter((fact) => fact.status === "accepted");
  const evidence = state.company_evidence;
  const adapted = adaptAcceptedResearchFacts(baseScoringInput(), facts, evidence, asOf, companyId);
  return attachIcpResearchProvenance(scoreIcp(adapted.input, asOf), adapted.provenance);
}

describe("research-to-scoring integration", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  vi.stubEnv("TAVILY_API_KEY", "");
  });

  it("completes the QA prospect research-to-score flow using deterministic fixtures only", async () => {
    expect(qaProspect).toMatchObject({ id: qaProspectId, company_id: companyId, company: { name: "GrowthOS AI Local Connection Test" } });
    const state = newState();
    const originalCanonicalCompany = { ...qaCompany };
    mockCreateSupabaseAdminClient.mockReturnValue(createMemorySupabase(state));
    mockCollectOfficialWebsiteEvidence.mockResolvedValue({
      metadata: { pageTitle: "GrowthOS AI Local Connection Test", metaDescription: null, canonicalUrl: null, readableTextExcerpt: pageText },
      evidence: [{
        id: evidenceId,
        company_id: companyId,
        research_run_id: researchRunId,
        source_type: "official_website",
        source_name: "Official website",
        source_url: "https://growthos-ai-local-test.example/",
        observed_at: observedAt,
        retrieved_at: observedAt,
        excerpt: JSON.stringify({ readableTextExcerpt: pageText }),
        content_hash: "official-site-fixture-hash",
        confidence: 0.7,
        status: "candidate",
      }],
    });

    const research = await processResearchRun(researchRunId);
    expect(research.status).toBe("completed");
    expect(state.company_research_runs[0].status).toBe("completed");
    expect(state.company_evidence).toHaveLength(1);
    expect(state.company_evidence[0]).toMatchObject({ id: evidenceId, research_run_id: researchRunId, company_id: companyId });
    expect(state.company_facts).toHaveLength(5);
    expect(state.company_facts.every((fact) => fact.status === "accepted")).toBe(true);
    expect(state.company_facts.every((fact) => fact.source_evidence_id === evidenceId)).toBe(true);

    const validationRepository = createMemoryValidationRepository(state);
    const factIds = state.company_facts.map((fact) => String(fact.id));
    for (const id of factIds) {
      expect(await validateCandidateCompanyFact(companyId, id, validationRepository, asOf)).toMatchObject({ status: "already_processed" });
    }
    expect(state.company_facts.every((fact) => fact.status === "accepted")).toBe(true);

    const firstScore = scoreFrom(state);
    expect(firstScore.factors.industry.score).toBe(20);
    expect(firstScore.factors.platform.score).toBe(15);
    expect(firstScore.factors.geography.score).toBe(10);
    expect(firstScore.factors.company_size.score).toBe(10);
    expect(firstScore.factors.revenue.score).toBe(25);
    expect(firstScore.coverage.percent).toBe(80);
    expect(firstScore.scoringStatus).toBe("scored");
    expect(firstScore.totalScore).toBe(100);
    for (const factor of ["industry", "platform", "geography", "company_size", "revenue"] as const) {
      const sourceFact = state.company_facts.find((row) => row.fact_key === factor);
      expect(firstScore.factors[factor].evidence).toMatchObject({
        sourceFactId: sourceFact?.id,
        sourceEvidenceId: evidenceId,
      });
      expect(firstScore.factors[factor].reason).toContain(evidenceId);
    }

    expect(qaCompany).toEqual(originalCanonicalCompany);

    // Non-accepted and stale/conflicted records cannot override accepted scoring inputs.
    state.company_evidence.push(
      { ...state.company_evidence[0], id: "dd000000-21cc-46f2-97c3-b83bfdc990a2", status: "stale" },
      { ...state.company_evidence[0], id: "ee000000-21cc-46f2-97c3-b83bfdc990a2", status: "conflicted" },
    );
    state.company_facts.push(
      { ...state.company_facts.find((row) => row.fact_key === "platform"), id: "dd100000-21cc-46f2-97c3-b83bfdc990a2", value_jsonb: "BigCommerce", status: "candidate", source_evidence_id: "dd000000-21cc-46f2-97c3-b83bfdc990a2" },
      { ...state.company_facts.find((row) => row.fact_key === "industry"), id: "ee100000-21cc-46f2-97c3-b83bfdc990a2", value_jsonb: "Industrial manufacturing", status: "stale", source_evidence_id: "dd000000-21cc-46f2-97c3-b83bfdc990a2" },
      { ...state.company_facts.find((row) => row.fact_key === "geography"), id: "ee200000-21cc-46f2-97c3-b83bfdc990a2", value_jsonb: "India", status: "conflicted", source_evidence_id: "ee000000-21cc-46f2-97c3-b83bfdc990a2" },
    );
    expect(scoreFrom(state)).toEqual(firstScore);

    const repeatedResearch = await processResearchRun(researchRunId);
    expect(repeatedResearch.alreadyCompleted).toBe(true);
    expect(mockCollectOfficialWebsiteEvidence).toHaveBeenCalledTimes(1);
    for (const id of factIds) {
      expect(await validateCandidateCompanyFact(companyId, id, validationRepository, asOf)).toMatchObject({ status: "already_processed" });
    }
    expect(state.company_evidence).toHaveLength(3);
    expect(state.company_facts.filter((fact) => fact.status === "accepted")).toHaveLength(5);
    expect(scoreFrom(state)).toEqual(firstScore);

    const missingEvidenceScore = scoreIcp(baseScoringInput(), asOf);
    expect(missingEvidenceScore.totalScore).toBeNull();
    expect(missingEvidenceScore.priority).toBe("insufficient_data");
    expect(missingEvidenceScore.scoringStatus).toBe("insufficient_data");
  });
});
