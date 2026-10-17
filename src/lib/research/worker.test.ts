import { beforeEach, describe, expect, it, vi } from "vitest";

const { mockCreateSupabaseAdminClient, mockCollectOfficialWebsiteEvidence, mockCollectSearchEvidence, mockValidateCandidateCompanyFactForRun } = vi.hoisted(() => ({
  mockCreateSupabaseAdminClient: vi.fn(),
  mockCollectOfficialWebsiteEvidence: vi.fn(),
  mockCollectSearchEvidence: vi.fn(),
  mockValidateCandidateCompanyFactForRun: vi.fn(),
}));

vi.mock("server-only", () => ({}));
vi.mock("@/lib/supabase/admin", () => ({ createSupabaseAdminClient: mockCreateSupabaseAdminClient }));
vi.mock("@/lib/research/official-website", () => ({
  collectOfficialWebsiteEvidence: mockCollectOfficialWebsiteEvidence,
  OfficialWebsiteResearchError: class OfficialWebsiteResearchError extends Error {
    constructor(readonly code: string) { super(code); }
  },
}));
vi.mock("@/lib/research/search-research", () => ({ collectSearchEvidence: mockCollectSearchEvidence }));
vi.mock("@/lib/research/fact-validation", () => ({
  validateCandidateCompanyFactForRunWithReusedEvidence: mockValidateCandidateCompanyFactForRun,
}));

import { processResearchRun } from "./worker";
import { OfficialWebsiteResearchError } from "./official-website";

const runId = "b3054407-5e28-49b6-aceb-0284df07c8ff";
const companyId = "af2b7bb2-21cc-46f2-97c3-b83bfdc990a2";
const otherCompanyId = "ccddeeff-21cc-46f2-97c3-b83bfdc990a2";
const factId = "ecddedef-21cc-46f2-97c3-b83bfdc990a2";

const company = {
  id: companyId,
  name: "GrowthOS AI Local Connection Test",
  website: "https://growthos-ai-local-test.invalid",
  domain: "growthos-ai-local-test.invalid",
  industry: "Internal QA",
  country: null,
  estimated_revenue: null,
  employee_count: null,
  platform: null,
  linkedin_url: null,
  description: null,
};

interface QueryResult {
  data: unknown;
  error: unknown | null;
}

interface QueryPlan {
  table: string;
  result: QueryResult;
}

function setup(plans: QueryPlan[]) {
  const updates: Array<{ table: string; values: unknown }> = [];
  const filters: Array<{ table: string; column: string; value: unknown }> = [];
  const supabase = {
    from: vi.fn((table: string) => {
      const planIndex = plans.findIndex((plan) => plan.table === table);
      if (planIndex < 0) throw new Error(`No query plan for ${table}`);
      const [plan] = plans.splice(planIndex, 1);
      const builder = {
        select: vi.fn(() => builder),
        update: vi.fn((values: unknown) => {
          updates.push({ table, values });
          return builder;
        }),
        insert: vi.fn((values: unknown) => {
          updates.push({ table, values });
          return builder;
        }),
        upsert: vi.fn((values: unknown) => {
          updates.push({ table, values });
          return builder;
        }),
        eq: vi.fn((column: string, value: unknown) => {
          filters.push({ table, column, value });
          return builder;
        }),
        in: vi.fn((column: string, value: unknown[]) => {
          filters.push({ table, column, value });
          return builder;
        }),
        maybeSingle: vi.fn(async () => plan.result),
        single: vi.fn(async () => plan.result),
        then: (resolve: (value: QueryResult) => unknown, reject?: (reason: unknown) => unknown) =>
          Promise.resolve(plan.result).then(resolve, reject),
      };
      return builder;
    }),
  };
  mockCreateSupabaseAdminClient.mockReturnValue(supabase);
  return { supabase, updates, filters };
}

const queuedRun = { id: runId, company_id: companyId, status: "queued", summary: null };
const claimedRun = { id: runId, company_id: companyId, status: "running" };
const evidence = {
  id: "ccddeeff-21cc-46f2-97c3-b83bfdc990a2",
  company_id: companyId,
  research_run_id: runId,
  source_type: "official_website" as const,
  source_name: "Official website" as const,
  source_url: "https://example.com/",
  observed_at: "2026-10-06T00:00:00.000Z",
  retrieved_at: "2026-10-06T00:00:00.000Z",
  excerpt: JSON.stringify({ readableTextExcerpt: "Industry: Internal QA" }),
  content_hash: "sha256",
  confidence: 0.7,
  status: "candidate" as const,
  created_at: "2026-10-06T10:00:00.000Z",
};
const successfulClaimAndCompany: QueryPlan[] = [
  { table: "company_research_runs", result: { data: queuedRun, error: null } },
  { table: "company_research_runs", result: { data: claimedRun, error: null } },
  { table: "companies", result: { data: company, error: null } },
  { table: "company_evidence", result: { data: [], error: null } },
  { table: "company_evidence", result: { data: [evidence], error: null } },
  { table: "company_facts", result: { data: [], error: null } },
  { table: "company_facts", result: { data: [{ id: factId, company_id: companyId, source_evidence_id: evidence.id }], error: null } },
  { table: "company_growth_signals", result: { data: [], error: null } },
  { table: "company_research_runs", result: { data: { id: runId }, error: null } },
];

describe("processResearchRun", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubEnv("TAVILY_API_KEY", "");
    mockCollectOfficialWebsiteEvidence.mockResolvedValue({ evidence: [evidence], metadata: {} });
    mockCollectSearchEvidence.mockReset();
    mockValidateCandidateCompanyFactForRun.mockImplementation(async (_companyId: string, id: string) => ({
      factId: id,
      status: "accepted",
    }));
  });

  it("transitions queued → running → completed and persists only a canonical snapshot", async () => {
    const { updates, filters } = setup([...successfulClaimAndCompany]);

    const result = await processResearchRun(runId);

    expect(result.status).toBe("completed");
    expect(result.alreadyCompleted).toBe(false);
    expect(result.result).toEqual({
      kind: "canonical_company_snapshot",
      version: "canonical-snapshot-v1",
      company,
    });
    const runUpdates = updates.filter(({ table }) => table === "company_research_runs");
    expect(runUpdates.map(({ values }) => (values as { status: string }).status)).toEqual(["running", "completed"]);
    const completedSummary = JSON.parse((runUpdates[1].values as { summary: string }).summary) as Record<string, unknown>;
    expect(completedSummary).toMatchObject({
      ...result.result,
      searchDiagnostics: {
        resultsReturned: 0,
        resultsFilteredIrrelevant: 0,
        resultsRejectedSafety: 0,
        resultsSkippedDuplicates: 0,
        resultsReused: 0,
        resultsPersisted: 0,
        providerFailureCode: null,
      },
      researchDiagnostics: {
        failedStage: null,
        officialWebsite: { status: "completed", errorCode: null },
      },
    });
    expect((runUpdates[0].values as { provider: string }).provider).toBe("noop");
    expect(filters).toContainEqual({ table: "companies", column: "id", value: companyId });
    expect(updates.some(({ table }) => table === "companies")).toBe(false);
    expect(updates).toContainEqual({ table: "company_evidence", values: [evidence] });
    expect(updates).toContainEqual({
      table: "company_facts",
      values: [{
        company_id: companyId,
        fact_key: "industry",
        value_jsonb: "Internal QA",
        status: "candidate",
        confidence: 0.7,
        source_evidence_id: evidence.id,
        observed_at: evidence.observed_at,
        valid_until: null,
      }],
    });
    expect(mockValidateCandidateCompanyFactForRun).toHaveBeenCalledWith(companyId, factId, runId, []);
  });

  it("persists each useful page as its own evidence and extracts facts from each", async () => {
    const teamEvidence = {
      ...evidence,
      id: "dd000000-21cc-46f2-97c3-b83bfdc990a2",
      source_url: "https://example.org/team",
      excerpt: JSON.stringify({ readableTextExcerpt: "Platform: Shopify Plus" }),
      content_hash: "sha256-team",
    };
    mockCollectOfficialWebsiteEvidence.mockResolvedValue({ evidence: [evidence, teamEvidence], metadata: {} });
    let companyFactsQueries = 0;
    let evidenceQueries = 0;
    const plans = successfulClaimAndCompany.map((plan) => {
      if (plan.table === "company_evidence") {
        evidenceQueries += 1;
        return { ...plan, result: { data: evidenceQueries === 1 ? [] : [evidence, teamEvidence], error: null } };
      }
      if (plan.table === "company_facts") {
        companyFactsQueries += 1;
        if (companyFactsQueries === 2) {
          return { ...plan, result: { data: [
            { id: factId, company_id: companyId, source_evidence_id: evidence.id },
            { id: "fcddedef-21cc-46f2-97c3-b83bfdc990a2", company_id: companyId, source_evidence_id: teamEvidence.id },
          ], error: null } };
        }
      }
      return { ...plan };
    });
    const { updates } = setup(plans);

    await processResearchRun(runId);

    expect(updates).toContainEqual({ table: "company_evidence", values: [evidence, teamEvidence] });
    const insertedFacts = updates.find(({ table }) => table === "company_facts")?.values as Array<{
      fact_key: string;
      source_evidence_id: string;
      value_jsonb: unknown;
    }>;
    expect(insertedFacts).toEqual(expect.arrayContaining([
      expect.objectContaining({ fact_key: "industry", value_jsonb: "Internal QA", source_evidence_id: evidence.id }),
      expect.objectContaining({ fact_key: "platform", value_jsonb: "Shopify Plus", source_evidence_id: teamEvidence.id }),
    ]));
    expect(mockValidateCandidateCompanyFactForRun).toHaveBeenNthCalledWith(1, companyId, factId, runId, []);
    expect(mockValidateCandidateCompanyFactForRun).toHaveBeenNthCalledWith(2, companyId, "fcddedef-21cc-46f2-97c3-b83bfdc990a2", runId, []);
  });

  it("persists safe Tavily failure diagnostics on the run without exposing error details", async () => {
    mockCollectOfficialWebsiteEvidence.mockResolvedValue({ evidence: [], metadata: {} });
    mockCollectSearchEvidence.mockResolvedValue({
      evidence: [],
      diagnostics: {
        resultsReturned: 0, resultsFilteredIrrelevant: 0, resultsRejectedSafety: 0,
        resultsSkippedDuplicates: 0, resultsReused: 0, resultsPersisted: 0, providerFailureCode: "tavily_rate_limited",
        providerFailureDiagnostic: {
          reason: "malformed_results", httpStatus: 200, contentType: "application/json",
          responseExcerpt: '{"topLevelKeys":["results"],"resultsType":"object"}',
        },
      },
      reusedEvidence: [],
    });
    const plans: QueryPlan[] = [
      { table: "company_research_runs", result: { data: queuedRun, error: null } },
      { table: "company_research_runs", result: { data: claimedRun, error: null } },
      { table: "companies", result: { data: company, error: null } },
      { table: "company_research_runs", result: { data: { id: runId }, error: null } },
    ];
    const { updates } = setup(plans);

    await processResearchRun(runId, {
      searchProvider: {
        name: "tavily",
        enabled: true,
        async search() { throw new Error("must use diagnostic search method"); },
        async searchWithDiagnostics() { throw Object.assign(new Error("secret API response"), { code: "tavily_rate_limited" }); },
      },
    });

    expect(mockCollectSearchEvidence).toHaveBeenCalledOnce();

    const runUpdates = updates.filter(({ table }) => table === "company_research_runs");
    expect((runUpdates[0].values as { provider: string }).provider).toBe("tavily");
    const summary = JSON.parse((runUpdates[1].values as { summary: string }).summary) as {
      searchDiagnostics: Record<string, unknown>;
    };
    expect(summary.searchDiagnostics).toMatchObject({
      resultsReturned: 0,
      resultsFilteredIrrelevant: 0,
      resultsRejectedSafety: 0,
      resultsSkippedDuplicates: 0,
      resultsReused: 0,
      resultsPersisted: 0,
      providerFailureCode: "tavily_rate_limited",
      providerFailureDiagnostic: {
        reason: "malformed_results",
        httpStatus: 200,
        contentType: "application/json",
        responseExcerpt: '{"topLevelKeys":["results"],"resultsType":"object"}',
      },
    });
    expect(JSON.stringify(runUpdates)).not.toContain("secret API response");
  });

  it("stores successful per-stage counts in the research-run summary", async () => {
    mockCollectOfficialWebsiteEvidence.mockResolvedValue({ evidence: [], metadata: {} });
    mockCollectSearchEvidence.mockResolvedValue({
      evidence: [],
      diagnostics: {
        resultsReturned: 6, resultsFilteredIrrelevant: 3, resultsRejectedSafety: 1,
        resultsSkippedDuplicates: 0, resultsReused: 0, resultsPersisted: 1, providerFailureCode: null,
      },
      reusedEvidence: [],
    });
    const plans: QueryPlan[] = [
      { table: "company_research_runs", result: { data: queuedRun, error: null } },
      { table: "company_research_runs", result: { data: claimedRun, error: null } },
      { table: "companies", result: { data: company, error: null } },
      { table: "company_research_runs", result: { data: { id: runId }, error: null } },
    ];
    const { updates } = setup(plans);

    await processResearchRun(runId, {
      searchProvider: {
        name: "tavily",
        enabled: true,
        async search() { return []; },
        async searchWithDiagnostics() {
          return {
            results: [{ title: "Profile", url: "https://example.com/profile", sourceDomain: "example.com", snippet: "Company profile." }],
            resultsReturned: 6,
            resultsFilteredIrrelevant: 3,
            resultsRejectedSafety: 1,
          };
        },
      },
    });

    const runUpdates = updates.filter(({ table }) => table === "company_research_runs");
    expect((runUpdates[0].values as { provider: string }).provider).toBe("tavily");
    const summary = JSON.parse((runUpdates[1].values as { summary: string }).summary) as {
      searchDiagnostics: Record<string, unknown>;
    };
    expect(summary.searchDiagnostics).toMatchObject({
      resultsReturned: 6,
      resultsFilteredIrrelevant: 3,
      resultsRejectedSafety: 1,
      resultsSkippedDuplicates: 0,
      resultsReused: 0,
      resultsPersisted: 1,
      providerFailureCode: null,
    });
  });

  it("continues to Tavily and completes when official website retrieval fails", async () => {
    mockCollectOfficialWebsiteEvidence.mockRejectedValue(new OfficialWebsiteResearchError("website_http_error"));
    mockCollectSearchEvidence.mockResolvedValue({
      evidence: [],
      diagnostics: {
        resultsReturned: 2, resultsFilteredIrrelevant: 1, resultsRejectedSafety: 0,
        resultsSkippedDuplicates: 0, resultsReused: 0, resultsPersisted: 0, providerFailureCode: null,
      },
      reusedEvidence: [],
    });
    const plans: QueryPlan[] = [
      { table: "company_research_runs", result: { data: queuedRun, error: null } },
      { table: "company_research_runs", result: { data: claimedRun, error: null } },
      { table: "companies", result: { data: company, error: null } },
      { table: "company_research_runs", result: { data: { id: runId }, error: null } },
    ];
    const { updates } = setup(plans);

    const result = await processResearchRun(runId, {
      searchProvider: {
        name: "tavily",
        enabled: true,
        async search() { return []; },
        async searchWithDiagnostics() { return { results: [], resultsReturned: 0, resultsFilteredIrrelevant: 0, resultsRejectedSafety: 0 }; },
      },
    });

    expect(result.status).toBe("completed");
    expect(mockCollectSearchEvidence).toHaveBeenCalledOnce();
    const runUpdates = updates.filter(({ table }) => table === "company_research_runs");
    expect(runUpdates.map(({ values }) => (values as { status: string }).status)).toEqual(["running", "completed"]);
    const summary = JSON.parse((runUpdates[1].values as { summary: string }).summary) as Record<string, unknown>;
    expect(summary).toMatchObject({
      searchDiagnostics: { resultsReturned: 2, resultsFilteredIrrelevant: 1, resultsPersisted: 0 },
      researchDiagnostics: {
        failedStage: null,
        officialWebsite: { status: "failed", errorCode: "website_http_error" },
      },
    });
  });

  it("records an unusable official response and still runs search", async () => {
    mockCollectOfficialWebsiteEvidence.mockResolvedValue({ evidence: [], metadata: {} });
    mockCollectSearchEvidence.mockResolvedValue({
      evidence: [],
      diagnostics: {
        resultsReturned: 0, resultsFilteredIrrelevant: 0, resultsRejectedSafety: 0,
        resultsSkippedDuplicates: 0, resultsReused: 0, resultsPersisted: 0, providerFailureCode: null,
      },
      reusedEvidence: [],
    });
    const plans: QueryPlan[] = [
      { table: "company_research_runs", result: { data: queuedRun, error: null } },
      { table: "company_research_runs", result: { data: claimedRun, error: null } },
      { table: "companies", result: { data: company, error: null } },
      { table: "company_research_runs", result: { data: { id: runId }, error: null } },
    ];
    const { updates } = setup(plans);

    await processResearchRun(runId, {
      searchProvider: {
        name: "tavily",
        enabled: true,
        async search() { return []; },
        async searchWithDiagnostics() { return { results: [], resultsReturned: 0, resultsFilteredIrrelevant: 0, resultsRejectedSafety: 0 }; },
      },
    });

    expect(mockCollectSearchEvidence).toHaveBeenCalledOnce();
    const completed = updates.filter(({ table }) => table === "company_research_runs")[1];
    expect(JSON.parse((completed.values as { summary: string }).summary)).toMatchObject({
      researchDiagnostics: {
        officialWebsite: { status: "unusable", errorCode: "website_unusable_content" },
      },
    });
  });

  it("reports a missing run without transitioning anything", async () => {
    const { updates } = setup([
      { table: "company_research_runs", result: { data: null, error: null } },
    ]);

    await expect(processResearchRun(runId)).rejects.toMatchObject({
      code: "research_run_not_found",
    });
    expect(updates).toHaveLength(0);
  });

  it("rejects a run that is not queued", async () => {
    const { updates } = setup([
      { table: "company_research_runs", result: { data: { ...queuedRun, status: "running" }, error: null } },
    ]);

    await expect(processResearchRun(runId)).rejects.toMatchObject({ code: "research_run_not_queued" });
    expect(updates).toHaveLength(0);
  });

  it("marks the claimed run failed with a safe error code when processing fails", async () => {
    const { updates } = setup([
      { table: "company_research_runs", result: { data: queuedRun, error: null } },
      { table: "company_research_runs", result: { data: claimedRun, error: null } },
      { table: "companies", result: { data: null, error: new Error("sensitive database detail") } },
      { table: "company_research_runs", result: { data: null, error: null } },
    ]);

    await expect(processResearchRun(runId)).rejects.toMatchObject({ code: "research_worker_failed" });
    expect((updates[1].values as { status: string; error_code: string }).status).toBe("failed");
    expect((updates[1].values as { error_code: string }).error_code).toBe("research_worker_failed");
    expect(JSON.stringify(updates)).not.toContain("sensitive database detail");
    expect((updates[1].values as { summary: string }).summary).toContain('"failedStage":"company_load"');
  });

  it("does not process a company record that differs from the run's company", async () => {
    const { updates, filters } = setup([
      { table: "company_research_runs", result: { data: queuedRun, error: null } },
      { table: "company_research_runs", result: { data: { ...claimedRun, company_id: otherCompanyId }, error: null } },
      { table: "companies", result: { data: { ...company, id: otherCompanyId }, error: null } },
      { table: "company_research_runs", result: { data: null, error: null } },
    ]);

    await expect(processResearchRun(runId)).rejects.toMatchObject({ code: "company_not_found" });
    expect(filters).toContainEqual({ table: "companies", column: "id", value: companyId });
    expect(updates.map(({ values }) => (values as { status: string }).status)).toEqual(["running", "failed"]);
  });

  it("returns the stored result without updates when the same completed run is processed again", async () => {
    const storedResult = {
      kind: "canonical_company_snapshot" as const,
      version: "canonical-snapshot-v1" as const,
      company,
    };
    const { updates } = setup([
      {
        table: "company_research_runs",
        result: { data: { ...queuedRun, status: "completed", summary: JSON.stringify(storedResult) }, error: null },
      },
    ]);

    const result = await processResearchRun(runId);

    expect(result).toEqual({ researchRunId: runId, status: "completed", result: storedResult, alreadyCompleted: true });
    expect(updates).toHaveLength(0);
  });
});
