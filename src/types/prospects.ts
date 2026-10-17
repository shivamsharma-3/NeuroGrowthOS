export const PROSPECT_STATUSES = [
  "new",
  "researching",
  "qualified",
  "contacted",
  "in_progress",
  "converted",
  "disqualified",
] as const;

export type ProspectStatus = (typeof PROSPECT_STATUSES)[number];
export type RevenuePeriod = "annual" | "quarterly" | "monthly" | "lifetime" | "unknown";
export type IcpFactorStatus = "strong" | "partial" | "poor" | "unknown";
export type IcpPriority = "high" | "medium" | "low" | "insufficient_data";
export type IcpScoringStatus = "unscored" | "scored" | "insufficient_data";

export interface Prospect {
  id: string;
  company_id: string;
  contact_id: string | null;
  current_score_run_id?: string | null;
  icp_score: number | null;
  icp_reason: string | null;
  icp_score_version: string | null;
  icp_scored_at: string | null;
  icp_coverage: number | null;
  icp_scoring_status: IcpScoringStatus;
  status: ProspectStatus;
  source: string;
  created_at: string;
  updated_at: string;
  company: {
    id: string;
    name: string;
    website: string | null;
    domain: string | null;
    industry: string | null;
    country: string | null;
    estimated_revenue: number | null;
    revenue_amount: number | null;
    revenue_currency: string | null;
    revenue_period: RevenuePeriod | null;
    revenue_source: string | null;
    revenue_observed_at: string | null;
    employee_count: number | null;
    platform: string | null;
    linkedin_url: string | null;
  };
  contact: {
    id: string;
    first_name: string | null;
    last_name: string | null;
    email: string | null;
    job_title: string | null;
  } | null;
}

export interface ProspectInput {
  company: {
    name: string;
    website: string | null;
    domain: string | null;
    industry: string | null;
    country: string | null;
    estimated_revenue: number | null;
    revenue_amount: number | null;
    revenue_currency: string | null;
    revenue_period: RevenuePeriod | null;
    revenue_source: string | null;
    revenue_observed_at: string | null;
    employee_count: number | null;
    platform: string | null;
    linkedin_url: string | null;
  };
  contact: {
    first_name: string | null;
    last_name: string | null;
    email: string | null;
    job_title: string | null;
    linkedin_url: string | null;
  } | null;
  status?: ProspectStatus;
  source?: string;
}

export interface CsvRow extends Record<string, string> {
  company_name: string;
  website: string;
  industry: string;
  country: string;
  estimated_revenue: string;
  revenue_amount: string;
  revenue_currency: string;
  revenue_period: string;
  revenue_source: string;
  revenue_observed_at: string;
  employee_count: string;
  platform: string;
  linkedin_url: string;
  first_name: string;
  last_name: string;
  email: string;
  job_title: string;
  contact_linkedin_url: string;
}
