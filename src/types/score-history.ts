import type { IcpFactorStatus, IcpPriority, IcpScoringStatus } from "@/types/prospects";

export interface ScoreFactor {
  id: string;
  score_run_id: string;
  factor_key: string;
  score: number | null;
  max_score: number;
  status: IcpFactorStatus;
  reason: string;
  created_at: string;
}

export interface ScoreRun {
  id: string;
  prospect_id: string;
  score_version: string;
  total_score: number | null;
  priority: IcpPriority;
  coverage: number;
  scoring_status: IcpScoringStatus;
  scored_at: string;
  created_at: string;
  factors?: ScoreFactor[];
}

/** Shape returned by GET /api/prospects/:id/score */
export interface CurrentScoreResponse {
  score_run_id: string;
  score_version: string;
  total_score: number | null;
  priority: IcpPriority;
  coverage: number;
  scoring_status: IcpScoringStatus;
  scored_at: string;
  factors: ScoreFactor[];
}

/** Shape returned by GET /api/prospects/:id/score/history (each item) */
export interface ScoreHistoryItem {
  run_id: string;
  score_version: string;
  total_score: number | null;
  priority: IcpPriority;
  coverage: number;
  scoring_status: IcpScoringStatus;
  scored_at: string;
}
