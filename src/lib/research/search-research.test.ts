import { afterEach, describe, expect, it, vi } from "vitest";
vi.mock("server-only", () => ({}));
import { collectSearchEvidence, SearchResearchError, type SearchEvidenceInsert, type SearchResearchStore } from "./search-research";
import type { CompanySearchProvider, SearchResult } from "./search-provider";
import { validateSafeResearchUrl } from "./official-website";
import { TavilySearchError } from "./tavily-provider";

const company = { id: "af2b7bb2-21cc-46f2-97c3-b83bfdc990a2", name: "Example Store", domain: "example.com" };
const runId = "b3054407-5e28-49b6-aceb-0284df07c8ff";
const publicUrl = async (value: string) => new URL(value);
const result = (url: string, overrides: Partial<SearchResult> = {}): SearchResult => ({
  title: "Company profile",
  url,
  sourceDomain: new URL(url).hostname,
  snippet: "Public information about this company.",
  ...overrides,
});

function memoryStore(options: { runCompanyId?: string; status?: string; existingUrls?: string[]; existingEvidence?: Array<Record<string, unknown>>; raceInsert?: boolean } = {}) {
  const inserted: SearchEvidenceInsert[] = [];
  const existingEvidence = [...(options.existingEvidence ?? (options.existingUrls ?? []).map((source_url, index) => ({
    id: `existing-${index}`, company_id: company.id, research_run_id: "ed054407-5e28-49b6-aceb-0284df07c8ff",
    source_type: "search_result", source_name: new URL(source_url).hostname, source_url,
    observed_at: "2026-10-05T12:00:00.000Z", retrieved_at: "2026-10-05T12:00:00.000Z",
    excerpt: JSON.stringify({ pageTitle: "Existing profile", readableTextExcerpt: "Example Store platform: Shopify" }),
    content_hash: `hash-${index}`, confidence: 0.7, status: "candidate",
  })))];
  const store: SearchResearchStore = {
    async getRun() { return { company_id: options.runCompanyId ?? company.id, status: options.status ?? "running" }; },
    async getExistingEvidence(companyId, sourceUrls) {
      return existingEvidence.filter((row) => row.company_id === companyId && typeof row.source_url === "string" && sourceUrls.includes(row.source_url));
    },
    async insertEvidence(rows) {
      inserted.push(...rows);
      const created = rows.map((row, index) => ({ ...row, id: `evidence-${index}` }));
      if (options.raceInsert) {
        existingEvidence.push(...created.map((row) => ({ ...row, research_run_id: "ed054407-5e28-49b6-aceb-0284df07c8ff" })));
        return [];
      }
      return created;
    },
  };
  return { store, inserted };
}

const provider = (results: SearchResult[]): CompanySearchProvider => ({ enabled: true, search: vi.fn(async (query) => {
  expect(query).toEqual({ companyName: company.name, domain: company.domain });
  return results;
}) });

describe("collectSearchEvidence", () => {
  afterEach(() => vi.unstubAllEnvs());
  it("normalizes source URLs and persists snippets as candidate evidence with provenance", async () => {
    const { store, inserted } = memoryStore();
    const item = result("https://news.example.org/story?utm_source=private-token#section");
    const output = await collectSearchEvidence(company, runId, provider([item]), store, {
      now: () => new Date("2026-10-06T12:00:00.000Z"),
      validateUrl: publicUrl,
    });
    expect(output.diagnostics).toEqual({
      resultsReturned: 1, resultsFilteredIrrelevant: 0, resultsRejectedSafety: 0,
      resultsSkippedDuplicates: 0, resultsReused: 0, resultsPersisted: 1, providerFailureCode: null,
      resultDetails: [{ sourceUrl: "https://news.example.org/story", sourceDomain: "news.example.org",
        disposition: "persisted", reason: null, evidenceId: "evidence-0" }],
    });
    expect(inserted).toHaveLength(1);
    expect(inserted[0]).toMatchObject({
      company_id: company.id, research_run_id: runId, source_type: "search_result",
      source_name: "news.example.org", source_url: "https://news.example.org/story?utm_source=private-token",
      observed_at: "2026-10-06T12:00:00.000Z", retrieved_at: "2026-10-06T12:00:00.000Z",
      confidence: 0.35, status: "candidate",
    });
    expect(JSON.stringify(output.diagnostics.resultDetails)).not.toContain("private-token");
    expect(JSON.parse(inserted[0].excerpt)).toMatchObject({
      pageTitle: item.title,
      readableTextExcerpt: item.snippet,
      title: item.title,
      snippet: item.snippet,
    });
    expect(output.evidence[0]).toMatchObject({ source_type: "search_result", research_run_id: runId });
  });

  it("raises source-quality confidence only for explicitly trusted source domains", async () => {
    vi.stubEnv("GROWTHOS_TRUSTED_RESEARCH_DOMAINS", "trusted.example.org");
    const { store, inserted } = memoryStore();
    await collectSearchEvidence(company, runId, provider([
      result("https://trusted.example.org/profile"),
      result("https://lookalike-trusted.example.org/profile"),
    ]), store, { now: () => new Date("2026-10-06T12:00:00.000Z"), validateUrl: publicUrl });
    expect(inserted.map(({ confidence }) => confidence)).toEqual([0.7, 0.35]);
    expect(inserted.every(({ status }) => status === "candidate")).toBe(true);
  });

  it("deduplicates duplicate URLs in one result set", async () => {
    const { store, inserted } = memoryStore({ existingUrls: ["https://news.example.org/existing"] });
    await collectSearchEvidence(company, runId, provider([
      result("https://news.example.org/story"),
      result("https://news.example.org/story#duplicate"),
      result("https://news.example.org/existing"),
    ]), store, { now: () => new Date(), validateUrl: publicUrl });
    expect(inserted.map((item) => item.source_url)).toEqual(["https://news.example.org/story"]);
    const output = await collectSearchEvidence(company, runId, provider([
      result("https://news.example.org/story"),
      result("https://news.example.org/story#duplicate"),
      result("https://news.example.org/existing"),
    ]), store, { now: () => new Date(), validateUrl: publicUrl });
    expect(output.diagnostics.resultsSkippedDuplicates).toBe(2);
    expect(output.reusedEvidence).toHaveLength(1);
  });

  it("attributes same-path URLs with distinct queries to their exact persisted and reused rows", async () => {
    const reusedUrl = "https://news.example.org/story?edition=old";
    const freshUrl = "https://news.example.org/story?edition=new";
    const { store, inserted } = memoryStore({ existingUrls: [reusedUrl] });
    const output = await collectSearchEvidence(company, runId, provider([
      result(freshUrl + "#top"), result(reusedUrl + "#top"),
    ]), store, { now: () => new Date(), validateUrl: publicUrl });
    expect(inserted.map((row) => row.source_url)).toEqual([freshUrl]);
    expect(output.diagnostics.resultDetails).toEqual([
      { sourceUrl: "https://news.example.org/story", sourceDomain: "news.example.org",
        disposition: "persisted", reason: null, evidenceId: "evidence-0" },
      { sourceUrl: "https://news.example.org/story", sourceDomain: "news.example.org",
        disposition: "reused", reason: null, evidenceId: "existing-0",
        originalResearchRunId: "ed054407-5e28-49b6-aceb-0284df07c8ff" },
    ]);
  });

  it("keeps a true duplicate filtered while attributing the one persisted URL", async () => {
    const { store } = memoryStore();
    const output = await collectSearchEvidence(company, runId, provider([
      result("https://news.example.org/story?edition=new#top"),
      result("https://news.example.org/story?edition=new#bottom"),
    ]), store, { now: () => new Date(), validateUrl: publicUrl });
    expect(output.diagnostics.resultsSkippedDuplicates).toBe(1);
    expect(output.diagnostics.resultDetails).toEqual([
      { sourceUrl: "https://news.example.org/story", sourceDomain: "news.example.org",
        disposition: "persisted", reason: null, evidenceId: "evidence-0" },
      { sourceUrl: "https://news.example.org/story", sourceDomain: "news.example.org",
        disposition: "filtered", reason: "duplicate_research_url", evidenceId: "evidence-0" },
    ]);
  });

  it("sanitizes and bounds untrusted provider diagnostics before recording them", async () => {
    const { store } = memoryStore();
    const unsafe = "Bearer private-key";
    const diagnosticProvider: CompanySearchProvider = {
      enabled: true, async search() { return []; },
      async searchWithDiagnostics() {
        return {
          results: [result("https://news.example.org/new?api_key=private-key")],
          resultsReturned: 1, resultsFilteredIrrelevant: 1, resultsRejectedSafety: 1,
          resultDiagnostics: [
            { sourceUrl: "https://news.example.org/rejected?api_key=private-key", sourceDomain: "news.example.org",
              disposition: "rejected", reason: "invalid_source_url", authorization: unsafe },
            { sourceUrl: "https://news.example.org/authorization/Bearer/private-key", sourceDomain: "news.example.org",
              disposition: "filtered", reason: "company_identity_not_established" },
            { sourceUrl: "https://user:private-key@news.example.org/unsafe", sourceDomain: "news.example.org",
              disposition: "filtered", reason: "company_identity_not_established" },
            { sourceUrl: "https://news.example.org/invalid", sourceDomain: "evil.example",
              disposition: "filtered", reason: "company_identity_not_established" },
            { sourceUrl: "https://news.example.org/invalid", sourceDomain: "news.example.org",
              disposition: "filtered", reason: unsafe },
            { sourceUrl: "https://news.example.org/invalid", sourceDomain: "news.example.org",
              disposition: "filtered", reason: "invalid_source_url", evidenceId: unsafe },
            { sourceUrl: "https://news.example.org/" + "x".repeat(2100), sourceDomain: "news.example.org",
              disposition: "filtered", reason: "invalid_source_url" },
            null, unsafe,
            { sourceUrl: "https://news.example.org/eligible?token=private-key", sourceDomain: "news.example.org",
              disposition: "eligible", reason: null, extra: unsafe },
          ] as never,
        };
      },
    };
    const output = await collectSearchEvidence(company, runId, diagnosticProvider, store,
      { now: () => new Date(), validateUrl: publicUrl });
    expect(output.diagnostics.resultDetails).toEqual([
      { sourceUrl: "https://news.example.org/rejected", sourceDomain: "news.example.org",
        disposition: "rejected", reason: "invalid_source_url" },
      { sourceUrl: "https://news.example.org/new", sourceDomain: "news.example.org",
        disposition: "persisted", reason: null, evidenceId: "evidence-0" },
    ]);
    expect(JSON.stringify(output.diagnostics)).not.toContain("private-key");
    expect(JSON.stringify(output.diagnostics)).not.toContain("authorization");
  });

  it("caps diagnostic entries and rejects malformed provider diagnostic shapes", async () => {
    const { store } = memoryStore();
    const valid = { sourceUrl: "https://news.example.org/item", sourceDomain: "news.example.org",
      disposition: "filtered", reason: "company_identity_not_established" };
    const diagnosticProvider: CompanySearchProvider = {
      enabled: true, async search() { return []; },
      async searchWithDiagnostics() {
        return { results: [], resultsReturned: 0, resultsFilteredIrrelevant: 0, resultsRejectedSafety: 0,
          resultDiagnostics: [
            { ...valid, sourceDomain: "x".repeat(254) },
            { ...valid, disposition: "persisted" },
            { ...valid, originalResearchRunId: "not-a-uuid" },
            ...Array.from({ length: 50 }, () => valid),
          ] as never };
      },
    };
    const output = await collectSearchEvidence(company, runId, diagnosticProvider, store,
      { now: () => new Date(), validateUrl: publicUrl });
    expect(output.diagnostics.resultDetails).toHaveLength(30);
    expect(output.diagnostics.resultDetails.every((item) => item.disposition === "filtered"
      && item.sourceUrl === "https://news.example.org/item")).toBe(true);
    const malformedProvider: CompanySearchProvider = {
      enabled: true, async search() { return []; },
      async searchWithDiagnostics() {
        return { results: [], resultsReturned: 0, resultsFilteredIrrelevant: 0,
          resultsRejectedSafety: 0, resultDiagnostics: { authorization: "private-key" } as never };
      },
    };
    const malformed = await collectSearchEvidence(company, runId, malformedProvider, store,
      { now: () => new Date(), validateUrl: publicUrl });
    expect(malformed.diagnostics.resultDetails).toEqual([]);
    expect(JSON.stringify(malformed.diagnostics)).not.toContain("private-key");
  });

  it("reuses prior-run evidence without inserting or changing original provenance", async () => {
    const existing = {
      id: "ed054407-5e28-49b6-aceb-0284df07c8ff", company_id: company.id,
      research_run_id: "dd054407-5e28-49b6-aceb-0284df07c8ff", source_type: "search_result",
      source_name: "trusted.example.org", source_url: "https://trusted.example.org/profile",
      observed_at: "2026-10-05T12:00:00.000Z", retrieved_at: "2026-10-05T12:00:00.000Z",
      excerpt: JSON.stringify({ pageTitle: "Example Store", readableTextExcerpt: "Example Store platform: Shopify" }),
      content_hash: "original-hash", confidence: 0.7, status: "candidate",
    };
    const { store, inserted } = memoryStore({ existingEvidence: [existing] });
    const output = await collectSearchEvidence(company, runId, provider([result("https://trusted.example.org/profile#section")]), store, {
      now: () => new Date("2026-10-06T12:00:00.000Z"), validateUrl: publicUrl,
    });
    expect(output.evidence).toHaveLength(0);
    expect(inserted).toHaveLength(0);
    expect(output.reusedEvidence).toEqual([existing]);
    expect(output.reusedEvidence[0]).toMatchObject({
      research_run_id: existing.research_run_id,
      observed_at: existing.observed_at,
      confidence: 0.7,
      status: "candidate",
      content_hash: "original-hash",
    });
    expect(output.diagnostics).toMatchObject({ resultsSkippedDuplicates: 1, resultsReused: 1, resultsPersisted: 0 });
    expect(output.diagnostics.resultDetails).toContainEqual({
      sourceUrl: "https://trusted.example.org/profile", sourceDomain: "trusted.example.org",
      disposition: "reused", reason: null, evidenceId: existing.id, originalResearchRunId: existing.research_run_id,
    });
  });

  it("recovers a concurrent URL insert and returns the original row as reused evidence", async () => {
    const { store, inserted } = memoryStore({ raceInsert: true });
    const output = await collectSearchEvidence(company, runId, provider([result("https://news.example.org/raced")]), store, {
      now: () => new Date("2026-10-06T12:00:00.000Z"), validateUrl: publicUrl,
    });
    expect(inserted).toHaveLength(1);
    expect(output.evidence).toHaveLength(0);
    expect(output.reusedEvidence).toHaveLength(1);
    expect(output.reusedEvidence[0]).toMatchObject({
      research_run_id: "ed054407-5e28-49b6-aceb-0284df07c8ff",
      source_url: "https://news.example.org/raced",
    });
    expect(output.diagnostics).toMatchObject({ resultsPersisted: 0, resultsReused: 1 });
    expect(output.diagnostics.resultDetails).toContainEqual(expect.objectContaining({
      sourceUrl: "https://news.example.org/raced", disposition: "reused", evidenceId: output.reusedEvidence[0].id,
      originalResearchRunId: "ed054407-5e28-49b6-aceb-0284df07c8ff",
    }));
  });

  it("rejects malformed, non-HTTP, credentialed, and mismatched-domain results", async () => {
    const { store, inserted } = memoryStore();
    const validateUrl = vi.fn(publicUrl);
    await collectSearchEvidence(company, runId, provider([
      { ...result("https://news.example.org/a"), url: "not a URL" },
      result("javascript:alert(1)"),
      result("https://user:pass@news.example.org/a"),
      result("https://news.example.org/a", { sourceDomain: "other.example" }),
    ]), store, { now: () => new Date(), validateUrl });
    expect(inserted).toHaveLength(0);
    expect(validateUrl).not.toHaveBeenCalled();
    const output = await collectSearchEvidence(company, runId, provider([
      { ...result("https://news.example.org/a"), url: "not a URL" },
    ]), store, { now: () => new Date(), validateUrl });
    expect(output.diagnostics.resultsRejectedSafety).toBe(1);
  });

  it("uses the shared SSRF validator and drops private or reserved targets", async () => {
    const { store, inserted } = memoryStore();
    const validateUrl = vi.fn(async (value: string) => {
      if (value.includes("private.example")) throw new Error("blocked");
      return new URL(value);
    });
    const output = await collectSearchEvidence(company, runId, provider([
      result("https://private.example/internal"),
      result("https://public.example/article"),
    ]), store, { now: () => new Date(), validateUrl });
    expect(validateUrl).toHaveBeenCalledTimes(2);
    expect(inserted.map((item) => item.source_url)).toEqual(["https://public.example/article"]);
    expect(output.diagnostics.resultsRejectedSafety).toBe(1);
  });

  it("blocks literal private IPs and DNS names resolving to private addresses", async () => {
    await expect(validateSafeResearchUrl("http://127.0.0.1/admin")).rejects.toMatchObject({ code: "website_target_blocked" });
    await expect(validateSafeResearchUrl("https://public.example.org/story", async () => [
      { address: "10.0.0.8", family: 4 },
    ])).rejects.toMatchObject({ code: "website_target_blocked" });
  });

  it("limits results processed per run", async () => {
    const { store, inserted } = memoryStore();
    const results = Array.from({ length: 15 }, (_, index) => result(`https://source${index}.example.org/${index}`));
    await collectSearchEvidence(company, runId, provider(results), store, { now: () => new Date(), validateUrl: publicUrl });
    expect(inserted).toHaveLength(10);
  });

  it("does not persist evidence for another company's or non-running research run", async () => {
    const wrongCompany = memoryStore({ runCompanyId: "ccddeeff-21cc-46f2-97c3-b83bfdc990a2" });
    const search = provider([result("https://news.example.org/story")]);
    await expect(collectSearchEvidence(company, runId, search, wrongCompany.store, { now: () => new Date(), validateUrl: publicUrl }))
      .rejects.toBeInstanceOf(SearchResearchError);
    expect(wrongCompany.inserted).toHaveLength(0);

    const wrongStatus = memoryStore({ status: "completed" });
    await expect(collectSearchEvidence(company, runId, search, wrongStatus.store, { now: () => new Date(), validateUrl: publicUrl }))
      .rejects.toMatchObject({ code: "research_run_isolated" });
    expect(wrongStatus.inserted).toHaveLength(0);
    expect(search.search).not.toHaveBeenCalled();
  });

  it("handles mock provider failure without exposing the provider error or persisting rows", async () => {
    const { store, inserted } = memoryStore();
    const failingProvider: CompanySearchProvider = { enabled: true, async search() { throw new Error("secret provider response"); } };
    const output = await collectSearchEvidence(company, runId, failingProvider, store, {
      now: () => new Date(), validateUrl: publicUrl,
    });
    expect(output).toEqual({ evidence: [], diagnostics: {
      resultsReturned: 0, resultsFilteredIrrelevant: 0, resultsRejectedSafety: 0,
      resultsSkippedDuplicates: 0, resultsReused: 0, resultsPersisted: 0, providerFailureCode: "search_provider_failed",
      resultDetails: [],
    }, reusedEvidence: [] });
    expect(inserted).toHaveLength(0);
    expect(JSON.stringify(output)).not.toContain("secret provider response");
  });

  it("records only an allow-listed provider failure code", async () => {
    const { store } = memoryStore();
    const failingProvider: CompanySearchProvider = {
      enabled: true,
      async search() { throw Object.assign(new Error("private"), { code: "tavily_rate_limited" }); },
    };
    const output = await collectSearchEvidence(company, runId, failingProvider, store, {
      now: () => new Date(), validateUrl: publicUrl,
    });
    expect(output.diagnostics.providerFailureCode).toBe("tavily_rate_limited");
  });

  it("retains only structured Tavily response diagnostics alongside the public error code", async () => {
    const { store, inserted } = memoryStore();
    const diagnostic = {
      reason: "malformed_results" as const,
      httpStatus: 200,
      contentType: "application/json",
      responseExcerpt: '{"topLevelKeys":["results"],"resultsType":"object"}',
    };
    const failingProvider: CompanySearchProvider = {
      name: "tavily",
      enabled: true,
      async search() { throw new Error("must call diagnostics endpoint"); },
      async searchWithDiagnostics() {
        throw Object.assign(new TavilySearchError("tavily_invalid_response", diagnostic), {
          message: "sensitive body and credentials must not escape",
        });
      },
    };
    const output = await collectSearchEvidence(company, runId, failingProvider, store, {
      now: () => new Date(), validateUrl: publicUrl,
    });
    expect(output.diagnostics).toMatchObject({
      providerFailureCode: "tavily_invalid_response",
      providerFailureDiagnostic: diagnostic,
    });
    expect(JSON.stringify(output)).not.toContain("sensitive body");
    expect(inserted).toHaveLength(0);
  });
});
