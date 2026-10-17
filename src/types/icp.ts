import type { IcpFactorStatus, IcpPriority, IcpScoringStatus, RevenuePeriod } from "@/types/prospects";

export const ICP_FACTOR_KEYS = ["revenue", "industry", "platform", "geography", "company_size", "growth_signal"] as const;
export type IcpFactorKey = (typeof ICP_FACTOR_KEYS)[number];

export interface RevenueEvidence {
  amount: number | null;
  currency: string | null;
  period: RevenuePeriod | null;
  source: string | null;
  observedAt: string | null;
  legacyEstimatedRevenue?: number | null;
}

export interface GrowthSignal {
  type: "recent_funding" | "relevant_hiring" | "market_expansion" | "verified_growth" | "verified_contraction";
  observedAt: string;
  confidence: number;
}

export interface GrowthSignalEvidence {
  researchedAt: string;
  signals: GrowthSignal[];
}

export interface IcpCompanyInput {
  revenue: RevenueEvidence;
  industry: string | null;
  platform: string | null;
  country: string | null;
  employeeCount: number | null;
  growthSignals: GrowthSignalEvidence | null;
}

export interface IcpFactorResult {
  score: number | null;
  maxScore: number;
  status: IcpFactorStatus;
  reason: string;
  evidence: Record<string, string | number | null>;
}

export interface IcpCoverage {
  assessedWeight: number;
  totalWeight: number;
  percent: number;
}

export interface IcpScoreResult {
  totalScore: number | null;
  priority: IcpPriority;
  scoringStatus: IcpScoringStatus;
  scoreVersion: string;
  scoredAt: string;
  coverage: IcpCoverage;
  factors: Record<IcpFactorKey, IcpFactorResult>;
}
