import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

type Row = Record<string, unknown>;
type QueryResult = { data: unknown; error: null };
type MemoryTable = "company_research_runs" | "companies" | "company_evidence" | "company_facts" | "company_growth_signals";
type Filter = { column: string; value: unknown; operator: "eq" | "in" };

interface MemoryState {
  company_research_runs: Row[];
  companies: Row[];
  company_evidence: Row[];
  company_facts: Row[];
  company_growth_signals: Row[];
}

const { mockCreateSupabaseAdminClient, mockCollectOfficialWebsiteEvidence, mockCollectSearchEvidence } = vi.hoisted(() => ({
  mockCreateSupabaseAdminClient: vi.fn(),
  mockCollectOfficialWebsiteEvidence: vi.fn(),
  mockCollectSearchEvidence: vi.fn(),
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

import { scoreIcp } from "@/lib/icp/scorer";
import { adaptAcceptedResearchFacts, attachIcpResearchProvenance } from "@/lib/icp/research-adapter";
import { processResearchRun } from "./worker";
import type { IcpCompanyInput } from "@/types/icp";

const researchRunId = "aa054407-5e28-49b6-aceb-0284df07c8ff";
const companyId = "af2b7bb2-21cc-46f2-97c3-b83bfdc990a2";
const trustedFactId = "ba054407-5e28-49b6-aceb-0284df07c8ff";
const untrustedFactId = "ca054407-5e28-49b6-aceb-0284df07c8ff";
const trustedEvidenceId = "da054407-5e28-49b6-aceb-0284df07c8ff";
const untrustedEvidenceId = "ea054407-5e28-49b6-aceb-0284df07c8ff";
const priorRunId = "fa054407-5e28-49b6-aceb-0284df07c8ff";
const reusedFactId = "ab054407-5e28-49b6-aceb-0284df07c8ff";
const conflictFactId = "bb054407-5e28-49b6-aceb-0284df07c8ff";
const conflictEvidenceId = "cb054407-5e28-49b6-aceb-0284df07c8ff";
const observedAt = "2026-10-09T12:00:00.000Z";
const company: Row = {
  id: companyId,
  name: "Bombas",
  website: "https://bombas.com",
  domain: "bombas.com",
  industry: null,
  country: null,
  estimated_revenue: null,
  employee_count: null,
  platform: null,
  linkedin_url: null,
  description: null,
};

function matchingRows(rows: Row[], filters: Filter[]): Row[] {
  return rows.filter((row) => filters.every(({ column, value, operator }) => operator === "eq"
    ? row[column] === value
    : Array.isArray(value) && value.includes(row[column])));
}

function createMemoryClient(state: MemoryState) {
  let factSequence = 0;
  return {
    from(table: MemoryTable) {
      let operation: "select" | "update" | "insert" = "select";
      let updateValues: Row = {};
      let insertValues: Row[] = [];
      const filters: Filter[] = [];
      const execute = (): QueryResult => {
        const rows = state[table];
        if (operation === "insert") {
          const inserted = insertValues.map((row) => {
            factSequence += 1;
            return {
              ...row,
              id: `${factSequence === 1 ? trustedFactId : untrustedFactId}`,
              created_at: observedAt,
            };
          });
          rows.push(...inserted);
          return { data: inserted, error: null };
        }
        const selected = matchingRows(rows, filters);
        if (operation === "update") {
          for (const row of selected) Object.assign(row, updateValues);
        }
        return { data: selected, error: null };
      };
      const builder = {
        select(columns: string) { void columns; return builder; },
        update(values: Row) { operation = "update"; updateValues = values; return builder; },
        insert(values: unknown) {
          operation = "insert";
          insertValues = Array.isArray(values) ? values as Row[] : [values as Row];
          return builder;
        },
        eq(column: string, value: unknown) { filters.push({ column, value, operator: "eq" }); return builder; },
        in(column: string, value: unknown[]) { filters.push({ column, value, operator: "in" }); return builder; },
        async maybeSingle(): Promise<QueryResult> {
          const result = execute();
          return { data: Array.isArray(result.data) ? result.data[0] ?? null : result.data, error: null };
        },
        async single(): Promise<QueryResult> {
          const result = execute();
          return { data: Array.isArray(result.data) ? result.data[0] ?? null : result.data, error: null };
        },
        then(resolve: (value: QueryResult) => unknown, reject?: (reason: unknown) => unknown) {
          return Promise.resolve(execute()).then(resolve, reject);
        },
      };
      return builder;
    },
  };
}

function searchEvidence(id: string, host: string, confidence: number, text: string): Row {
  return {
    id,
    company_id: companyId,
    research_run_id: researchRunId,
    source_type: "search_result",
    source_name: host,
    source_url: `https://www.${host}/company/bombas`,
    observed_at: observedAt,
    retrieved_at: observedAt,
    excerpt: JSON.stringify({ pageTitle: "Bombas company profile", readableTextExcerpt: text }),
    content_hash: id.replaceAll("-", "").padEnd(64, "0"),
    confidence,
    status: "candidate",
    created_at: observedAt,
  };
}

function canonicalInput(): IcpCompanyInput {
  return {
    revenue: { amount: null, currency: null, period: null, source: null, observedAt: null, legacyEstimatedRevenue: null },
    industry: null,
    platform: null,
    country: null,
    employeeCount: null,
    growthSignals: null,
  };
}

describe("research worker candidate validation integration", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubEnv("GROWTHOS_TRUSTED_RESEARCH_DOMAINS", "linkedin.com");
    mockCollectOfficialWebsiteEvidence.mockResolvedValue({ evidence: [], metadata: {} });
  });

  afterEach(() => vi.unstubAllEnvs());

  it("extracts facts, accepts trusted current-run evidence, rejects untrusted evidence, then exposes only accepted provenance to scoring", async () => {
    const trustedEvidence = searchEvidence(
      trustedEvidenceId,
      "linkedin.com",
      0.7,
      "Bombas platform: Shopify Plus.",
    );
    const untrustedEvidence = searchEvidence(
      untrustedEvidenceId,
      "outsider.example",
      0.35,
      "Bombas. Industry: Apparel.",
    );
    const state: MemoryState = {
      company_research_runs: [{ id: researchRunId, company_id: companyId, status: "queued", summary: null }],
      companies: [company],
      company_evidence: [trustedEvidence, untrustedEvidence],
      company_facts: [],
      company_growth_signals: [],
    };
    mockCreateSupabaseAdminClient.mockReturnValue(createMemoryClient(state));
    mockCollectSearchEvidence.mockResolvedValue({
      evidence: [trustedEvidence, untrustedEvidence],
      reusedEvidence: [],
      diagnostics: {
        resultsReturned: 2,
        resultsFilteredIrrelevant: 0,
        resultsRejectedSafety: 0,
        resultsSkippedDuplicates: 0,
        resultsReused: 0,
        resultsPersisted: 2,
        providerFailureCode: null,
      },
    });

    await expect(processResearchRun(researchRunId, {
      searchProvider: { name: "tavily", enabled: true, async search() { return []; } },
    })).resolves.toMatchObject({ status: "completed" });

    expect(state.company_facts).toEqual(expect.arrayContaining([
      expect.objectContaining({
        id: trustedFactId,
        fact_key: "platform",
        value_jsonb: "Shopify Plus",
        status: "accepted",
        source_evidence_id: trustedEvidenceId,
      }),
      expect.objectContaining({
        id: untrustedFactId,
        fact_key: "industry",
        value_jsonb: "Apparel",
        status: "rejected",
        source_evidence_id: untrustedEvidenceId,
      }),
    ]));

    const adapted = adaptAcceptedResearchFacts(
      canonicalInput(),
      state.company_facts,
      state.company_evidence,
      new Date("2026-10-09T13:00:00.000Z"),
      companyId,
    );
    const score = attachIcpResearchProvenance(
      scoreIcp(adapted.input, new Date("2026-10-09T13:00:00.000Z")),
      adapted.provenance,
    );
    expect(adapted.input.platform).toBe("Shopify Plus");
    expect(adapted.input.industry).toBeNull();
    expect(score.factors.platform.score).toBeGreaterThan(0);
    expect(score.factors.platform.evidence).toMatchObject({
      sourceFactId: trustedFactId,
      sourceEvidenceId: trustedEvidenceId,
    });
    expect(score.factors.platform.reason).toContain(trustedFactId);
  });

  it("reuses trusted prior-run evidence unchanged, validates its existing candidate, and passes provenance to scoring", async () => {
    const priorEvidence = {
      ...searchEvidence(trustedEvidenceId, "linkedin.com", 0.7, "Bombas platform: Shopify Plus."),
      research_run_id: priorRunId,
    };
    const priorCandidate = {
      id: reusedFactId, company_id: companyId, fact_key: "platform", value_jsonb: "Shopify Plus",
      status: "candidate", confidence: 0.7, source_evidence_id: trustedEvidenceId,
      observed_at: observedAt, valid_until: null, created_at: observedAt,
    };
    const state: MemoryState = {
      company_research_runs: [{ id: researchRunId, company_id: companyId, status: "queued", summary: null }],
      companies: [company], company_evidence: [priorEvidence], company_facts: [priorCandidate], company_growth_signals: [],
    };
    mockCreateSupabaseAdminClient.mockReturnValue(createMemoryClient(state));
    mockCollectSearchEvidence.mockResolvedValue({
      evidence: [], reusedEvidence: [priorEvidence],
      diagnostics: {
        resultsReturned: 1, resultsFilteredIrrelevant: 0, resultsRejectedSafety: 0,
        resultsSkippedDuplicates: 1, resultsReused: 1, resultsPersisted: 0, providerFailureCode: null,
        resultDetails: [{ sourceUrl: "https://linkedin.com/company/bombas", sourceDomain: "linkedin.com",
          disposition: "reused", reason: null, evidenceId: trustedEvidenceId, originalResearchRunId: priorRunId }],
      },
    });

    await expect(processResearchRun(researchRunId, {
      searchProvider: { name: "tavily", enabled: true, async search() { return []; } },
    })).resolves.toMatchObject({ status: "completed" });

    expect(priorCandidate.status).toBe("accepted");
    expect(priorEvidence).toMatchObject({ research_run_id: priorRunId, confidence: 0.7, status: "candidate" });
    expect(state.company_evidence).toHaveLength(1);
    expect(state.company_evidence[0].research_run_id).toBe(priorRunId);
    const savedSummary = JSON.parse(state.company_research_runs[0].summary as string);
    expect(savedSummary.searchDiagnostics.resultDetails).toContainEqual(expect.objectContaining({
      sourceUrl: "https://linkedin.com/company/bombas", disposition: "reused",
      evidenceId: trustedEvidenceId, originalResearchRunId: priorRunId,
    }));
    const adapted = adaptAcceptedResearchFacts(canonicalInput(), state.company_facts, state.company_evidence,
      new Date("2026-10-09T13:00:00.000Z"), companyId);
    const score = attachIcpResearchProvenance(scoreIcp(adapted.input, new Date("2026-10-09T13:00:00.000Z")), adapted.provenance);
    expect(adapted.input.platform).toBe("Shopify Plus");
    expect(score.factors.platform.evidence).toMatchObject({ sourceFactId: reusedFactId, sourceEvidenceId: trustedEvidenceId });
  });

  it("rejects untrusted reused evidence and fails closed on conflicting reused claims", async () => {
    const untrustedEvidence = {
      ...searchEvidence(untrustedEvidenceId, "outsider.example", 0.35, "Bombas platform: Shopify Plus."),
      research_run_id: priorRunId,
    };
    const untrustedCandidate = {
      id: reusedFactId, company_id: companyId, fact_key: "platform", value_jsonb: "Shopify Plus",
      status: "candidate", confidence: 0.35, source_evidence_id: untrustedEvidenceId,
      observed_at: observedAt, valid_until: null, created_at: observedAt,
    };
    const untrustedState: MemoryState = {
      company_research_runs: [{ id: researchRunId, company_id: companyId, status: "queued", summary: null }],
      companies: [company], company_evidence: [untrustedEvidence], company_facts: [untrustedCandidate], company_growth_signals: [],
    };
    mockCreateSupabaseAdminClient.mockReturnValue(createMemoryClient(untrustedState));
    mockCollectSearchEvidence.mockResolvedValue({ evidence: [], reusedEvidence: [untrustedEvidence], diagnostics: {
      resultsReturned: 1, resultsFilteredIrrelevant: 0, resultsRejectedSafety: 0,
      resultsSkippedDuplicates: 1, resultsReused: 1, resultsPersisted: 0, providerFailureCode: null,
    } });
    await processResearchRun(researchRunId, {
      searchProvider: { name: "tavily", enabled: true, async search() { return []; } },
    });
    expect(untrustedCandidate.status).toBe("rejected");
    expect(untrustedEvidence.research_run_id).toBe(priorRunId);

    vi.clearAllMocks();
    vi.stubEnv("GROWTHOS_TRUSTED_RESEARCH_DOMAINS", "linkedin.com");
    const trustedFirst = { ...searchEvidence(trustedEvidenceId, "linkedin.com", 0.7, "Bombas platform: Shopify Plus."), research_run_id: priorRunId };
    const trustedSecond = { ...searchEvidence(conflictEvidenceId, "linkedin.com", 0.7, "Bombas platform: BigCommerce."), research_run_id: priorRunId };
    const firstCandidate = { ...untrustedCandidate, id: reusedFactId, status: "candidate", value_jsonb: "Shopify Plus", confidence: 0.7, source_evidence_id: trustedEvidenceId };
    const secondCandidate = { ...untrustedCandidate, id: conflictFactId, status: "candidate", value_jsonb: "BigCommerce", confidence: 0.7, source_evidence_id: conflictEvidenceId };
    const conflictState: MemoryState = {
      company_research_runs: [{ id: researchRunId, company_id: companyId, status: "queued", summary: null }],
      companies: [company], company_evidence: [trustedFirst, trustedSecond], company_facts: [firstCandidate, secondCandidate], company_growth_signals: [],
    };
    mockCreateSupabaseAdminClient.mockReturnValue(createMemoryClient(conflictState));
    mockCollectOfficialWebsiteEvidence.mockResolvedValue({ evidence: [], metadata: {} });
    mockCollectSearchEvidence.mockResolvedValue({ evidence: [], reusedEvidence: [trustedFirst, trustedSecond], diagnostics: {
      resultsReturned: 2, resultsFilteredIrrelevant: 0, resultsRejectedSafety: 0,
      resultsSkippedDuplicates: 2, resultsReused: 2, resultsPersisted: 0, providerFailureCode: null,
    } });
    await processResearchRun(researchRunId, {
      searchProvider: { name: "tavily", enabled: true, async search() { return []; } },
    });
    expect([firstCandidate.status, secondCandidate.status]).toEqual(["conflicted", "conflicted"]);
    expect(conflictState.company_evidence.map((row) => row.research_run_id)).toEqual([priorRunId, priorRunId]);
  });

  it("rejects a reused historical founding-year company-size candidate without rewriting its value or provenance", async () => {
    const oldEvidence = {
      ...searchEvidence(trustedEvidenceId, "linkedin.com", 0.7,
        "Bombas was founded in 2013. Employees: 250+."),
      research_run_id: priorRunId,
    };
    const historicalFact = {
      id: reusedFactId, company_id: companyId, fact_key: "company_size", value_jsonb: 2013,
      status: "candidate", confidence: 0.7, source_evidence_id: trustedEvidenceId,
      observed_at: observedAt, valid_until: null, created_at: observedAt,
    };
    const state: MemoryState = {
      company_research_runs: [{ id: researchRunId, company_id: companyId, status: "queued", summary: null }],
      companies: [company], company_evidence: [oldEvidence], company_facts: [historicalFact], company_growth_signals: [],
    };
    mockCreateSupabaseAdminClient.mockReturnValue(createMemoryClient(state));
    mockCollectSearchEvidence.mockResolvedValue({ evidence: [], reusedEvidence: [oldEvidence], diagnostics: {
      resultsReturned: 1, resultsFilteredIrrelevant: 0, resultsRejectedSafety: 0,
      resultsSkippedDuplicates: 1, resultsReused: 1, resultsPersisted: 0, providerFailureCode: null,
    } });

    await processResearchRun(researchRunId, {
      searchProvider: { name: "tavily", enabled: true, async search() { return []; } },
    });

    expect(historicalFact).toMatchObject({ value_jsonb: 2013, status: "rejected", source_evidence_id: trustedEvidenceId });
    expect(oldEvidence.research_run_id).toBe(priorRunId);
    expect(state.company_evidence).toHaveLength(1);
  });
});
