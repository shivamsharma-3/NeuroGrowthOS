import { describe, expect, it, vi } from "vitest";
vi.mock("server-only", () => ({}));

import { adaptAcceptedGrowthSignals, attachIcpGrowthSignalProvenance } from "@/lib/icp/research-adapter";
import { scoreIcp } from "@/lib/icp/scorer";
import type { IcpCompanyInput } from "@/types/icp";

const companyId = "4fda1d3f-569d-491d-99ec-f42803b42b3d";
const sourceId = "da054407-5e28-49b6-aceb-0284df07c8ff";
const acceptedId = "ba054407-5e28-49b6-aceb-0284df07c8ff";
const asOf = new Date("2026-10-10T12:00:00.000Z");
const input: IcpCompanyInput = {
  revenue: { amount: null, currency: null, period: null, source: null, observedAt: null },
  industry: null, platform: null, country: null, employeeCount: null, growthSignals: null,
};

function evidence(status = "candidate") {
  return {
    id: sourceId, company_id: companyId, research_run_id: "aa054407-5e28-49b6-aceb-0284df07c8ff",
    source_type: "official_website", source_name: "Official website", source_url: "https://bombas.com/news",
    observed_at: "2026-10-10T10:00:00.000Z", retrieved_at: "2026-10-10T10:00:00.000Z",
    excerpt: "Bombas announced a verified funding event.", content_hash: "fixture", confidence: 0.8,
    status, created_at: "2026-10-10T10:00:00.000Z",
  };
}

function signal(status = "accepted", overrides: Record<string, unknown> = {}) {
  return {
    id: acceptedId, company_id: companyId, signal_type: "recent_funding", observed_at: "2026-10-01T00:00:00.000Z",
    confidence: 0.8, status, evidence_id: sourceId, summary: "Bombas raised Series B funding on October 1, 2026.",
    valid_until: null, created_at: "2026-10-10T10:00:00.000Z", ...overrides,
  };
}

describe("growth signal database-to-scorer integration", () => {
  it("scores only accepted eligible signals and attaches signal/evidence provenance", () => {
    const adapted = adaptAcceptedGrowthSignals(input, [
      signal("accepted"),
      signal("candidate", { id: "ca054407-5e28-49b6-aceb-0284df07c8ff", signal_type: "relevant_hiring" }),
      signal("stale", { id: "cb054407-5e28-49b6-aceb-0284df07c8ff", signal_type: "market_expansion" }),
      signal("conflicted", { id: "cc054407-5e28-49b6-aceb-0284df07c8ff", signal_type: "verified_growth" }),
    ], [evidence()], "2026-10-10T10:00:00.000Z", asOf, companyId);
    expect(adapted.input.growthSignals?.signals).toEqual([
      { type: "recent_funding", observedAt: "2026-10-01T00:00:00.000Z", confidence: 0.8 },
    ]);
    const score = attachIcpGrowthSignalProvenance(scoreIcp(adapted.input, asOf), adapted.provenance);
    expect(score.factors.growth_signal.score).toBe(5);
    expect(score.factors.growth_signal.evidence).toMatchObject({ sourceSignalIds: acceptedId, sourceEvidenceIds: sourceId });
    expect(score.factors.growth_signal.reason).toContain(sourceId);
  });

  it("fails closed for stale evidence and conflicting signal rows", () => {
    const accepted = signal();
    const conflict = signal("conflicted", {
      id: "ca054407-5e28-49b6-aceb-0284df07c8ff", summary: "Bombas raised Series C funding on October 1, 2026.",
    });
    const adapted = adaptAcceptedGrowthSignals(input, [accepted, conflict], [evidence("conflicted")], "2026-10-10T10:00:00.000Z", asOf, companyId);
    expect(adapted.input.growthSignals?.signals).toEqual([]);
    expect(adapted.provenance).toEqual([]);
    expect(scoreIcp(adapted.input, asOf).factors.growth_signal.score).toBe(8);
  });

  it("does not turn missing or unsupported signals into facts or signals", () => {
    const adapted = adaptAcceptedGrowthSignals(input, [signal("candidate")], [evidence()], null, asOf, companyId);
    expect(adapted.input.growthSignals).toBeNull();
    expect(scoreIcp(adapted.input, asOf).factors.growth_signal.status).toBe("unknown");
  });
});
