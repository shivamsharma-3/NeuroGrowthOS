import { afterEach, describe, expect, it, vi } from "vitest";
vi.mock("server-only", () => ({}));

import { extractCandidateGrowthSignals } from "@/lib/research/growth-signals";
import { validateCandidateGrowthSignalForRun, type GrowthSignalValidationRepository } from "@/lib/research/growth-signal-validation";

const companyId = "4fda1d3f-569d-491d-99ec-f42803b42b3d";
const runId = "aa054407-5e28-49b6-aceb-0284df07c8ff";
const evidenceId = "da054407-5e28-49b6-aceb-0284df07c8ff";
const signalId = "ba054407-5e28-49b6-aceb-0284df07c8ff";
const now = new Date("2026-10-10T12:00:00.000Z");
const identity = { name: "Bombas", domain: "bombas.com", website: "https://bombas.com" };

function evidence(text: string, overrides: Record<string, unknown> = {}) {
  return {
    id: evidenceId, company_id: companyId, research_run_id: runId, source_type: "official_website",
    source_name: "Official website", source_url: "https://bombas.com/news", observed_at: "2026-10-10T10:00:00.000Z",
    retrieved_at: "2026-10-10T10:00:00.000Z", excerpt: JSON.stringify({ pageTitle: "Bombas News", readableTextExcerpt: text }),
    content_hash: "testhash", confidence: 0.8, status: "candidate", created_at: "2026-10-10T10:00:00.000Z", ...overrides,
  };
}

function signal(summary: string, observedAt = "2026-09-14T00:00:00.000Z", overrides: Record<string, unknown> = {}) {
  return {
    id: signalId, company_id: companyId, signal_type: "recent_funding", observed_at: observedAt,
    confidence: 0.8, status: "candidate", evidence_id: evidenceId, summary, valid_until: null,
    created_at: "2026-10-10T10:00:00.000Z", ...overrides,
  };
}

function repository(signals: Record<string, unknown>[], evidenceRows: Record<string, unknown>[]): GrowthSignalValidationRepository {
  return {
    async getCompanyIdentity() { return identity; },
    async listSignals() { return signals; },
    async listEvidence() { return evidenceRows; },
    async updateSignal(_company, id, expected, patch) {
      const row = signals.find((item) => item.id === id && item.status === expected);
      if (!row) return false;
      Object.assign(row, patch);
      return true;
    },
  };
}

describe("growth-signal extraction and validation", () => {
  afterEach(() => vi.unstubAllEnvs());

  it("extracts and accepts an explicit recent funding event using its event date", async () => {
    const source = evidence("Bombas raised Series B funding on September 14, 2026.");
    const [candidate] = extractCandidateGrowthSignals(source, identity, now);
    expect(candidate).toMatchObject({ signal_type: "recent_funding", observed_at: "2026-09-14T00:00:00.000Z", status: "candidate", evidence_id: evidenceId });
    const stored = signal(candidate.summary, candidate.observed_at);
    const result = await validateCandidateGrowthSignalForRun(companyId, signalId, runId, [evidenceId], repository([stored], [source]), now);
    expect(result.status).toBe("accepted");
    expect(stored.status).toBe("accepted");
  });

  it("marks old events stale based on event date, regardless of recent retrieval", async () => {
    const source = evidence("Bombas revenue grew 20% on January 2, 2025.");
    const [candidate] = extractCandidateGrowthSignals(source, identity, now);
    expect(candidate.signal_type).toBe("verified_growth");
    const stored = { ...signal(candidate.summary, candidate.observed_at), signal_type: "verified_growth" };
    const result = await validateCandidateGrowthSignalForRun(companyId, signalId, runId, [evidenceId], repository([stored], [source]), now);
    expect(result.status).toBe("stale");
    expect(stored.status).toBe("stale");
  });

  it("does not extract untrusted sources or company identity mismatches", () => {
    vi.stubEnv("GROWTHOS_TRUSTED_RESEARCH_DOMAINS", "linkedin.com");
    const claim = "Bombas raised Series B funding on September 14, 2026.";
    expect(extractCandidateGrowthSignals(evidence(claim, {
      source_type: "search_result", source_url: "https://untrusted.example/bombas", source_name: "untrusted.example",
    }), identity, now)).toEqual([]);
    expect(extractCandidateGrowthSignals(evidence("Acme raised Series B funding on September 14, 2026.", {
      excerpt: JSON.stringify({ pageTitle: "Acme company profile", readableTextExcerpt: "Acme raised Series B funding on September 14, 2026." }),
    }), identity, now)).toEqual([]);
  });

  it("accepts a trusted third-party source only when configured and company identity matches", async () => {
    vi.stubEnv("GROWTHOS_TRUSTED_RESEARCH_DOMAINS", "linkedin.com");
    const source = evidence("Bombas raised Series B funding on September 14, 2026.", {
      source_type: "search_result", source_name: "linkedin.com", source_url: "https://www.linkedin.com/company/bombas/",
      confidence: 0.7,
    });
    const [candidate] = extractCandidateGrowthSignals(source, identity, now);
    expect(candidate).toBeDefined();
    const stored = signal(candidate.summary, candidate.observed_at, { confidence: 0.7 });
    const result = await validateCandidateGrowthSignalForRun(companyId, signalId, runId, [evidenceId], repository([stored], [source]), now);
    expect(result.status).toBe("accepted");
  });

  it("rejects reused evidence from an earlier research run without promoting it", async () => {
    const source = evidence("Bombas raised Series B funding on September 14, 2026.", { research_run_id: "fa054407-5e28-49b6-aceb-0284df07c8ff" });
    const stored = signal("Bombas raised Series B funding on September 14, 2026.");
    const result = await validateCandidateGrowthSignalForRun(companyId, signalId, runId, [evidenceId], repository([stored], [source]), now);
    expect(result.status).toBe("rejected");
    expect(stored.status).toBe("candidate");
  });

  it("marks conflicting same-date claims as conflicted rather than selecting one", async () => {
    const source = evidence("Bombas raised Series B funding on September 14, 2026.");
    const current = signal("Bombas raised Series B funding on September 14, 2026.");
    const prior = { ...signal("Bombas raised Series C funding on September 14, 2026.", current.observed_at, {
      id: "ca054407-5e28-49b6-aceb-0284df07c8ff", status: "accepted",
    }) };
    const result = await validateCandidateGrowthSignalForRun(companyId, signalId, runId, [evidenceId], repository([current, prior], [source]), now);
    expect(result.status).toBe("conflicted");
    expect(current.status).toBe("conflicted");
    expect(prior.status).toBe("conflicted");
  });

  it("requires explicit event dates and ignores undated growth claims", () => {
    expect(extractCandidateGrowthSignals(evidence("Bombas revenue grew 20% year over year."), identity, now)).toEqual([]);
    expect(extractCandidateGrowthSignals(evidence("Bombas is hiring a growth marketing manager."), identity, now)).toEqual([]);
  });

  it("recognizes explicit recent hiring, market expansion, verified growth, and contraction events", () => {
    const source = evidence([
      "Bombas is hiring a growth marketing manager on October 1, 2026.",
      "Bombas expanded into the Canadian market on September 20, 2026.",
      "Bombas revenue grew 20% on September 10, 2026.",
      "Bombas sales declined 12% on September 5, 2026.",
    ].join(" "));
    expect(extractCandidateGrowthSignals(source, identity, now).map(({ signal_type }) => signal_type)).toEqual([
      "relevant_hiring", "market_expansion", "verified_growth", "verified_contraction",
    ]);
  });
});
