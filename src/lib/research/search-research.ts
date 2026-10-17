import "server-only";
import { createHash } from "node:crypto";
import { validateSafeResearchUrl } from "@/lib/research/official-website";
import {
  getConfiguredTrustedResearchDomains,
  isTrustedResearchHost,
  safeResearchSourceLocation,
} from "@/lib/research/source-quality";
import { TavilySearchError, type TavilyFailureDiagnostic } from "@/lib/research/tavily-provider";
import {
  MAX_SEARCH_RESULT_DIAGNOSTICS,
  MAX_SEARCH_RESULTS_PER_RUN,
  SearchResultSchema,
  type CompanySearchProvider,
  type SearchResultDiagnostic,
  type SearchResultDisposition,
  type SearchResult,
  type ProviderResultDiagnostic,
} from "@/lib/research/search-provider";

export interface SearchResearchCompany {
  id: string;
  name: string;
  domain: string | null;
}

export interface SearchEvidenceInsert {
  company_id: string;
  research_run_id: string;
  source_type: "search_result";
  source_name: string;
  source_url: string;
  observed_at: string;
  retrieved_at: string;
  excerpt: string;
  content_hash: string;
  confidence: number;
  status: "candidate";
}

export interface SearchResearchStore {
  getRun(researchRunId: string): Promise<{ company_id: string; status: string } | null>;
  getExistingEvidence(companyId: string, sourceUrls: string[]): Promise<Array<Record<string, unknown>>>;
  insertEvidence(rows: SearchEvidenceInsert[]): Promise<Array<Record<string, unknown>>>;
}

export interface SearchResearchDependencies {
  now(): Date;
  validateUrl(value: string): Promise<URL>;
}

export interface SearchResearchResult {
  evidence: Array<Record<string, unknown>>;
  reusedEvidence: Array<Record<string, unknown>>;
  diagnostics: SearchStageDiagnostics;
}

export interface SearchStageDiagnostics {
  resultsReturned: number;
  resultsFilteredIrrelevant: number;
  resultsRejectedSafety: number;
  resultsSkippedDuplicates: number;
  resultsReused: number;
  resultsPersisted: number;
  providerFailureCode: string | null;
  providerFailureDiagnostic?: TavilyFailureDiagnostic;
  resultDetails: SearchResultDiagnostic[];
}

function addResultDetail(
  details: SearchResultDiagnostic[],
  input: Omit<SearchResultDiagnostic, "sourceUrl" | "sourceDomain"> & { url: string | null | undefined },
): SearchResultDiagnostic | null {
  if (details.length >= MAX_SEARCH_RESULT_DIAGNOSTICS) return null;
  const location = input.url ? safeResearchSourceLocation(input.url) : { sourceUrl: null, sourceDomain: null };
  const detail = { ...location, disposition: input.disposition, reason: input.reason,
    ...(input.evidenceId ? { evidenceId: input.evidenceId } : {}),
    ...(input.originalResearchRunId !== undefined ? { originalResearchRunId: input.originalResearchRunId } : {}),
  };
  details.push(detail);
  return detail;
}

function updateEligibleDetail(
  detailsByUrl: Map<string, SearchResultDiagnostic>,
  sourceUrl: string,
  disposition: SearchResultDisposition,
  reason: string | null,
  evidence?: Record<string, unknown>,
): void {
  let key: string;
  try { key = canonicalUrlKey(new URL(sourceUrl)); } catch { return; }
  const detail = detailsByUrl.get(key);
  if (!detail || detail.disposition !== "eligible") return;
  detail.disposition = disposition;
  detail.reason = typeof evidence?.id === "string" ? reason : "evidence_attribution_unavailable";
  if (typeof evidence?.id === "string") detail.evidenceId = evidence.id;
  if (disposition === "reused") detail.originalResearchRunId = typeof evidence?.research_run_id === "string" ? evidence.research_run_id : null;
}

function markAmbiguousAttribution(detailsByUrl: Map<string, SearchResultDiagnostic>, sourceUrl: string): void {
  try {
    const detail = detailsByUrl.get(canonicalUrlKey(new URL(sourceUrl)));
    if (detail) {
      detail.disposition = "eligible";
      detail.reason = "evidence_attribution_ambiguous";
      delete detail.evidenceId;
      delete detail.originalResearchRunId;
    }
  } catch { /* malformed returned URL has no attributable diagnostic */ }
}

function attributeDuplicateDetails(
  duplicatesByUrl: Map<string, SearchResultDiagnostic[]>, sourceUrl: string,
  evidence: Record<string, unknown>, reused: boolean,
): void {
  if (typeof evidence.id !== "string") return;
  try {
    for (const detail of duplicatesByUrl.get(canonicalUrlKey(new URL(sourceUrl))) ?? []) {
      detail.evidenceId = evidence.id;
      if (reused) detail.originalResearchRunId = typeof evidence.research_run_id === "string" ? evidence.research_run_id : null;
    }
  } catch { /* malformed returned URL has no attributable diagnostic */ }
}

const providerReasons = new Set([
  "invalid_source_url", "unsafe_source_url", "company_identity_not_established",
  "duplicate_provider_url", "malformed_search_result", "per_run_result_limit",
]);
const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/** Treat provider diagnostics as untrusted input, even when TypeScript says otherwise. */
function sanitizeProviderDiagnostics(value: unknown): ProviderResultDiagnostic[] {
  if (!Array.isArray(value)) return [];
  const sanitized: ProviderResultDiagnostic[] = [];
  for (const item of value.slice(0, MAX_SEARCH_RESULT_DIAGNOSTICS)) {
    if (!item || typeof item !== "object" || Array.isArray(item)) continue;
    const row = item as Record<string, unknown>;
    if (row.disposition !== "eligible" && row.disposition !== "filtered" && row.disposition !== "rejected") continue;
    if (row.sourceUrl !== null && (typeof row.sourceUrl !== "string" || row.sourceUrl.length > 2_048)) continue;
    if (row.sourceDomain !== null && (typeof row.sourceDomain !== "string" || row.sourceDomain.length > 253)) continue;
    if (row.reason !== null && (typeof row.reason !== "string" || !providerReasons.has(row.reason))) continue;
    if (row.evidenceId !== undefined && (typeof row.evidenceId !== "string" || !uuidPattern.test(row.evidenceId))) continue;
    if (row.originalResearchRunId !== undefined && row.originalResearchRunId !== null
      && (typeof row.originalResearchRunId !== "string" || !uuidPattern.test(row.originalResearchRunId))) continue;
    const location = row.sourceUrl === null ? { sourceUrl: null, sourceDomain: null }
      : safeResearchSourceLocation(row.sourceUrl as string);
    if (row.sourceUrl !== null && location.sourceUrl === null) continue;
    if (row.sourceDomain !== null && row.sourceDomain.toLowerCase().replace(/\.$/, "") !== location.sourceDomain) continue;
    // Providers cannot attest to database IDs. Those are attached only after lookup/insert.
    sanitized.push({ ...location, disposition: row.disposition, reason: row.reason as string | null });
  }
  return sanitized;
}

export class SearchResearchError extends Error {
  constructor(readonly code: "research_run_isolated" | "search_persistence_failed") {
    super(code);
    this.name = "SearchResearchError";
  }
}

const defaultDependencies: SearchResearchDependencies = {
  now: () => new Date(),
  validateUrl: (value) => validateSafeResearchUrl(value),
};

function canonicalUrlKey(url: URL): string {
  const copy = new URL(url);
  copy.hash = "";
  return copy.toString();
}

function normalizeResult(value: unknown): SearchResult | null {
  const parsed = SearchResultSchema.safeParse(value);
  if (!parsed.success) return null;
  let url: URL;
  try { url = new URL(parsed.data.url); } catch { return null; }
  if (!(["http:", "https:"].includes(url.protocol)) || url.username || url.password) return null;
  const sourceDomain = parsed.data.sourceDomain.toLowerCase().replace(/\.$/, "");
  if (sourceDomain !== url.hostname.toLowerCase().replace(/\.$/, "")) return null;
  url.hash = "";
  return { ...parsed.data, url: url.toString(), sourceDomain };
}

/** Searches for candidate source material and stores bounded snippets as untrusted evidence. */
export async function collectSearchEvidence(
  company: SearchResearchCompany,
  researchRunId: string,
  provider: CompanySearchProvider,
  store: SearchResearchStore,
  dependencies: SearchResearchDependencies = defaultDependencies,
): Promise<SearchResearchResult> {
  const emptyDiagnostics = (): SearchStageDiagnostics => ({
    resultsReturned: 0,
    resultsFilteredIrrelevant: 0,
    resultsRejectedSafety: 0,
    resultsSkippedDuplicates: 0,
    resultsReused: 0,
    resultsPersisted: 0,
    providerFailureCode: null,
    resultDetails: [],
  });
  if (!provider.enabled) return { evidence: [], reusedEvidence: [], diagnostics: emptyDiagnostics() };

  const run = await store.getRun(researchRunId);
  if (!run || run.company_id !== company.id || run.status !== "running") {
    throw new SearchResearchError("research_run_isolated");
  }

  let rawResults: SearchResult[];
  const diagnostics = emptyDiagnostics();
  try {
    const query = { companyName: company.name, domain: company.domain };
    if (provider.searchWithDiagnostics) {
      const output = await provider.searchWithDiagnostics(query);
      rawResults = output.results;
      diagnostics.resultsReturned = output.resultsReturned;
      diagnostics.resultsFilteredIrrelevant = output.resultsFilteredIrrelevant;
      diagnostics.resultsRejectedSafety = output.resultsRejectedSafety;
      // Reserve room for the collector's persisted/reused attribution (at most 10 results).
      diagnostics.resultDetails = sanitizeProviderDiagnostics(output.resultDiagnostics)
        .filter((row) => row.disposition !== "eligible")
        .slice(0, MAX_SEARCH_RESULT_DIAGNOSTICS - MAX_SEARCH_RESULTS_PER_RUN);
    } else {
      rawResults = await provider.search(query);
      diagnostics.resultsReturned = Array.isArray(rawResults) ? rawResults.length : 0;
    }
  } catch (error) {
    // Search is supplementary. A provider outage must not discard official-site research.
    const code = error && typeof error === "object" && "code" in error ? error.code : null;
    const allowedCodes = new Set([
      "tavily_timeout", "tavily_rate_limited", "tavily_unavailable", "tavily_invalid_response",
    ]);
    diagnostics.providerFailureCode = typeof code === "string" && allowedCodes.has(code)
      ? code
      : "search_provider_failed";
    if (error instanceof TavilySearchError && error.diagnostic) {
      diagnostics.providerFailureDiagnostic = error.diagnostic;
    }
    return { evidence: [], reusedEvidence: [], diagnostics };
  }
  if (!Array.isArray(rawResults)) {
    diagnostics.providerFailureCode = "search_provider_invalid_results";
    return { evidence: [], reusedEvidence: [], diagnostics };
  }

  const seen = new Set<string>();
  const eligibleDetailsByUrl = new Map<string, SearchResultDiagnostic>();
  const duplicateDetailsByUrl = new Map<string, SearchResultDiagnostic[]>();
  const preparedByUrl = new Map<string, { url: string; row: SearchEvidenceInsert }>();
  for (const candidate of rawResults.slice(0, MAX_SEARCH_RESULTS_PER_RUN)) {
    const result = normalizeResult(candidate);
    if (!result) {
      diagnostics.resultsRejectedSafety += 1;
      addResultDetail(diagnostics.resultDetails, {
        url: candidate && typeof candidate === "object" && "url" in candidate && typeof candidate.url === "string" ? candidate.url : null,
        disposition: "rejected", reason: "malformed_search_result",
      });
      continue;
    }
    let safeUrl: URL;
    try { safeUrl = await dependencies.validateUrl(result.url); } catch {
      diagnostics.resultsRejectedSafety += 1;
      addResultDetail(diagnostics.resultDetails, { url: result.url, disposition: "rejected", reason: "unsafe_destination" });
      continue;
    }
    const urlKey = canonicalUrlKey(safeUrl);
    if (seen.has(urlKey)) {
      diagnostics.resultsSkippedDuplicates += 1;
      const detail = addResultDetail(diagnostics.resultDetails, { url: safeUrl.toString(), disposition: "filtered", reason: "duplicate_research_url" });
      if (detail) duplicateDetailsByUrl.set(urlKey, [...(duplicateDetailsByUrl.get(urlKey) ?? []), detail]);
      continue;
    }
    seen.add(urlKey);
    const detail = addResultDetail(diagnostics.resultDetails, { url: safeUrl.toString(), disposition: "eligible", reason: null });
    if (detail) eligibleDetailsByUrl.set(urlKey, detail);
    const observedAt = dependencies.now().toISOString();
    const excerpt = JSON.stringify({
      pageTitle: result.title,
      readableTextExcerpt: result.snippet,
      title: result.title,
      snippet: result.snippet,
    });
    const row: SearchEvidenceInsert = {
      company_id: company.id,
      research_run_id: researchRunId,
      source_type: "search_result",
      source_name: result.sourceDomain,
      source_url: safeUrl.toString(),
      observed_at: observedAt,
      retrieved_at: observedAt,
      excerpt,
      content_hash: createHash("sha256").update(`${company.id}\n${safeUrl.toString()}\n${excerpt}`).digest("hex"),
      // Trusted domains receive a stronger source-quality confidence; snippets remain candidates.
      confidence: isTrustedResearchHost(safeUrl.hostname, getConfiguredTrustedResearchDomains()) ? 0.7 : 0.35,
      status: "candidate",
    };
    preparedByUrl.set(urlKey, { url: safeUrl.toString(), row });
  }

  if (preparedByUrl.size === 0) return { evidence: [], reusedEvidence: [], diagnostics };

  const existingRows = await store.getExistingEvidence(company.id, [...new Set([...preparedByUrl.values()].map(({ url }) => url))]);
  const existingByUrl = new Map<string, Record<string, unknown>>();
  for (const existing of existingRows) {
    if (existing.company_id !== company.id || typeof existing.source_url !== "string") continue;
    try {
      const key = canonicalUrlKey(new URL(existing.source_url));
      const current = existingByUrl.get(key);
      const currentObserved = typeof current?.observed_at === "string" ? Date.parse(current.observed_at) : -Infinity;
      const observed = typeof existing.observed_at === "string" ? Date.parse(existing.observed_at) : -Infinity;
      if (!current || observed > currentObserved) existingByUrl.set(key, existing);
    } catch { /* malformed historical URLs are not reusable */ }
  }

  const freshRows: SearchEvidenceInsert[] = [];
  const reusedEvidence: Array<Record<string, unknown>> = [];
  for (const [key, prepared] of preparedByUrl) {
    const existing = existingByUrl.get(key);
    if (existing) {
      diagnostics.resultsSkippedDuplicates += 1;
      // Reuse the stored row unchanged: its source, confidence, status, dates,
      // and original research_run_id remain the authoritative provenance.
      reusedEvidence.push(existing);
      updateEligibleDetail(eligibleDetailsByUrl, prepared.url, "reused", null, existing);
      attributeDuplicateDetails(duplicateDetailsByUrl, prepared.url, existing, true);
    } else {
      freshRows.push(prepared.row);
    }
  }

  let persisted: Array<Record<string, unknown>> = [];
  if (freshRows.length > 0) {
    persisted = await store.insertEvidence(freshRows);
    diagnostics.resultsPersisted = persisted.length;
    const persistedByUrl = new Map<string, Array<Record<string, unknown>>>();
    for (const row of persisted) {
      if (row.company_id !== company.id || typeof row.source_url !== "string") continue;
      try {
        const key = canonicalUrlKey(new URL(row.source_url));
        persistedByUrl.set(key, [...(persistedByUrl.get(key) ?? []), row]);
      } catch { /* malformed returned URL has no attributable diagnostic */ }
    }
    for (const [key, rows] of persistedByUrl) {
      if (rows.length === 1) {
        updateEligibleDetail(eligibleDetailsByUrl, rows[0].source_url as string, "persisted", null, rows[0]);
        attributeDuplicateDetails(duplicateDetailsByUrl, rows[0].source_url as string, rows[0], false);
      }
      else markAmbiguousAttribution(eligibleDetailsByUrl, key);
    }
    if (persisted.length < freshRows.length) {
      const insertedKeys = new Set(persisted.flatMap((row) => {
        if (row.company_id !== company.id || typeof row.source_url !== "string") return [];
        try { return [canonicalUrlKey(new URL(row.source_url))]; } catch { return []; }
      }));
      const racedUrls = freshRows.flatMap((row) => {
        const key = canonicalUrlKey(new URL(row.source_url));
        return insertedKeys.has(key) ? [] : [row.source_url];
      });
      const racedRows = await store.getExistingEvidence(company.id, racedUrls);
      const racedByUrl = new Map<string, Record<string, unknown>>();
      for (const row of racedRows) {
        if (row.company_id !== company.id || typeof row.source_url !== "string") continue;
        try { racedByUrl.set(canonicalUrlKey(new URL(row.source_url)), row); } catch { /* not reusable */ }
      }
      const reusedAfterConflict = racedUrls.flatMap((url) => {
        try {
          const row = racedByUrl.get(canonicalUrlKey(new URL(url)));
          return row ? [row] : [];
        } catch { return []; }
      });
      if (persisted.length + reusedAfterConflict.length !== freshRows.length) {
        throw new SearchResearchError("search_persistence_failed");
      }
      reusedEvidence.push(...reusedAfterConflict);
      for (const row of reusedAfterConflict) {
        if (typeof row.source_url === "string") {
          updateEligibleDetail(eligibleDetailsByUrl, row.source_url, "reused", "concurrent_duplicate", row);
          attributeDuplicateDetails(duplicateDetailsByUrl, row.source_url, row, true);
        }
      }
      diagnostics.resultsSkippedDuplicates += reusedAfterConflict.length;
    }
  }
  diagnostics.resultsReused += reusedEvidence.length;
  return { evidence: persisted, reusedEvidence, diagnostics };
}
