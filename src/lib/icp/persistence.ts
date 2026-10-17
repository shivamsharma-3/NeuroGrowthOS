import { ICP_FACTOR_KEYS } from "@/types/icp";
import type { IcpFactorKey, IcpScoreResult } from "@/types/icp";

export interface ScoreRunInsertPayload {
  prospect_id: string;
  score_version: string;
  total_score: number | null;
  priority: string;
  coverage: number;
  scoring_status: string;
  scored_at: string;
}

export interface ScoreFactorInsertPayload {
  score_run_id: string;
  factor_key: IcpFactorKey;
  score: number | null;
  max_score: number;
  status: string;
  reason: string;
}

export interface ProspectProjectionUpdate {
  icp_score: number | null;
  icp_reason: string;
  icp_score_version: string;
  icp_scored_at: string;
  icp_coverage: number;
  icp_scoring_status: string;
  current_score_run_id: string;
}

/**
 * Builds the database row payload for a single score run.
 */
export function buildScoreRunRecord(prospectId: string, result: IcpScoreResult): ScoreRunInsertPayload {
  return {
    prospect_id: prospectId,
    score_version: result.scoreVersion,
    total_score: result.totalScore,
    priority: result.priority,
    coverage: result.coverage.percent,
    scoring_status: result.scoringStatus,
    scored_at: result.scoredAt,
  };
}

/**
 * Builds exactly 6 factor records for a score run, enforcing the 6 factor keys.
 */
export function buildScoreFactorRecords(runId: string, result: IcpScoreResult): ScoreFactorInsertPayload[] {
  return ICP_FACTOR_KEYS.map((key) => {
    const factor = result.factors[key];
    return {
      score_run_id: runId,
      factor_key: key,
      score: factor.score,
      max_score: factor.maxScore,
      status: factor.status,
      reason: factor.reason,
    };
  });
}

/**
 * Formats the human-readable summary string stored in prospects.icp_reason.
 */
export function formatIcpReason(result: IcpScoreResult): string {
  return Object.entries(result.factors)
    .map(([key, factor]) => `${key}: ${factor.score ?? "unknown"}/${factor.maxScore} — ${factor.reason}`)
    .join("\n");
}

/**
 * Builds the projection update payload for the prospects table.
 */
export function buildProspectProjectionUpdate(
  result: IcpScoreResult,
  runId: string,
): ProspectProjectionUpdate {
  return {
    icp_score: result.totalScore,
    icp_reason: formatIcpReason(result),
    icp_score_version: result.scoreVersion,
    icp_scored_at: result.scoredAt,
    icp_coverage: result.coverage.percent,
    icp_scoring_status: result.scoringStatus,
    current_score_run_id: runId,
  };
}

/**
 * Sorts score runs newest-first (descending by scored_at, fallback created_at).
 */
export function sortScoreRunsNewestFirst<T extends { scored_at: string }>(runs: T[]): T[] {
  return [...runs].sort((a, b) => new Date(b.scored_at).getTime() - new Date(a.scored_at).getTime());
}
