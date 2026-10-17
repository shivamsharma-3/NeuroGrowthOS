import "server-only";
import { z } from "zod";
import { createSupabaseAdminClient } from "@/lib/supabase/admin";
import {
  collectOfficialWebsiteEvidence,
  OfficialWebsiteResearchError,
} from "@/lib/research/official-website";
import { extractCandidateCompanyFacts } from "@/lib/research/website-facts";
import { validateCandidateCompanyFactForRunWithReusedEvidence, type FactValidationResult } from "@/lib/research/fact-validation";
import { extractCandidateGrowthSignals } from "@/lib/research/growth-signals";
import { validateCandidateGrowthSignalForRun, type GrowthSignalValidationResult } from "@/lib/research/growth-signal-validation";
import type { CompanySearchProvider } from "@/lib/research/search-provider";
import { collectSearchEvidence } from "@/lib/research/search-research";
import type { SearchStageDiagnostics } from "@/lib/research/search-research";
import { getConfiguredSearchProvider } from "@/lib/research/tavily-provider";

const ResearchRunIdSchema = z.string().uuid();

const CanonicalCompanyProfileSchema = z.object({
  id: z.string().uuid(),
  name: z.string(),
  website: z.string().nullable(),
  domain: z.string().nullable(),
  industry: z.string().nullable(),
  country: z.string().nullable(),
  estimated_revenue: z.union([z.number(), z.string()]).nullable(),
  employee_count: z.number().int().nullable(),
  platform: z.string().nullable(),
  linkedin_url: z.string().nullable(),
  description: z.string().nullable(),
});

export const CanonicalResearchResultSchema = z.object({
  kind: z.literal("canonical_company_snapshot"),
  version: z.literal("canonical-snapshot-v1"),
  company: CanonicalCompanyProfileSchema,
});

export type CanonicalResearchResult = z.infer<typeof CanonicalResearchResultSchema>;

export type ResearchWorkerErrorCode =
  | "invalid_research_run_id"
  | "research_run_not_found"
  | "research_run_not_queued"
  | "company_not_found"
  | "invalid_website_url"
  | "website_target_blocked"
  | "website_dns_failed"
  | "website_timeout"
  | "website_redirect_blocked"
  | "website_http_error"
  | "website_non_html"
  | "website_response_too_large"
  | "website_fetch_failed"
  | "completed_result_unavailable"
  | "research_worker_failed";

export class ResearchWorkerError extends Error {
  constructor(readonly code: ResearchWorkerErrorCode) {
    super(code);
    this.name = "ResearchWorkerError";
  }
}

export interface ProcessResearchRunResult {
  researchRunId: string;
  status: "completed";
  result: CanonicalResearchResult;
  alreadyCompleted: boolean;
}

type OfficialWebsiteDiagnostic = {
  status: "completed" | "unusable" | "failed";
  errorCode: string | null;
};

interface ResearchRunRow {
  id: string;
  company_id: string;
  status: string;
  summary: string | null;
}

function parseStoredResult(summary: string | null): CanonicalResearchResult {
  if (!summary) throw new ResearchWorkerError("completed_result_unavailable");

  try {
    return CanonicalResearchResultSchema.parse(JSON.parse(summary) as unknown);
  } catch {
    throw new ResearchWorkerError("completed_result_unavailable");
  }
}

function canonicalEvidenceUrl(value: unknown): string | null {
  if (typeof value !== "string") return null;
  try {
    const url = new URL(value);
    url.hash = "";
    return url.toString();
  } catch {
    return null;
  }
}

/** Processes one queued run using only the company's canonical profile. */
export async function processResearchRun(
  researchRunId: string,
  options: {
    searchProvider?: CompanySearchProvider;
    validateFact?: (companyId: string, factId: string, researchRunId: string, reusedEvidenceIds: string[]) => Promise<FactValidationResult>;
    validateGrowthSignal?: (companyId: string, signalId: string, researchRunId: string, currentRunEvidenceIds: string[]) => Promise<GrowthSignalValidationResult>;
  } = {},
): Promise<ProcessResearchRunResult> {
  if (!ResearchRunIdSchema.safeParse(researchRunId).success) {
    throw new ResearchWorkerError("invalid_research_run_id");
  }

  const supabase = createSupabaseAdminClient();
  const { data: loadedRun, error: loadError } = await supabase
    .from("company_research_runs")
    .select("id, company_id, status, summary")
    .eq("id", researchRunId)
    .maybeSingle();

  if (loadError) throw new ResearchWorkerError("research_worker_failed");
  if (!loadedRun) throw new ResearchWorkerError("research_run_not_found");

  const run = loadedRun as ResearchRunRow;
  if (run.status === "completed") {
    return {
      researchRunId: run.id,
      status: "completed",
      result: parseStoredResult(run.summary),
      alreadyCompleted: true,
    };
  }
  if (run.status !== "queued") throw new ResearchWorkerError("research_run_not_queued");

  const searchProvider = options.searchProvider ?? getConfiguredSearchProvider();
  const validateFact = options.validateFact ?? validateCandidateCompanyFactForRunWithReusedEvidence;
  const validateGrowthSignal = options.validateGrowthSignal ?? validateCandidateGrowthSignalForRun;
  const searchProviderName = searchProvider.name === "tavily"
    ? "tavily"
    : searchProvider.enabled ? "custom" : "noop";
  const searchDiagnostics: SearchStageDiagnostics = {
    resultsReturned: 0,
    resultsFilteredIrrelevant: 0,
    resultsRejectedSafety: 0,
    resultsSkippedDuplicates: 0,
    resultsReused: 0,
    resultsPersisted: 0,
    providerFailureCode: null,
    resultDetails: [],
  };
  let officialWebsiteDiagnostic: OfficialWebsiteDiagnostic = {
    status: "failed",
    errorCode: null,
  };
  let failedStage = "company_load";

  const startedAt = new Date().toISOString();
  const { data: claimedRun, error: claimError } = await supabase
    .from("company_research_runs")
    .update({ status: "running", started_at: startedAt, error_code: null, provider: searchProviderName })
    .eq("id", run.id)
    .eq("company_id", run.company_id)
    .eq("status", "queued")
    .select("id, company_id, status")
    .maybeSingle();

  if (claimError) throw new ResearchWorkerError("research_worker_failed");
  if (!claimedRun) {
    const { data: latestRun, error: latestError } = await supabase
      .from("company_research_runs")
      .select("id, company_id, status, summary")
      .eq("id", run.id)
      .eq("company_id", run.company_id)
      .maybeSingle();
    if (latestError) throw new ResearchWorkerError("research_worker_failed");
    if (latestRun?.status === "completed") {
      const latest = latestRun as ResearchRunRow;
      return {
        researchRunId: latest.id,
        status: "completed",
        result: parseStoredResult(latest.summary),
        alreadyCompleted: true,
      };
    }
    throw new ResearchWorkerError("research_run_not_queued");
  }

  try {
    const { data: company, error: companyError } = await supabase
      .from("companies")
      .select("id, name, website, domain, industry, country, estimated_revenue, employee_count, platform, linkedin_url, description")
      .eq("id", run.company_id)
      .maybeSingle();

    if (companyError) throw new Error("company_query_failed");
    if (!company || company.id !== run.company_id || claimedRun.company_id !== run.company_id) {
      throw new ResearchWorkerError("company_not_found");
    }

    const result = CanonicalResearchResultSchema.parse({
      kind: "canonical_company_snapshot",
      version: "canonical-snapshot-v1",
      company,
    });

    failedStage = "official_website";
    let websiteResearch: Awaited<ReturnType<typeof collectOfficialWebsiteEvidence>> | null = null;
    try {
      websiteResearch = await collectOfficialWebsiteEvidence(company, run.id);
      officialWebsiteDiagnostic = websiteResearch.evidence.length > 0
        ? { status: "completed", errorCode: null }
        : { status: "unusable", errorCode: "website_unusable_content" };
    } catch (cause) {
      officialWebsiteDiagnostic = {
        status: "failed",
        errorCode: cause instanceof OfficialWebsiteResearchError ? cause.code : "website_fetch_failed",
      };
    }

    let persistedEvidence: Array<Record<string, unknown>> = [];
    const reusedEvidenceIds = new Set<string>();
    if (websiteResearch && websiteResearch.evidence.length > 0) {
      failedStage = "official_evidence_persistence";
      const sourceUrls = [...new Set(websiteResearch.evidence.flatMap((item) => item.company_id === company.id
        ? [item.source_url]
        : []))];
      const { data: existingRows, error: lookupError } = await supabase
        .from("company_evidence")
        .select("*")
        .eq("company_id", company.id)
        .in("source_url", sourceUrls);
      if (lookupError) throw new Error("evidence_lookup_failed");
      const existingByUrl = new Map<string, Record<string, unknown>>();
      for (const row of (existingRows ?? []) as Array<Record<string, unknown>>) {
        const key = canonicalEvidenceUrl(row.source_url);
        if (!key || row.company_id !== company.id) continue;
        const current = existingByUrl.get(key);
        const currentObserved = typeof current?.observed_at === "string" ? Date.parse(current.observed_at) : -Infinity;
        const observed = typeof row.observed_at === "string" ? Date.parse(row.observed_at) : -Infinity;
        if (!current || observed > currentObserved) existingByUrl.set(key, row);
      }
      const freshRows = websiteResearch.evidence.filter((item) => !existingByUrl.has(canonicalEvidenceUrl(item.source_url) ?? ""));
      const reusedRows = websiteResearch.evidence.flatMap((item) => {
        const row = existingByUrl.get(canonicalEvidenceUrl(item.source_url) ?? "");
        return row ? [row] : [];
      });
      let insertedRows: Array<Record<string, unknown>> = [];
      if (freshRows.length > 0) {
        const { data, error: evidenceError } = await supabase
          .from("company_evidence")
          .upsert(freshRows, { onConflict: "company_id,source_url", ignoreDuplicates: true })
          .select("*");
        if (evidenceError || !data) throw new Error("evidence_persistence_failed");
        insertedRows = data as Array<Record<string, unknown>>;
        const insertedUrls = new Set(insertedRows.flatMap((row) => {
          const key = canonicalEvidenceUrl(row.source_url);
          return row.company_id === company.id && key ? [key] : [];
        }));
        const racedUrls = freshRows.flatMap((row) => {
          const key = canonicalEvidenceUrl(row.source_url);
          return key && !insertedUrls.has(key) ? [row.source_url] : [];
        });
        if (racedUrls.length > 0) {
          const { data: racedRows, error: racedLookupError } = await supabase
            .from("company_evidence")
            .select("*")
            .eq("company_id", company.id)
            .in("source_url", racedUrls);
          if (racedLookupError || !racedRows) throw new Error("evidence_lookup_failed");
          for (const row of racedRows as Array<Record<string, unknown>>) {
            if (row.company_id === company.id && typeof row.id === "string") reusedEvidenceIds.add(row.id);
          }
          if (insertedUrls.size + racedUrls.filter((url) => (racedRows as Array<Record<string, unknown>>)
            .some((row) => row.company_id === company.id && row.source_url === url)).length < freshRows.length) {
            throw new Error("evidence_persistence_failed");
          }
          reusedRows.push(...(racedRows as Array<Record<string, unknown>>));
        }
      }
      for (const row of reusedRows) if (typeof row.id === "string") reusedEvidenceIds.add(row.id);
      persistedEvidence = [...insertedRows, ...reusedRows];
    }

    if (searchProvider.enabled) {
      failedStage = "search";
      const searchResult = await collectSearchEvidence(company, run.id, searchProvider, {
        async getRun(researchRunId) {
          const { data, error } = await supabase
            .from("company_research_runs")
            .select("company_id, status")
            .eq("id", researchRunId)
            .maybeSingle();
          if (error || !data) return null;
          return data as { company_id: string; status: string };
        },
        async getExistingEvidence(companyId, sourceUrls) {
          if (sourceUrls.length === 0) return [];
          const { data, error } = await supabase
            .from("company_evidence")
            .select("*")
            .eq("company_id", companyId)
            .in("source_url", sourceUrls);
          if (error) throw new Error("search_evidence_lookup_failed");
          return (data ?? []) as Array<Record<string, unknown>>;
        },
        async insertEvidence(rows) {
          const { data, error } = await supabase
            .from("company_evidence")
            .upsert(rows, { onConflict: "company_id,source_url", ignoreDuplicates: true })
            .select("*");
          if (error || !data) throw new Error("search_evidence_persistence_failed");
          return data as Array<Record<string, unknown>>;
        },
      });
      Object.assign(searchDiagnostics, searchResult.diagnostics);
      for (const reused of searchResult.reusedEvidence) {
        if (reused.company_id === company.id && typeof reused.id === "string") reusedEvidenceIds.add(reused.id);
      }
      persistedEvidence = [...persistedEvidence, ...searchResult.evidence, ...searchResult.reusedEvidence];
    }

    persistedEvidence = [...new Map(persistedEvidence.flatMap((row) =>
      typeof row.id === "string" && row.company_id === company.id ? [[row.id, row] as const] : [],
    )).values()];

    failedStage = "fact_extraction";
    const extractedFacts = persistedEvidence.flatMap((item) => extractCandidateCompanyFacts(item, company));
    if (persistedEvidence.length > 0) {
      failedStage = "fact_persistence";
      const { data: previousFacts, error: previousFactsError } = await supabase
        .from("company_facts")
        .select("id, company_id, fact_key, value_jsonb, source_evidence_id, status")
        .eq("company_id", company.id)
        .in("source_evidence_id", persistedEvidence.map((item) => String(item.id)));
      if (previousFactsError) throw new Error("fact_lookup_failed");
      const existingKeys = new Set((previousFacts ?? []).map((item: { fact_key: string; value_jsonb: unknown; source_evidence_id: string }) =>
        `${item.source_evidence_id}:${item.fact_key}:${JSON.stringify(item.value_jsonb)}`,
      ));
      const newFacts = extractedFacts.filter((item) =>
        !existingKeys.has(`${item.source_evidence_id}:${item.fact_key}:${JSON.stringify(item.value_jsonb)}`),
      );
      let insertedFacts: Array<{ id: string; company_id: string; source_evidence_id: string }> = [];
      if (newFacts.length > 0) {
        const { data: selectedInsertedFacts, error: factsError } = await supabase
          .from("company_facts")
          .insert(newFacts)
          .select("id, company_id, source_evidence_id");
        if (factsError || !selectedInsertedFacts) throw new Error("fact_persistence_failed");
        insertedFacts = selectedInsertedFacts as Array<{ id: string; company_id: string; source_evidence_id: string }>;
      }

      const evidenceById = new Map(persistedEvidence.map((item) => [String(item.id), item]));
      const factsToValidate = [
        ...insertedFacts,
        ...((previousFacts ?? []) as Array<{ id: string; company_id: string; source_evidence_id: string; status: string }>)
          .filter((item) => item.company_id === company.id && item.status === "candidate"
            && reusedEvidenceIds.has(item.source_evidence_id)),
      ];
      const validatedIds = new Set<string>();
      failedStage = "fact_validation";
      for (const fact of factsToValidate) {
        if (validatedIds.has(fact.id)) continue;
        validatedIds.add(fact.id);
        const sourceEvidence = evidenceById.get(fact.source_evidence_id);
        if (fact.company_id !== company.id || !sourceEvidence || sourceEvidence.company_id !== company.id
          || (sourceEvidence.research_run_id !== run.id && !reusedEvidenceIds.has(fact.source_evidence_id))) {
          throw new Error("fact_validation_scope_failed");
        }
        await validateFact(company.id, fact.id, run.id, [...reusedEvidenceIds]);
      }
    }

    // Growth signals are intentionally extracted only from evidence first persisted
    // by this run. Reused historical URLs retain their provenance and are not
    // silently promoted by a later research run.
    const currentRunEvidence = persistedEvidence.filter((item) => item.company_id === company.id
      && item.research_run_id === run.id && typeof item.id === "string");
    if (currentRunEvidence.length > 0) {
      failedStage = "growth_signal_extraction";
      const candidateSignals = currentRunEvidence.flatMap((item) => extractCandidateGrowthSignals(item, company));
      const { data: previousSignals, error: previousSignalsError } = await supabase
        .from("company_growth_signals")
        .select("id, company_id, signal_type, observed_at, evidence_id, summary, status")
        .eq("company_id", company.id)
        .in("evidence_id", currentRunEvidence.map((item) => String(item.id)));
      if (previousSignalsError) throw new Error("growth_signal_lookup_failed");
      const existingSignalKeys = new Set((previousSignals ?? []).map((item: { signal_type: string; observed_at: string; evidence_id: string }) =>
        `${item.evidence_id}:${item.signal_type}:${Date.parse(item.observed_at)}`,
      ));
      const signalKeys = new Set<string>();
      const newSignals = candidateSignals.filter((item) => {
        const key = `${item.evidence_id}:${item.signal_type}:${Date.parse(item.observed_at)}`;
        if (existingSignalKeys.has(key) || signalKeys.has(key)) return false;
        signalKeys.add(key);
        return true;
      });
      if (newSignals.length > 0) {
        failedStage = "growth_signal_persistence";
        const { data: insertedSignals, error: insertSignalsError } = await supabase
          .from("company_growth_signals")
          .insert(newSignals)
          .select("id, company_id, evidence_id");
        if (insertSignalsError || !insertedSignals) throw new Error("growth_signal_persistence_failed");
        failedStage = "growth_signal_validation";
        const currentEvidenceIds = currentRunEvidence.map((item) => String(item.id));
        for (const signal of insertedSignals as Array<{ id: string; company_id: string; evidence_id: string }>) {
          if (signal.company_id !== company.id || !currentEvidenceIds.includes(signal.evidence_id)) {
            throw new Error("growth_signal_validation_scope_failed");
          }
          await validateGrowthSignal(company.id, signal.id, run.id, currentEvidenceIds);
        }
      }
    }

    failedStage = "completion";
    const { data: completedRun, error: completeError } = await supabase
      .from("company_research_runs")
      .update({
        status: "completed",
        completed_at: new Date().toISOString(),
        error_code: null,
        profile_version: result.version,
        summary: JSON.stringify({
          ...result,
          searchDiagnostics,
          researchDiagnostics: {
            failedStage: null,
            officialWebsite: officialWebsiteDiagnostic,
          },
        }),
      })
      .eq("id", run.id)
      .eq("company_id", run.company_id)
      .eq("status", "running")
      .select("id")
      .maybeSingle();

    if (completeError || !completedRun) throw new Error("run_completion_failed");

    return {
      researchRunId: run.id,
      status: "completed",
      result,
      alreadyCompleted: false,
    };
  } catch (cause) {
    const errorCode: ResearchWorkerErrorCode = cause instanceof OfficialWebsiteResearchError
      ? cause.code
      : cause instanceof ResearchWorkerError && cause.code === "company_not_found"
        ? "company_not_found"
        : "research_worker_failed";

    const { error: failError } = await supabase
      .from("company_research_runs")
      .update({
        status: "failed",
        completed_at: new Date().toISOString(),
        error_code: errorCode,
        summary: JSON.stringify({
          kind: "research_diagnostics",
          version: "research-diagnostics-v1",
          failedStage,
          officialWebsite: officialWebsiteDiagnostic,
          searchDiagnostics,
        }),
      })
      .eq("id", run.id)
      .eq("company_id", run.company_id)
      .eq("status", "running");

    if (failError) throw new ResearchWorkerError("research_worker_failed");
    throw new ResearchWorkerError(errorCode);
  }
}
