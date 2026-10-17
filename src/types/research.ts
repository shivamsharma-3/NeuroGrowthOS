import type { z } from "zod";
import type {
  CompanyEvidenceSchema,
  CompanyFactSchema,
  CompanyGrowthSignalSchema,
  CompanyResearchRunSchema,
  ResearchFactValueSchema,
} from "@/lib/research/schemas";

export type ResearchRunStatus = "queued" | "running" | "completed" | "failed" | "cancelled";
export type EvidenceSourceType =
  | "official_website"
  | "search_result"
  | "user_provided"
  | "third_party"
  | "platform_detection"
  | "other";
export type ResearchRecordStatus = "candidate" | "accepted" | "rejected" | "conflicted" | "stale";
export type CompanyFactKey = "industry" | "geography" | "company_size" | "revenue" | "platform";
export type CompanyGrowthSignalType =
  | "recent_funding"
  | "relevant_hiring"
  | "market_expansion"
  | "verified_growth"
  | "verified_contraction";

export type ResearchFactValue = z.infer<typeof ResearchFactValueSchema>;
export type CompanyFact = z.infer<typeof CompanyFactSchema>;
export type CompanyEvidence = z.infer<typeof CompanyEvidenceSchema>;
export type CompanyGrowthSignal = z.infer<typeof CompanyGrowthSignalSchema>;
export type CompanyResearchRun = z.infer<typeof CompanyResearchRunSchema>;
