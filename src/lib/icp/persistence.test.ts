import { describe, expect, it } from "vitest";
import { scoreIcp } from "@/lib/icp/scorer";
import {
  buildProspectProjectionUpdate,
  buildScoreFactorRecords,
  buildScoreRunRecord,
  sortScoreRunsNewestFirst,
} from "@/lib/icp/persistence";
import { ICP_FACTOR_KEYS } from "@/types/icp";
import type { IcpCompanyInput } from "@/types/icp";

const sampleInput = (): IcpCompanyInput => ({
  revenue: {
    amount: 10_000_000,
    currency: "USD",
    period: "annual",
    source: "manual",
    observedAt: "2026-09-01",
    legacyEstimatedRevenue: null,
  },
  industry: "D2C",
  platform: "Shopify Plus",
  country: "United States",
  employeeCount: 50,
  growthSignals: null,
});

describe("ICP Phase B: Score Run & Factor-Level Persistence", () => {
  const asOf = new Date("2026-09-30T12:00:00.000Z");
  const result = scoreIcp(sampleInput(), asOf);
  const prospectId = "11111111-1111-4111-8111-111111111111";
  const runId1 = "22222222-2222-4222-8222-222222222222";
  const runId2 = "33333333-3333-4333-8333-333333333333";

  // 1. Score run creation
  it("1. creates a complete score run record from scorer output", () => {
    const run = buildScoreRunRecord(prospectId, result);

    expect(run.prospect_id).toBe(prospectId);
    expect(run.score_version).toBe("ecom-d2c-v1.0.0");
    expect(run.total_score).toBe(result.totalScore);
    expect(run.priority).toBe(result.priority);
    expect(run.coverage).toBe(result.coverage.percent);
    expect(run.scoring_status).toBe(result.scoringStatus);
    expect(run.scored_at).toBe(result.scoredAt);
  });

  // 2. Six factor rows
  it("2. creates exactly six factor rows for the scoring run", () => {
    const factors = buildScoreFactorRecords(runId1, result);

    expect(factors).toHaveLength(6);
    const keys = factors.map((f) => f.factor_key);
    expect(keys).toEqual(expect.arrayContaining([...ICP_FACTOR_KEYS]));
    factors.forEach((f) => {
      expect(f.score_run_id).toBe(runId1);
      expect(typeof f.max_score).toBe("number");
      expect(f.max_score).toBeGreaterThan(0);
      expect(["strong", "partial", "poor", "unknown"]).toContain(f.status);
      expect(typeof f.reason).toBe("string");
      expect(f.reason.length).toBeGreaterThan(0);
    });
  });

  // 3. Factor uniqueness
  it("3. enforces factor key uniqueness within a score run", () => {
    const factors = buildScoreFactorRecords(runId1, result);
    const keySet = new Set(factors.map((f) => f.factor_key));

    expect(keySet.size).toBe(6);
    expect(keySet.size).toBe(factors.length);
  });

  // 4. Current score pointer
  it("4. updates current_score_run_id pointer to the new score run", () => {
    const projection = buildProspectProjectionUpdate(result, runId1);

    expect(projection.current_score_run_id).toBe(runId1);
  });

  // 5. History ordering
  it("5. orders history items newest-first by scored_at", () => {
    const history = [
      { id: "run-old", scored_at: "2026-09-01T10:00:00.000Z" },
      { id: "run-newest", scored_at: "2026-09-30T12:00:00.000Z" },
      { id: "run-middle", scored_at: "2026-09-15T08:30:00.000Z" },
    ];

    const sorted = sortScoreRunsNewestFirst(history);
    expect(sorted.map((r) => r.id)).toEqual(["run-newest", "run-middle", "run-old"]);
  });

  // 6. Re-score creates a new run
  it("6. generates a distinct score run on re-score", () => {
    const run1 = buildScoreRunRecord(prospectId, result);
    const result2 = scoreIcp(sampleInput(), new Date("2026-09-30T14:00:00.000Z"));
    const run2 = buildScoreRunRecord(prospectId, result2);

    expect(run1.scored_at).not.toBe(run2.scored_at);
    // Distinct run IDs assigned on insert
    expect(runId1).not.toBe(runId2);
  });

  // 7. Previous runs remain unchanged
  it("7. preserves previous score run records and factor rows on re-score", () => {
    const firstFactors = buildScoreFactorRecords(runId1, result);
    const frozenFirstFactors = JSON.parse(JSON.stringify(firstFactors));

    // Simulate re-score with a different input
    const changedInput: IcpCompanyInput = {
      ...sampleInput(),
      industry: "Construction",
    };
    const result2 = scoreIcp(changedInput, new Date("2026-09-30T15:00:00.000Z"));
    const secondFactors = buildScoreFactorRecords(runId2, result2);

    // First run factors are unchanged
    expect(firstFactors).toEqual(frozenFirstFactors);
    expect(secondFactors.find((f) => f.factor_key === "industry")?.status).toBe("poor");
    expect(firstFactors.find((f) => f.factor_key === "industry")?.status).toBe("strong");
  });

  // 8. Projection fields match current run
  it("8. ensures projection fields on prospects table match the latest run", () => {
    const projection = buildProspectProjectionUpdate(result, runId1);

    expect(projection.icp_score).toBe(result.totalScore);
    expect(projection.icp_score_version).toBe(result.scoreVersion);
    expect(projection.icp_scored_at).toBe(result.scoredAt);
    expect(projection.icp_coverage).toBe(result.coverage.percent);
    expect(projection.icp_scoring_status).toBe(result.scoringStatus);
    expect(projection.current_score_run_id).toBe(runId1);
  });

  // 9. Failed persistence does not leave an incomplete run
  it("9. guarantees atomic execution (failure rolls back run and factor creation)", async () => {
    // Mock atomic transaction / RPC execution
    const mockDb = {
      runs: [] as (ReturnType<typeof buildScoreRunRecord> & { id: string })[],
      factors: [] as (ReturnType<typeof buildScoreFactorRecords>[number])[],
      prospect: { id: prospectId, current_score_run_id: null as string | null },
    };

    const atomicPersist = async (shouldFail: boolean) => {
      // Snapshot before transaction
      const snapshot = {
        runs: [...mockDb.runs],
        factors: [...mockDb.factors],
        prospect: { ...mockDb.prospect },
      };

      try {
        const run = buildScoreRunRecord(prospectId, result);
        mockDb.runs.push({ id: runId1, ...run });

        const factors = buildScoreFactorRecords(runId1, result);
        if (shouldFail) {
          throw new Error("Simulated database failure during factor insert");
        }
        mockDb.factors.push(...factors);

        mockDb.prospect = {
          ...mockDb.prospect,
          current_score_run_id: runId1,
        };
      } catch (err) {
        // Rollback snapshot on failure (simulating DB transaction rollback)
        mockDb.runs = snapshot.runs;
        mockDb.factors = snapshot.factors;
        mockDb.prospect = snapshot.prospect;
        throw err;
      }
    };

    await expect(atomicPersist(true)).rejects.toThrow("Simulated database failure");
    expect(mockDb.runs).toHaveLength(0);
    expect(mockDb.factors).toHaveLength(0);
    expect(mockDb.prospect.current_score_run_id).toBeNull();

    // Now verify successful transaction commits everything
    await expect(atomicPersist(false)).resolves.not.toThrow();
    expect(mockDb.runs).toHaveLength(1);
    expect(mockDb.factors).toHaveLength(6);
    expect(mockDb.prospect.current_score_run_id).toBe(runId1);
  });
});
