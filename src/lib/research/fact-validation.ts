import "server-only";
import { z } from "zod";
import { createSupabaseAdminClient } from "@/lib/supabase/admin";
import { CompanyEvidenceSchema, CompanyFactKeySchema, CompanyFactSchema } from "@/lib/research/schemas";
import type { ResearchRecordStatus } from "@/types/research";
import { extractCandidateCompanyFacts } from "@/lib/research/website-facts";
import {
  evidenceMatchesCompanyIdentity,
  getConfiguredTrustedResearchDomains,
  isTrustedResearchHost,
  type CompanyResearchIdentity,
} from "@/lib/research/source-quality";

const UuidSchema = z.string().uuid();
const FactIdentitySchema = z.object({
  id: UuidSchema,
  company_id: UuidSchema,
  fact_key: CompanyFactKeySchema,
  status: z.enum(["candidate", "accepted", "rejected", "conflicted", "stale"]),
  source_evidence_id: UuidSchema,
});

export type FactValidationOutcome = "accepted" | "rejected" | "conflicted" | "stale" | "duplicate" | "already_processed";

export interface FactValidationResult {
  factId: string;
  status: FactValidationOutcome;
  replacedFactId?: string;
}

export interface FactValidationPatch {
  status: ResearchRecordStatus;
  valid_until?: string | null;
}

export interface FactValidationRepository {
  getCompanyIdentity(companyId: string): Promise<CompanyResearchIdentity | null>;
  listCompanyFacts(companyId: string): Promise<unknown[]>;
  listCompanyEvidence(companyId: string, evidenceIds: string[]): Promise<unknown[]>;
  updateFact(companyId: string, factId: string, expectedStatus: ResearchRecordStatus, patch: FactValidationPatch): Promise<boolean>;
}

export type FactValidationErrorCode = "invalid_id" | "fact_not_found" | "fact_validation_failed" | "fact_update_failed";

export class FactValidationError extends Error {
  constructor(readonly code: FactValidationErrorCode) {
    super(code);
    this.name = "FactValidationError";
  }
}

function createSupabaseFactValidationRepository(): FactValidationRepository {
  const supabase = createSupabaseAdminClient();
  return {
    async getCompanyIdentity(companyId) {
      const { data, error } = await supabase.from("companies").select("name, domain, website, linkedin_url").eq("id", companyId).maybeSingle();
      if (error) throw new FactValidationError("fact_validation_failed");
      return data as CompanyResearchIdentity | null;
    },
    async listCompanyFacts(companyId) {
      const { data, error } = await supabase.from("company_facts").select("*").eq("company_id", companyId);
      if (error) throw new FactValidationError("fact_validation_failed");
      return data ?? [];
    },
    async listCompanyEvidence(companyId, evidenceIds) {
      if (evidenceIds.length === 0) return [];
      const { data, error } = await supabase
        .from("company_evidence")
        .select("*")
        .eq("company_id", companyId)
        .in("id", evidenceIds);
      if (error) throw new FactValidationError("fact_validation_failed");
      return data ?? [];
    },
    async updateFact(companyId, factId, expectedStatus, patch) {
      const { data, error } = await supabase
        .from("company_facts")
        .update(patch)
        .eq("company_id", companyId)
        .eq("id", factId)
        .eq("status", expectedStatus)
        .select("id")
        .maybeSingle();
      if (error) throw new FactValidationError("fact_update_failed");
      return Boolean(data);
    },
  };
}

function valueKey(value: unknown): string {
  return JSON.stringify(value);
}

function isExpired(validUntil: string | null, now: Date): boolean {
  return validUntil !== null && Date.parse(validUntil) <= now.getTime();
}

function factEvidenceSupport(
  evidence: z.infer<typeof CompanyEvidenceSchema>,
  fact: z.infer<typeof CompanyFactSchema>,
  identity: CompanyResearchIdentity | null,
): "supported" | "unsupported" | "ambiguous" {
  if (!(["official_website", "search_result"] as const).includes(evidence.source_type as "official_website" | "search_result")
    || !evidence.source_url || !evidence.excerpt) return "unsupported";
  if (evidence.confidence === null || evidence.confidence < 0.7 || fact.confidence === null || fact.confidence > evidence.confidence) return "unsupported";
  if (Date.parse(fact.observed_at) !== Date.parse(evidence.observed_at)) return "unsupported";
  if (evidence.source_type === "search_result") {
    let host: string;
    try { host = new URL(evidence.source_url).hostname; } catch { return "unsupported"; }
    if (!identity || !isTrustedResearchHost(host, getConfiguredTrustedResearchDomains())) return "unsupported";
    let rawExcerpt: unknown;
    try { rawExcerpt = JSON.parse(evidence.excerpt); } catch { return "unsupported"; }
    const excerpt = z.object({
      pageTitle: z.string().nullable().optional(),
      metaDescription: z.string().nullable().optional(),
      canonicalUrl: z.string().nullable().optional(),
      readableTextExcerpt: z.string().optional(),
    }).passthrough().safeParse(rawExcerpt);
    if (!excerpt.success) return "unsupported";
    const identityText = [excerpt.data.pageTitle, excerpt.data.metaDescription, excerpt.data.readableTextExcerpt]
      .filter((value): value is string => typeof value === "string").join("\n");
    if (!evidenceMatchesCompanyIdentity(identityText, identity, evidence.source_url)) return "unsupported";
  }
  const supported = extractCandidateCompanyFacts(evidence, identity ?? undefined).filter((candidate) => candidate.fact_key === fact.fact_key);
  const distinctSupported = new Set(supported.map((candidate) => valueKey(candidate.value_jsonb)));
  if (distinctSupported.size > 1) return "ambiguous";
  return distinctSupported.size === 1 && distinctSupported.has(valueKey(fact.value_jsonb)) ? "supported" : "unsupported";
}

/** Validates one candidate against its same-company official-site evidence and preserves its provenance. */
export async function validateCandidateCompanyFact(
  companyId: string,
  factId: string,
  repository: FactValidationRepository = createSupabaseFactValidationRepository(),
  now = new Date(),
): Promise<FactValidationResult> {
  return validateCandidateCompanyFactInternal(companyId, factId, repository, now);
}

/** Validates only candidates whose evidence belongs to the specified research run. */
export async function validateCandidateCompanyFactForRun(
  companyId: string,
  factId: string,
  researchRunId: string,
  repository: FactValidationRepository = createSupabaseFactValidationRepository(),
  now = new Date(),
): Promise<FactValidationResult> {
  return validateCandidateCompanyFactInternal(companyId, factId, repository, now, researchRunId, []);
}

/** Validates current-run facts plus an explicit set of unchanged, reused evidence rows. */
export async function validateCandidateCompanyFactForRunWithReusedEvidence(
  companyId: string,
  factId: string,
  researchRunId: string,
  reusedEvidenceIds: string[],
  repository: FactValidationRepository = createSupabaseFactValidationRepository(),
  now = new Date(),
): Promise<FactValidationResult> {
  return validateCandidateCompanyFactInternal(companyId, factId, repository, now, researchRunId, reusedEvidenceIds);
}

async function validateCandidateCompanyFactInternal(
  companyId: string,
  factId: string,
  repository: FactValidationRepository,
  now: Date,
  researchRunId?: string,
  reusedEvidenceIds: string[] = [],
): Promise<FactValidationResult> {
  if (!UuidSchema.safeParse(companyId).success || !UuidSchema.safeParse(factId).success
    || (researchRunId !== undefined && !UuidSchema.safeParse(researchRunId).success)
    || reusedEvidenceIds.some((id) => !UuidSchema.safeParse(id).success)) {
    throw new FactValidationError("invalid_id");
  }

  const rows = await repository.listCompanyFacts(companyId);
  const identity = rows.map((row) => FactIdentitySchema.safeParse(row)).find((parsed) => parsed.success && parsed.data.id === factId);
  if (!identity?.success || identity.data.company_id !== companyId) throw new FactValidationError("fact_not_found");
  if (identity.data.status !== "candidate") {
    return { factId, status: identity.data.status === "accepted" ? "already_processed" : identity.data.status };
  }

  const allMatchingRows = rows.filter((row) => {
    const parsed = FactIdentitySchema.safeParse(row);
    return parsed.success && parsed.data.company_id === companyId && parsed.data.fact_key === identity.data.fact_key
      && (parsed.data.status === "candidate" || parsed.data.status === "accepted");
  });
  const evidenceIds = [...new Set(allMatchingRows.flatMap((row) => {
    const parsed = FactIdentitySchema.safeParse(row);
    return parsed.success ? [parsed.data.source_evidence_id] : [];
  }))];
  const evidenceRows = await repository.listCompanyEvidence(companyId, evidenceIds);
  const companyIdentity = await repository.getCompanyIdentity(companyId);
  const evidenceById = new Map<string, z.infer<typeof CompanyEvidenceSchema>>();
  for (const row of evidenceRows) {
    const parsed = CompanyEvidenceSchema.safeParse(row);
    if (parsed.success && parsed.data.company_id === companyId) evidenceById.set(parsed.data.id, parsed.data);
  }

  if (researchRunId !== undefined) {
    const targetEvidence = evidenceById.get(identity.data.source_evidence_id);
    if (!targetEvidence || (targetEvidence.research_run_id !== researchRunId
      && !reusedEvidenceIds.includes(targetEvidence.id))) {
      throw new FactValidationError("fact_not_found");
    }
  }

  // A worker may mutate facts from this run or from evidence explicitly
  // reused by it. Other candidates remain conflict signals without being
  // changed, while accepted history remains visible for replacement checks.
  const matchingRows = allMatchingRows;
  const candidateRunIds = new Map<string, string | null>();
  for (const row of matchingRows) {
    const parsed = FactIdentitySchema.safeParse(row);
    if (parsed.success && parsed.data.status === "candidate") {
      candidateRunIds.set(parsed.data.id, evidenceById.get(parsed.data.source_evidence_id)?.research_run_id ?? null);
    }
  }
  const candidateEvidenceIds = new Map<string, string>();
  for (const row of matchingRows) {
    const parsed = FactIdentitySchema.safeParse(row);
    if (parsed.success && parsed.data.status === "candidate") candidateEvidenceIds.set(parsed.data.id, parsed.data.source_evidence_id);
  }
  const mayUpdateCandidate = (id: string) => researchRunId === undefined
    || candidateRunIds.get(id) === researchRunId
    || reusedEvidenceIds.includes(candidateEvidenceIds.get(id) ?? "");

  const validCandidates: Array<{ row: z.infer<typeof CompanyFactSchema>; evidence: z.infer<typeof CompanyEvidenceSchema> }> = [];
  const staleIds = new Set<string>();
  const rejectedIds = new Set<string>();
  const conflictedIds = new Set<string>();
  for (const row of matchingRows) {
    const parsedIdentity = FactIdentitySchema.safeParse(row);
    if (!parsedIdentity.success || parsedIdentity.data.status !== "candidate") continue;
    const parsedFact = CompanyFactSchema.safeParse(row);
    if (!parsedFact.success) {
      rejectedIds.add(parsedIdentity.data.id);
      continue;
    }
    const fact = parsedFact.data;
    const evidence = evidenceById.get(fact.source_evidence_id);
    if (!evidence || evidence.company_id !== fact.company_id) {
      rejectedIds.add(fact.id);
      continue;
    }
    if (evidence.status === "stale" || isExpired(fact.valid_until, now)) {
      staleIds.add(fact.id);
      continue;
    }
    if (evidence.status === "conflicted") {
      conflictedIds.add(fact.id);
      continue;
    }
    if (evidence.status === "rejected") {
      rejectedIds.add(fact.id);
      continue;
    }
    const support = factEvidenceSupport(evidence, fact, companyIdentity);
    if (support === "ambiguous") {
      conflictedIds.add(fact.id);
      continue;
    }
    if (support === "unsupported") {
      rejectedIds.add(fact.id);
      continue;
    }
    validCandidates.push({ row: fact, evidence });
  }

  for (const id of staleIds) {
    if (!mayUpdateCandidate(id)) continue;
    if (!await repository.updateFact(companyId, id, "candidate", { status: "stale" })) {
      throw new FactValidationError("fact_update_failed");
    }
  }
  for (const id of rejectedIds) {
    if (!mayUpdateCandidate(id)) continue;
    if (!await repository.updateFact(companyId, id, "candidate", { status: "rejected" })) {
      throw new FactValidationError("fact_update_failed");
    }
  }
  for (const id of conflictedIds) {
    if (!mayUpdateCandidate(id)) continue;
    if (!await repository.updateFact(companyId, id, "candidate", { status: "conflicted" })) {
      throw new FactValidationError("fact_update_failed");
    }
  }

  const target = validCandidates.find(({ row }) => row.id === factId);
  if (!target) {
    const status = staleIds.has(factId) ? "stale" : conflictedIds.has(factId) ? "conflicted" : "rejected";
    return { factId, status };
  }

  const distinctValues = new Set(validCandidates.map(({ row }) => valueKey(row.value_jsonb)));
  if (distinctValues.size > 1) {
    for (const { row } of validCandidates) {
      if (!mayUpdateCandidate(row.id)) continue;
      if (!await repository.updateFact(companyId, row.id, "candidate", { status: "conflicted" })) {
        throw new FactValidationError("fact_update_failed");
      }
    }
    return { factId, status: "conflicted" };
  }

  const acceptedRows = rows.flatMap((row) => {
    const parsed = CompanyFactSchema.safeParse(row);
    return parsed.success && parsed.data.company_id === companyId
      && parsed.data.fact_key === target.row.fact_key && parsed.data.status === "accepted" ? [parsed.data] : [];
  });
  if (acceptedRows.length > 1) throw new FactValidationError("fact_validation_failed");
  const previous = acceptedRows[0];

  if (previous && Date.parse(target.row.observed_at) <= Date.parse(previous.observed_at)) {
    if (valueKey(target.row.value_jsonb) === valueKey(previous.value_jsonb)) {
      return { factId, status: "duplicate" };
    }
    if (!await repository.updateFact(companyId, factId, "candidate", { status: "conflicted" })) {
      throw new FactValidationError("fact_update_failed");
    }
    return { factId, status: "conflicted" };
  }

  if (previous) {
    const markedStale = await repository.updateFact(companyId, previous.id, "accepted", {
      status: "stale",
      valid_until: target.row.observed_at,
    });
    if (!markedStale) throw new FactValidationError("fact_update_failed");
  }

  const accepted = await repository.updateFact(companyId, factId, "candidate", { status: "accepted" });
  if (!accepted) {
    if (previous) {
      await repository.updateFact(companyId, previous.id, "stale", {
        status: "accepted",
        valid_until: previous.valid_until,
      });
    }
    throw new FactValidationError("fact_update_failed");
  }

  return { factId, status: "accepted", ...(previous ? { replacedFactId: previous.id } : {}) };
}
