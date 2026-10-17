import "server-only";
import { z } from "zod";
import { ECOM_D2C_V1 } from "@/config/icp/ecom-d2c-v1.0.0";
import { CompanyEvidenceSchema, CompanyGrowthSignalSchema } from "@/lib/research/schemas";
import { extractCandidateGrowthSignals } from "@/lib/research/growth-signals";
import { evidenceMatchesCompanyIdentity, getConfiguredTrustedResearchDomains, isTrustedResearchHost, type CompanyResearchIdentity } from "@/lib/research/source-quality";
import { createSupabaseAdminClient } from "@/lib/supabase/admin";
import type { ResearchRecordStatus } from "@/types/research";

const Uuid = z.string().uuid();
export type GrowthSignalValidationOutcome = "accepted" | "rejected" | "conflicted" | "stale" | "already_processed";
export interface GrowthSignalValidationResult { signalId: string; status: GrowthSignalValidationOutcome }
export interface GrowthSignalPatch { status: ResearchRecordStatus; valid_until?: string | null }
export interface GrowthSignalValidationRepository {
  getCompanyIdentity(companyId: string): Promise<CompanyResearchIdentity | null>;
  listSignals(companyId: string): Promise<unknown[]>;
  listEvidence(companyId: string, evidenceIds: string[]): Promise<unknown[]>;
  updateSignal(companyId: string, signalId: string, expectedStatus: ResearchRecordStatus, patch: GrowthSignalPatch): Promise<boolean>;
}
export class GrowthSignalValidationError extends Error {
  constructor(readonly code: "invalid_id" | "signal_not_found" | "validation_failed" | "update_failed") { super(code); this.name = "GrowthSignalValidationError"; }
}

function createRepository(): GrowthSignalValidationRepository {
  const db = createSupabaseAdminClient();
  return {
    async getCompanyIdentity(companyId) {
      const { data, error } = await db.from("companies").select("name, domain, website, linkedin_url").eq("id", companyId).maybeSingle();
      if (error) throw new GrowthSignalValidationError("validation_failed");
      return data as CompanyResearchIdentity | null;
    },
    async listSignals(companyId) {
      const { data, error } = await db.from("company_growth_signals").select("*").eq("company_id", companyId);
      if (error) throw new GrowthSignalValidationError("validation_failed");
      return data ?? [];
    },
    async listEvidence(companyId, ids) {
      if (!ids.length) return [];
      const { data, error } = await db.from("company_evidence").select("*").eq("company_id", companyId).in("id", ids);
      if (error) throw new GrowthSignalValidationError("validation_failed");
      return data ?? [];
    },
    async updateSignal(companyId, signalId, expectedStatus, patch) {
      const { data, error } = await db.from("company_growth_signals").update(patch)
        .eq("company_id", companyId).eq("id", signalId).eq("status", expectedStatus).select("id").maybeSingle();
      if (error) throw new GrowthSignalValidationError("update_failed");
      return Boolean(data);
    },
  };
}

function normalizedSummary(value: string | null): string {
  return (value ?? "").toLowerCase().replace(/[^a-z0-9%$]+/g, " ").trim();
}
function maxAge(type: z.infer<typeof CompanyGrowthSignalSchema>["signal_type"]): number {
  return ECOM_D2C_V1.growthSignals.maxAgeDays[type === "verified_contraction" ? "verified_growth" : type];
}

/** Validates a just-extracted signal. Only same-run evidence can be promoted; reused historical evidence remains untouched. */
export async function validateCandidateGrowthSignalForRun(
  companyId: string,
  signalId: string,
  researchRunId: string,
  currentRunEvidenceIds: string[],
  repository: GrowthSignalValidationRepository = createRepository(),
  now = new Date(),
): Promise<GrowthSignalValidationResult> {
  if (![companyId, signalId, researchRunId, ...currentRunEvidenceIds].every((id) => Uuid.safeParse(id).success)) throw new GrowthSignalValidationError("invalid_id");
  const rows = await repository.listSignals(companyId);
  const parsedRows = rows.map((row) => CompanyGrowthSignalSchema.safeParse(row)).filter((row) => row.success).map((row) => row.data);
  const signal = parsedRows.find((row) => row.id === signalId && row.company_id === companyId);
  if (!signal) throw new GrowthSignalValidationError("signal_not_found");
  if (signal.status !== "candidate") return { signalId, status: "already_processed" };
  const evidenceIds = [...new Set(parsedRows.filter((row) => row.company_id === companyId).map((row) => row.evidence_id))];
  const evidenceRows = await repository.listEvidence(companyId, evidenceIds);
  const evidenceById = new Map<string, z.infer<typeof CompanyEvidenceSchema>>();
  for (const row of evidenceRows) {
    const parsed = CompanyEvidenceSchema.safeParse(row);
    if (parsed.success && parsed.data.company_id === companyId) evidenceById.set(parsed.data.id, parsed.data);
  }
  const evidence = evidenceById.get(signal.evidence_id);
  if (!evidence || evidence.company_id !== companyId) throw new GrowthSignalValidationError("signal_not_found");
  if (evidence.research_run_id !== researchRunId || !currentRunEvidenceIds.includes(evidence.id)) {
    return { signalId, status: "rejected" };
  }

  const eventAt = Date.parse(signal.observed_at);
  const evidenceRetrievedAt = Date.parse(evidence.retrieved_at);
  let outcome: "accepted" | "rejected" | "stale" | "conflicted" = "accepted";
  if (!Number.isFinite(eventAt) || eventAt > now.getTime() || !Number.isFinite(evidenceRetrievedAt) || evidenceRetrievedAt > now.getTime()) outcome = "rejected";
  else if (evidence.status === "stale" || (now.getTime() - eventAt) / 86_400_000 > maxAge(signal.signal_type)) outcome = "stale";
  else if (evidence.status === "rejected" || evidence.confidence === null
    || evidence.confidence < ECOM_D2C_V1.growthSignals.minimumConfidence
    || signal.confidence < ECOM_D2C_V1.growthSignals.minimumConfidence
    || signal.confidence > evidence.confidence) outcome = "rejected";

  const identity = await repository.getCompanyIdentity(companyId);
  if (!identity || !evidence.source_url || !evidence.excerpt) outcome = "rejected";
  if (outcome === "accepted" && evidence.source_type === "search_result") {
    try {
      const url = new URL(evidence.source_url!);
      if (!isTrustedResearchHost(url.hostname, getConfiguredTrustedResearchDomains())) outcome = "rejected";
    } catch { outcome = "rejected"; }
  } else if (outcome === "accepted" && evidence.source_type !== "official_website") outcome = "rejected";

  if (outcome === "accepted") {
    const sourceClaims = extractCandidateGrowthSignals(evidence, identity!, now).filter((candidate) =>
      candidate.signal_type === signal.signal_type && Date.parse(candidate.observed_at) === eventAt,
    );
    const sourceClaimSummaries = new Set(sourceClaims.map((candidate) => normalizedSummary(candidate.summary)));
    if (sourceClaimSummaries.size > 1) outcome = "conflicted";
    const extracted = sourceClaims.some((candidate) => candidate.summary === signal.summary);
    if (outcome === "accepted" && !extracted) outcome = "rejected";
    else if (outcome === "accepted") {
      let text = "";
      try {
        const raw = JSON.parse(evidence.excerpt ?? "") as Record<string, unknown>;
        text = [raw.readableTextExcerpt, raw.pageTitle, raw.metaDescription, raw.title, raw.snippet]
          .filter((part): part is string => typeof part === "string").join("\n");
      } catch { outcome = "rejected"; }
      if (!identity || !evidenceMatchesCompanyIdentity(text, identity, evidence.source_url)) outcome = "rejected";
    }
  }

  const peerCandidates = parsedRows.filter((row) => row.company_id === companyId && row.id !== signal.id
    && row.signal_type === signal.signal_type && Date.parse(row.observed_at) === eventAt
    && (row.status === "candidate" || row.status === "accepted"));
  const conflicts = peerCandidates.filter((row) => normalizedSummary(row.summary) !== normalizedSummary(signal.summary));
  if (outcome === "accepted" && conflicts.length > 0) {
    outcome = "conflicted";
    for (const peer of conflicts) {
      if (peer.status === "accepted" && !await repository.updateSignal(companyId, peer.id, "accepted", { status: "conflicted" })) {
        throw new GrowthSignalValidationError("update_failed");
      }
      if (peer.status === "candidate" && currentRunEvidenceIds.includes(peer.evidence_id)
        && !await repository.updateSignal(companyId, peer.id, "candidate", { status: "conflicted" })) {
        throw new GrowthSignalValidationError("update_failed");
      }
    }
  }
  if (!await repository.updateSignal(companyId, signalId, "candidate", { status: outcome })) throw new GrowthSignalValidationError("update_failed");
  return { signalId, status: outcome };
}
