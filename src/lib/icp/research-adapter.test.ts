import { describe, expect, it } from "vitest";
import { scoreIcp } from "@/lib/icp/scorer";
import { adaptAcceptedResearchFacts, attachIcpResearchProvenance } from "@/lib/icp/research-adapter";
import type { IcpCompanyInput } from "@/types/icp";

const companyId = "af2b7bb2-21cc-46f2-97c3-b83bfdc990a2";
const asOf = new Date("2026-10-06T12:00:00.000Z");
const canonical = (): IcpCompanyInput => ({
  revenue: { amount: null, currency: null, period: null, source: null, observedAt: null, legacyEstimatedRevenue: null },
  industry: null,
  platform: null,
  country: null,
  employeeCount: null,
  growthSignals: null,
});

function evidence(id: string, statement: string, status = "candidate") {
  return {
    id,
    company_id: companyId,
    research_run_id: "ccddeeff-21cc-46f2-97c3-b83bfdc990a2",
    source_type: "official_website",
    source_name: "Official website",
    source_url: "https://example.com/about",
    observed_at: "2026-10-06T10:00:00.000Z",
    retrieved_at: "2026-10-06T10:00:00.000Z",
    excerpt: JSON.stringify({ readableTextExcerpt: statement }),
    content_hash: id,
    confidence: 0.7,
    status,
    created_at: "2026-10-06T10:00:00.000Z",
  };
}

function fact(id: string, key: string, value: unknown, evidenceId: string, status = "accepted", validUntil: string | null = null) {
  return {
    id,
    company_id: companyId,
    fact_key: key,
    value_jsonb: value,
    status,
    confidence: 0.7,
    source_evidence_id: evidenceId,
    observed_at: "2026-10-06T10:00:00.000Z",
    valid_until: validUntil,
    created_at: "2026-10-06T10:00:00.000Z",
  };
}

describe("accepted research fact scoring adapter", () => {
  it("maps accepted facts to the matching deterministic factors and preserves provenance", () => {
    const facts = [
      fact("10000000-0000-4000-8000-000000000001", "industry", "D2C", "20000000-0000-4000-8000-000000000001"),
      fact("10000000-0000-4000-8000-000000000002", "platform", "Shopify Plus", "20000000-0000-4000-8000-000000000002"),
      fact("10000000-0000-4000-8000-000000000003", "geography", "United States", "20000000-0000-4000-8000-000000000003"),
      fact("10000000-0000-4000-8000-000000000004", "company_size", 50, "20000000-0000-4000-8000-000000000004"),
      fact("10000000-0000-4000-8000-000000000005", "revenue", { amount: 10_000_000, currency: "USD", period: "annual" }, "20000000-0000-4000-8000-000000000005"),
    ];
    const evidenceRows = [
      evidence("20000000-0000-4000-8000-000000000001", "Industry: D2C"),
      evidence("20000000-0000-4000-8000-000000000002", "Platform: Shopify Plus"),
      evidence("20000000-0000-4000-8000-000000000003", "Country: United States"),
      evidence("20000000-0000-4000-8000-000000000004", "Company size: 50 employees"),
      evidence("20000000-0000-4000-8000-000000000005", "Annual revenue of USD 10 million."),
    ];

    const adapted = adaptAcceptedResearchFacts(canonical(), facts, evidenceRows, asOf, companyId);
    const scored = attachIcpResearchProvenance(scoreIcp(adapted.input, asOf), adapted.provenance);

    expect(scored.factors.industry.score).toBe(20);
    expect(scored.factors.platform.score).toBe(15);
    expect(scored.factors.geography.score).toBe(10);
    expect(scored.factors.company_size.score).toBe(10);
    expect(scored.factors.revenue.score).toBe(25);
    expect(scored.factors.platform.evidence).toMatchObject({
      sourceFactId: facts[1].id,
      sourceEvidenceId: facts[1].source_evidence_id,
    });
    expect(scored.factors.platform.reason).toContain(facts[1].source_evidence_id);
  });

  it.each(["candidate", "stale", "conflicted", "rejected"])("ignores facts with status %s", (status) => {
    const factRow = fact("10000000-0000-4000-8000-000000000001", "platform", "Shopify", "20000000-0000-4000-8000-000000000001", status);
    const adapted = adaptAcceptedResearchFacts(canonical(), [factRow], [evidence(factRow.source_evidence_id, "Platform: Shopify")], asOf, companyId);

    expect(adapted.input.platform).toBeNull();
    expect(adapted.provenance.platform).toBeUndefined();
  });

  it("ignores accepted facts with stale evidence or an expired validity period", () => {
    const staleEvidenceFact = fact("10000000-0000-4000-8000-000000000001", "industry", "D2C", "20000000-0000-4000-8000-000000000001");
    const expiredFact = fact("10000000-0000-4000-8000-000000000002", "platform", "Shopify", "20000000-0000-4000-8000-000000000002", "accepted", "2026-10-06T11:00:00.000Z");
    const adapted = adaptAcceptedResearchFacts(canonical(), [staleEvidenceFact, expiredFact], [
      evidence(staleEvidenceFact.source_evidence_id, "Industry: D2C", "stale"),
      evidence(expiredFact.source_evidence_id, "Platform: Shopify"),
    ], asOf, companyId);

    expect(adapted.input.industry).toBeNull();
    expect(adapted.input.platform).toBeNull();
  });

  it("keeps insufficient-data behavior when accepted facts are missing", () => {
    const result = scoreIcp(adaptAcceptedResearchFacts(canonical(), [], [], asOf, companyId).input, asOf);
    expect(result.totalScore).toBeNull();
    expect(result.priority).toBe("insufficient_data");
    expect(result.scoringStatus).toBe("insufficient_data");
    expect(result.coverage.percent).toBe(0);
  });

  it("leaves existing scoring unchanged when no accepted research facts exist", () => {
    const base = canonical();
    expect(scoreIcp(adaptAcceptedResearchFacts(base, [], [], asOf, companyId).input, asOf)).toEqual(scoreIcp(base, asOf));
  });

  it("is deterministic for the same accepted facts and timestamp", () => {
    const factRow = fact("10000000-0000-4000-8000-000000000001", "platform", "Shopify Plus", "20000000-0000-4000-8000-000000000001");
    const evidenceRow = evidence(factRow.source_evidence_id, "Platform: Shopify Plus");
    const run = () => {
      const adapted = adaptAcceptedResearchFacts(canonical(), [factRow], [evidenceRow], asOf, companyId);
      return attachIcpResearchProvenance(scoreIcp(adapted.input, asOf), adapted.provenance);
    };
    expect(run()).toEqual(run());
  });

  it("fails closed when database rows contain conflicting accepted values for a factor", () => {
    const shopify = fact("10000000-0000-4000-8000-000000000001", "platform", "Shopify", "20000000-0000-4000-8000-000000000001");
    const commerce = fact("10000000-0000-4000-8000-000000000002", "platform", "BigCommerce", "20000000-0000-4000-8000-000000000002");
    const adapted = adaptAcceptedResearchFacts(canonical(), [shopify, commerce], [
      evidence(shopify.source_evidence_id, "Platform: Shopify"),
      evidence(commerce.source_evidence_id, "Platform: BigCommerce"),
    ], asOf, companyId);
    expect(adapted.input.platform).toBeNull();
    expect(adapted.provenance.platform).toBeUndefined();
  });
});
