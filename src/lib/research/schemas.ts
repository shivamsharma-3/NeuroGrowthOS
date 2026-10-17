import { z } from "zod";

export const ResearchRunStatusSchema = z.enum(["queued", "running", "completed", "failed", "cancelled"]);
export const EvidenceSourceTypeSchema = z.enum([
  "official_website",
  "search_result",
  "user_provided",
  "third_party",
  "platform_detection",
  "other",
]);
export const ResearchRecordStatusSchema = z.enum(["candidate", "accepted", "rejected", "conflicted", "stale"]);
export const CompanyFactKeySchema = z.enum(["industry", "geography", "company_size", "revenue", "platform"]);
export const CompanyGrowthSignalTypeSchema = z.enum([
  "recent_funding",
  "relevant_hiring",
  "market_expansion",
  "verified_growth",
  "verified_contraction",
]);

const UuidSchema = z.string().uuid();
const TimestampSchema = z.string().datetime({ offset: true });
const ConfidenceSchema = z.number().min(0).max(1);

export const RevenueFactValueSchema = z.object({
  amount: z.number().nonnegative(),
  currency: z.string().regex(/^[A-Z]{3}$/),
  period: z.enum(["annual", "quarterly", "monthly", "lifetime", "unknown"]),
});

export const ResearchFactValueSchema = z.union([
  z.string().trim().min(1),
  z.number().int().nonnegative(),
  RevenueFactValueSchema,
]);

export const CompanyResearchRunSchema = z.object({
  id: UuidSchema,
  company_id: UuidSchema,
  status: ResearchRunStatusSchema,
  provider: z.string().nullable(),
  profile_version: z.string().nullable(),
  started_at: TimestampSchema.nullable(),
  completed_at: TimestampSchema.nullable(),
  error_code: z.string().nullable(),
  summary: z.string().nullable(),
  created_by: UuidSchema.nullable(),
  created_at: TimestampSchema,
});

export const CompanyEvidenceSchema = z.object({
  id: UuidSchema,
  company_id: UuidSchema,
  research_run_id: UuidSchema.nullable(),
  source_type: EvidenceSourceTypeSchema,
  source_name: z.string().trim().min(1),
  source_url: z.string().url().refine((value) => /^https?:\/\//i.test(value)).nullable(),
  observed_at: TimestampSchema,
  retrieved_at: TimestampSchema,
  excerpt: z.string().nullable(),
  content_hash: z.string().nullable(),
  confidence: ConfidenceSchema.nullable(),
  status: ResearchRecordStatusSchema,
  created_at: TimestampSchema,
});

const CompanyFactBaseSchema = z.object({
  id: UuidSchema,
  company_id: UuidSchema,
  status: ResearchRecordStatusSchema,
  confidence: ConfidenceSchema.nullable(),
  source_evidence_id: UuidSchema,
  observed_at: TimestampSchema,
  valid_until: TimestampSchema.nullable(),
  created_at: TimestampSchema,
});

export const CompanyFactSchema = z.discriminatedUnion("fact_key", [
  CompanyFactBaseSchema.extend({ fact_key: z.literal("industry"), value_jsonb: z.string().trim().min(1) }),
  CompanyFactBaseSchema.extend({ fact_key: z.literal("geography"), value_jsonb: z.string().trim().min(1) }),
  CompanyFactBaseSchema.extend({ fact_key: z.literal("platform"), value_jsonb: z.string().trim().min(1) }),
  CompanyFactBaseSchema.extend({ fact_key: z.literal("company_size"), value_jsonb: z.number().int().nonnegative() }),
  CompanyFactBaseSchema.extend({ fact_key: z.literal("revenue"), value_jsonb: RevenueFactValueSchema }),
]);

export const CompanyGrowthSignalSchema = z.object({
  id: UuidSchema,
  company_id: UuidSchema,
  signal_type: CompanyGrowthSignalTypeSchema,
  observed_at: TimestampSchema,
  confidence: ConfidenceSchema,
  status: ResearchRecordStatusSchema,
  evidence_id: UuidSchema,
  summary: z.string().nullable(),
  valid_until: TimestampSchema.nullable(),
  created_at: TimestampSchema,
});
