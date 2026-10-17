import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import {
  validateCandidateCompanyFact,
  validateCandidateCompanyFactForRun,
  type FactValidationPatch,
  type FactValidationRepository,
} from "./fact-validation";
import type { CompanyResearchIdentity } from "./source-quality";

const companyId = "af2b7bb2-21cc-46f2-97c3-b83bfdc990a2";
const otherCompanyId = "ccddeeff-21cc-46f2-97c3-b83bfdc990a2";
const evidenceId = "b3054407-5e28-49b6-aceb-0284df07c8ff";
const secondEvidenceId = "f3054407-5e28-49b6-aceb-0284df07c8ff";
const factId = "b9054407-5e28-49b6-aceb-0284df07c8ff";
const secondFactId = "f9054407-5e28-49b6-aceb-0284df07c8ff";
const researchRunId = "dd054407-5e28-49b6-aceb-0284df07c8ff";
const otherResearchRunId = "ed054407-5e28-49b6-aceb-0284df07c8ff";
const now = new Date("2026-10-06T12:00:00.000Z");

function evidence(id: string, text: string, status = "candidate", company = companyId, runId: string | null = null) {
  return {
    id,
    company_id: company,
    research_run_id: runId,
    source_type: "official_website",
    source_name: "Official website",
    source_url: "https://example.com/about",
    observed_at: "2026-10-06T10:00:00.000Z",
    retrieved_at: "2026-10-06T10:00:00.000Z",
    excerpt: JSON.stringify({ readableTextExcerpt: text }),
    content_hash: id,
    confidence: 0.7,
    status,
    created_at: "2026-10-06T10:00:00.000Z",
  };
}

function factRow(id: string, sourceEvidenceId: string, value: unknown, status = "candidate", observedAt = "2026-10-06T10:00:00.000Z", company = companyId, factKey = "platform") {
  return {
    id,
    company_id: company,
    fact_key: factKey,
    value_jsonb: value,
    status,
    confidence: 0.7,
    source_evidence_id: sourceEvidenceId,
    observed_at: observedAt,
    valid_until: null,
    created_at: observedAt,
  };
}

class MemoryFactRepository implements FactValidationRepository {
  readonly updates: Array<{ id: string; patch: FactValidationPatch }> = [];

  constructor(
    readonly facts: Array<Record<string, unknown>>,
    readonly evidenceRows: Array<Record<string, unknown>>,
    readonly identity: CompanyResearchIdentity = { name: "Example Store", domain: "example.com" },
  ) {}

  async getCompanyIdentity(company: string): Promise<CompanyResearchIdentity | null> {
    return company === companyId ? this.identity : null;
  }

  async listCompanyFacts(company: string) {
    return this.facts.filter((fact) => fact.company_id === company);
  }

  async listCompanyEvidence(company: string, evidenceIds: string[]) {
    return this.evidenceRows.filter((evidence) => evidenceIds.includes(String(evidence.id)) && evidence.company_id === company);
  }

  async updateFact(company: string, id: string, expectedStatus: "candidate" | "accepted" | "rejected" | "conflicted" | "stale", patch: FactValidationPatch) {
    const row = this.facts.find((fact) => fact.id === id && fact.company_id === company && fact.status === expectedStatus);
    if (!row) return false;
    Object.assign(row, patch);
    this.updates.push({ id, patch });
    return true;
  }
}

describe("validateCandidateCompanyFact", () => {
  it("accepts an evidence-supported candidate and preserves provenance", async () => {
    const repo = new MemoryFactRepository(
      [factRow(factId, evidenceId, "Shopify")],
      [evidence(evidenceId, "Platform: Shopify")],
    );

    const result = await validateCandidateCompanyFact(companyId, factId, repo, now);

    expect(result).toEqual({ factId, status: "accepted" });
    expect(repo.facts[0]).toMatchObject({ status: "accepted", source_evidence_id: evidenceId });
  });

  it("rejects a candidate that its evidence does not support", async () => {
    const repo = new MemoryFactRepository(
      [factRow(factId, evidenceId, "Shopify")],
      [evidence(evidenceId, "Platform: BigCommerce")],
    );

    expect(await validateCandidateCompanyFact(companyId, factId, repo, now)).toMatchObject({ status: "rejected" });
    expect(repo.facts[0].status).toBe("rejected");
  });

  it.each([
    ["Bombas Klassen", "https://www.linkedin.com/company/bombas-klassen", "Industrial Machinery Manufacturing"],
    ["Bombas Rodase", "https://www.linkedin.com/company/bombas-rodase", "Consumer Goods"],
  ])("rejects candidate facts from namesake company %s", async (name, sourceUrl, industry) => {
    vi.stubEnv("GROWTHOS_TRUSTED_RESEARCH_DOMAINS", "linkedin.com");
    const namesakeEvidence = {
      ...evidence(evidenceId, `${name}\nIndustry: ${industry}`),
      source_type: "search_result",
      source_name: "www.linkedin.com",
      source_url: sourceUrl,
      excerpt: JSON.stringify({ pageTitle: name, readableTextExcerpt: `${name}\nIndustry: ${industry}` }),
    };
    const candidate = factRow(factId, evidenceId, industry, "candidate", undefined, companyId, "industry");
    const repo = new MemoryFactRepository([candidate], [namesakeEvidence], {
      name: "Bombas", domain: "bombas.com", linkedin_url: "https://www.linkedin.com/company/bombas",
    });

    expect(await validateCandidateCompanyFact(companyId, factId, repo, now)).toMatchObject({ status: "rejected" });
    expect(candidate.status).toBe("rejected");
  });

  it("accepts an explicit fact from the genuine trusted Bombas profile", async () => {
    vi.stubEnv("GROWTHOS_TRUSTED_RESEARCH_DOMAINS", "linkedin.com");
    const candidate = factRow(factId, evidenceId, "Apparel", "candidate", undefined, companyId, "industry");
    const profile = {
      ...evidence(evidenceId, "Bombas | LinkedIn company profile. Industry: Apparel."),
      source_type: "search_result", source_name: "www.linkedin.com",
      source_url: "https://www.linkedin.com/company/bombas?trk=profile", confidence: 0.7,
    };
    const repo = new MemoryFactRepository([candidate], [profile], {
      name: "Bombas", domain: "bombas.com", linkedin_url: "https://www.linkedin.com/company/bombas",
    });
    try {
      expect(await validateCandidateCompanyFact(companyId, factId, repo, now)).toMatchObject({ status: "accepted" });
      expect(candidate).toMatchObject({ status: "accepted", source_evidence_id: evidenceId });
    } finally { vi.unstubAllEnvs(); }
  });

  it.each(["bombas.com.evil.example", "notbombas.com"])(
    "rejects an otherwise explicit Bombas fact backed only by deceptive domain text %s", async (host) => {
      vi.stubEnv("GROWTHOS_TRUSTED_RESEARCH_DOMAINS", "trusted.example.org");
      const candidate = factRow(factId, evidenceId, "Apparel", "candidate", undefined, companyId, "industry");
      const source = {
        ...evidence(evidenceId, `Bombas profile at ${host}. Industry: Apparel.`),
        source_type: "search_result", source_name: "trusted.example.org",
        source_url: "https://trusted.example.org/company-profile", confidence: 0.7,
      };
      const repo = new MemoryFactRepository([candidate], [source], { name: "Bombas", domain: "bombas.com" });
      try {
        expect(await validateCandidateCompanyFact(companyId, factId, repo, now)).toMatchObject({ status: "rejected" });
        expect(candidate.status).toBe("rejected");
      } finally { vi.unstubAllEnvs(); }
    },
  );

  it("marks conflicting values conflicted without accepting either", async () => {
    const repo = new MemoryFactRepository(
      [factRow(factId, evidenceId, "Shopify"), factRow(secondFactId, secondEvidenceId, "BigCommerce")],
      [evidence(evidenceId, "Platform: Shopify"), evidence(secondEvidenceId, "Platform: BigCommerce")],
    );

    const result = await validateCandidateCompanyFact(companyId, factId, repo, now);

    expect(result.status).toBe("conflicted");
    expect(repo.facts.map((fact) => fact.status)).toEqual(["conflicted", "conflicted"]);
  });

  it("marks a candidate stale when its linked evidence is stale", async () => {
    const repo = new MemoryFactRepository(
      [factRow(factId, evidenceId, "Shopify")],
      [evidence(evidenceId, "Platform: Shopify", "stale")],
    );

    expect(await validateCandidateCompanyFact(companyId, factId, repo, now)).toMatchObject({ status: "stale" });
    expect(repo.facts[0].status).toBe("stale");
  });

  it("does not create a duplicate accepted fact when the same candidate is retried", async () => {
    const repo = new MemoryFactRepository(
      [factRow(factId, evidenceId, "Shopify")],
      [evidence(evidenceId, "Platform: Shopify")],
    );

    await validateCandidateCompanyFact(companyId, factId, repo, now);
    const retry = await validateCandidateCompanyFact(companyId, factId, repo, now);

    expect(retry.status).toBe("already_processed");
    expect(repo.facts.filter((fact) => fact.status === "accepted")).toHaveLength(1);
    expect(repo.updates).toHaveLength(1);
  });

  it("replaces an older accepted fact with a newer valid fact while preserving history", async () => {
    const older = factRow(secondFactId, secondEvidenceId, "WooCommerce", "accepted", "2026-09-01T10:00:00.000Z");
    const newer = factRow(factId, evidenceId, "Shopify", "candidate", "2026-10-06T10:00:00.000Z");
    const repo = new MemoryFactRepository(
      [older, newer],
      [evidence(secondEvidenceId, "Platform: WooCommerce"), evidence(evidenceId, "Platform: Shopify")],
    );

    const result = await validateCandidateCompanyFact(companyId, factId, repo, now);

    expect(result).toEqual({ factId, status: "accepted", replacedFactId: secondFactId });
    expect(older).toMatchObject({ status: "stale", valid_until: newer.observed_at });
    expect(newer).toMatchObject({ status: "accepted", source_evidence_id: evidenceId });
    expect(repo.facts.filter((fact) => fact.status === "accepted")).toHaveLength(1);
  });

  it("does not accept a candidate whose evidence belongs to another company", async () => {
    const candidate = factRow(factId, evidenceId, "Shopify");
    const repo = new MemoryFactRepository([candidate], [evidence(evidenceId, "Platform: Shopify", "candidate", otherCompanyId)]);

    expect(await validateCandidateCompanyFact(companyId, factId, repo, now)).toMatchObject({ status: "rejected" });
    expect(candidate.status).toBe("rejected");
    expect(repo.updates.every(({ id }) => id === factId)).toBe(true);
  });

  it("cannot retrieve or mutate another company's fact", async () => {
    const foreignFact = factRow(factId, evidenceId, "Shopify", "candidate", "2026-10-06T10:00:00.000Z", otherCompanyId);
    const repo = new MemoryFactRepository([foreignFact], [evidence(evidenceId, "Platform: Shopify", "candidate", otherCompanyId)]);

    await expect(validateCandidateCompanyFact(companyId, factId, repo, now)).rejects.toMatchObject({ code: "fact_not_found" });
    expect(foreignFact.status).toBe("candidate");
    expect(repo.updates).toHaveLength(0);
  });

  it("accepts explicit facts from a configured trusted source when identity matches", async () => {
    vi.stubEnv("GROWTHOS_TRUSTED_RESEARCH_DOMAINS", "trusted.example.org");
    const searchEvidence = {
      ...evidence(evidenceId, "Example Store platform: Shopify"),
      source_type: "search_result",
      source_name: "trusted.example.org",
      source_url: "https://trusted.example.org/profile/example-store",
      confidence: 0.7,
    };
    const repo = new MemoryFactRepository([factRow(factId, evidenceId, "Shopify")], [searchEvidence]);
    try {
      expect(await validateCandidateCompanyFact(companyId, factId, repo, now)).toMatchObject({ status: "accepted" });
      expect(repo.facts[0]).toMatchObject({ status: "accepted", source_evidence_id: evidenceId });
    } finally { vi.unstubAllEnvs(); }
  });

  it("rejects unrelated and ambiguous-identity third-party evidence", async () => {
    vi.stubEnv("GROWTHOS_TRUSTED_RESEARCH_DOMAINS", "trusted.example.org");
    for (const text of ["Example Shop platform: Shopify", "Store platform: Shopify"]) {
      const searchEvidence = {
        ...evidence(evidenceId, text), source_type: "search_result", source_name: "trusted.example.org",
        source_url: "https://trusted.example.org/company", confidence: 0.7,
      };
      const candidate = factRow(factId, evidenceId, "Shopify");
      const repo = new MemoryFactRepository([candidate], [searchEvidence]);
      expect(await validateCandidateCompanyFact(companyId, factId, repo, now)).toMatchObject({ status: "rejected" });
      expect(candidate.status).toBe("rejected");
    }
    vi.unstubAllEnvs();
  });

  it("rejects third-party evidence outside the configured allowlist or below the quality threshold", async () => {
    vi.stubEnv("GROWTHOS_TRUSTED_RESEARCH_DOMAINS", "trusted.example.org");
    for (const changes of [
      { source_url: "https://untrusted.example.net/company" },
      { confidence: 0.35 },
    ]) {
      const candidate = factRow(factId, evidenceId, "Shopify");
      const repo = new MemoryFactRepository([candidate], [{
        ...evidence(evidenceId, "Example Store platform: Shopify"), source_type: "search_result",
        source_name: "trusted.example.org", source_url: "https://trusted.example.org/company", confidence: 0.7,
        ...changes,
      }]);
      expect(await validateCandidateCompanyFact(companyId, factId, repo, now)).toMatchObject({ status: "rejected" });
    }
    vi.unstubAllEnvs();
  });

  it.each([
    ["industry", "Example Store. Industry: Apparel.", "Apparel"],
    ["geography", "Example Store is headquartered in Austin, Texas.", "Austin, Texas"],
    ["company_size", "Example Store company size: 125 employees.", 125],
    ["platform", "Example Store platform: Shopify Plus.", "Shopify Plus"],
    ["revenue", "Example Store annual revenue of USD 12 million.", { amount: 12_000_000, currency: "USD", period: "annual" }],
  ])("accepts explicit trusted-source %s facts while retaining provenance", async (factKey, text, value) => {
    vi.stubEnv("GROWTHOS_TRUSTED_RESEARCH_DOMAINS", "trusted.example.org");
    const searchEvidence = {
      ...evidence(evidenceId, text), source_type: "search_result", source_name: "trusted.example.org",
      source_url: "https://trusted.example.org/company", confidence: 0.7,
    };
    const candidate = factRow(factId, evidenceId, value, "candidate", "2026-10-06T10:00:00.000Z", companyId, factKey);
    const repo = new MemoryFactRepository([candidate], [searchEvidence]);
    try {
      expect(await validateCandidateCompanyFact(companyId, factId, repo, now)).toMatchObject({ status: "accepted" });
      expect(candidate).toMatchObject({ status: "accepted", source_evidence_id: evidenceId, company_id: companyId });
    } finally { vi.unstubAllEnvs(); }
  });

  it("marks conflicting trusted-source claims as conflicted instead of choosing one", async () => {
    vi.stubEnv("GROWTHOS_TRUSTED_RESEARCH_DOMAINS", "trusted.example.org");
    const firstEvidence = {
      ...evidence(evidenceId, "Example Store platform: Shopify."), source_type: "search_result",
      source_name: "trusted.example.org", source_url: "https://trusted.example.org/company", confidence: 0.7,
    };
    const secondEvidence = {
      ...evidence(secondEvidenceId, "Example Store platform: BigCommerce."), source_type: "search_result",
      source_name: "trusted.example.org", source_url: "https://trusted.example.org/company/2", confidence: 0.7,
    };
    const first = factRow(factId, evidenceId, "Shopify");
    const second = factRow(secondFactId, secondEvidenceId, "BigCommerce");
    const repo = new MemoryFactRepository([first, second], [firstEvidence, secondEvidence]);
    try {
      expect(await validateCandidateCompanyFact(companyId, factId, repo, now)).toMatchObject({ status: "conflicted" });
      expect([first.status, second.status]).toEqual(["conflicted", "conflicted"]);
    } finally { vi.unstubAllEnvs(); }
  });

  it("does not accept trusted third-party evidence after it is stale", async () => {
    vi.stubEnv("GROWTHOS_TRUSTED_RESEARCH_DOMAINS", "trusted.example.org");
    const candidate = factRow(factId, evidenceId, "Shopify");
    const searchEvidence = {
      ...evidence(evidenceId, "Example Store platform: Shopify", "stale"), source_type: "search_result",
      source_name: "trusted.example.org", source_url: "https://trusted.example.org/company", confidence: 0.7,
    };
    const repo = new MemoryFactRepository([candidate], [searchEvidence]);
    try {
      expect(await validateCandidateCompanyFact(companyId, factId, repo, now)).toMatchObject({ status: "stale" });
      expect(candidate.status).toBe("stale");
    } finally { vi.unstubAllEnvs(); }
  });

  it("rejects revenue values missing currency or reporting period", async () => {
    vi.stubEnv("GROWTHOS_TRUSTED_RESEARCH_DOMAINS", "trusted.example.org");
    const candidate = factRow(factId, evidenceId, { amount: 12_000_000, currency: "USD", period: "unknown" }, "candidate", "2026-10-06T10:00:00.000Z", companyId, "revenue");
    const searchEvidence = {
      ...evidence(evidenceId, "Example Store annual revenue is $12 million."), source_type: "search_result",
      source_name: "trusted.example.org", source_url: "https://trusted.example.org/company", confidence: 0.7,
    };
    const repo = new MemoryFactRepository([candidate], [searchEvidence]);
    try {
      expect(await validateCandidateCompanyFact(companyId, factId, repo, now)).toMatchObject({ status: "rejected" });
      expect(candidate.status).toBe("rejected");
    } finally { vi.unstubAllEnvs(); }
  });

  it("keeps out-of-run candidates unchanged while allowing their valid claims to block conflicting acceptance", async () => {
    vi.stubEnv("GROWTHOS_TRUSTED_RESEARCH_DOMAINS", "trusted.example.org");
    const currentEvidence = {
      ...evidence(evidenceId, "Example Store platform: Shopify", "candidate", companyId, researchRunId),
      source_type: "search_result", source_name: "trusted.example.org",
      source_url: "https://trusted.example.org/company", confidence: 0.7,
    };
    const priorRunEvidence = {
      ...evidence(secondEvidenceId, "Example Store platform: BigCommerce", "candidate", companyId, otherResearchRunId),
      source_type: "search_result", source_name: "trusted.example.org",
      source_url: "https://trusted.example.org/company/older", confidence: 0.7,
    };
    const currentFact = factRow(factId, evidenceId, "Shopify");
    const priorRunFact = factRow(secondFactId, secondEvidenceId, "BigCommerce");
    const repo = new MemoryFactRepository([currentFact, priorRunFact], [currentEvidence, priorRunEvidence]);

    try {
      expect(await validateCandidateCompanyFactForRun(companyId, factId, researchRunId, repo, now))
        .toMatchObject({ status: "conflicted" });
      expect(currentFact.status).toBe("conflicted");
      expect(priorRunFact.status).toBe("candidate");
      expect(repo.updates.map(({ id }) => id)).toEqual([factId]);
    } finally { vi.unstubAllEnvs(); }
  });

  it("rejects a candidate whose evidence belongs to a different research run", async () => {
    const candidate = factRow(factId, evidenceId, "Shopify");
    const repo = new MemoryFactRepository(
      [candidate],
      [evidence(evidenceId, "Platform: Shopify", "candidate", companyId, otherResearchRunId)],
    );

    await expect(validateCandidateCompanyFactForRun(companyId, factId, researchRunId, repo, now))
      .rejects.toMatchObject({ code: "fact_not_found" });
    expect(candidate.status).toBe("candidate");
    expect(repo.updates).toHaveLength(0);
  });

  it("marks conflicting candidates from the same research run conflicted", async () => {
    vi.stubEnv("GROWTHOS_TRUSTED_RESEARCH_DOMAINS", "trusted.example.org");
    const firstEvidence = {
      ...evidence(evidenceId, "Example Store platform: Shopify", "candidate", companyId, researchRunId),
      source_type: "search_result", source_name: "trusted.example.org",
      source_url: "https://trusted.example.org/company", confidence: 0.7,
    };
    const secondEvidence = {
      ...evidence(secondEvidenceId, "Example Store platform: BigCommerce", "candidate", companyId, researchRunId),
      source_type: "search_result", source_name: "trusted.example.org",
      source_url: "https://trusted.example.org/company/2", confidence: 0.7,
    };
    const first = factRow(factId, evidenceId, "Shopify");
    const second = factRow(secondFactId, secondEvidenceId, "BigCommerce");
    const repo = new MemoryFactRepository([first, second], [firstEvidence, secondEvidence]);

    try {
      expect(await validateCandidateCompanyFactForRun(companyId, factId, researchRunId, repo, now))
        .toMatchObject({ status: "conflicted" });
      expect([first.status, second.status]).toEqual(["conflicted", "conflicted"]);
    } finally { vi.unstubAllEnvs(); }
  });

  it("rejects a company-size candidate created from a founding year", async () => {
    const storedBombasStyleEvidence = evidence(
      evidenceId,
      "Bombas was founded in 2013. Founded: 2013  Employees: 250+  Industry: E-commerce  Location: New York, NY",
    );
    const foundingYearCandidate = factRow(
      factId,
      evidenceId,
      2013,
      "candidate",
      "2026-10-06T10:00:00.000Z",
      companyId,
      "company_size",
    );
    const repo = new MemoryFactRepository([foundingYearCandidate], [storedBombasStyleEvidence]);

    expect(await validateCandidateCompanyFact(companyId, factId, repo, now)).toMatchObject({ status: "rejected" });
    expect(foundingYearCandidate.status).toBe("rejected");
  });

  it("rejects a platform candidate supported only by historical migration language", async () => {
    const historicalEvidence = evidence(
      evidenceId,
      "Bombas, the mission-driven sock brand, saved $108,000 a year after migrating to Shopify Plus.",
    );
    const historicalPlatformCandidate = factRow(factId, evidenceId, "Shopify Plus");
    const repo = new MemoryFactRepository([historicalPlatformCandidate], [historicalEvidence]);

    expect(await validateCandidateCompanyFact(companyId, factId, repo, now)).toMatchObject({ status: "rejected" });
    expect(historicalPlatformCandidate.status).toBe("rejected");
  });

  it("accepts an explicit exact employee count listed under Employees / Now", async () => {
    const linkedInStyleEvidence = evidence(evidenceId, "Bombas: Jobs\n## Employees\n- Now: 296");
    const explicitEmployeeCount = factRow(
      factId,
      evidenceId,
      296,
      "candidate",
      "2026-10-06T10:00:00.000Z",
      companyId,
      "company_size",
    );
    const repo = new MemoryFactRepository([explicitEmployeeCount], [linkedInStyleEvidence]);

    expect(await validateCandidateCompanyFact(companyId, factId, repo, now)).toMatchObject({ status: "accepted" });
    expect(explicitEmployeeCount).toMatchObject({ status: "accepted", value_jsonb: 296, source_evidence_id: evidenceId });
  });
});
