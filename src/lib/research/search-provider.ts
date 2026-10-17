import "server-only";
import { z } from "zod";

export const MAX_SEARCH_RESULTS_PER_RUN = 10;

export const SearchResultSchema = z.object({
  title: z.string().trim().min(1).max(300),
  url: z.string().trim().min(1).max(2_048),
  sourceDomain: z.string().trim().min(1).max(253),
  snippet: z.string().trim().min(1).max(2_000),
});

export type SearchResult = z.infer<typeof SearchResultSchema>;

export type SearchResultDisposition = "eligible" | "persisted" | "reused" | "filtered" | "rejected";

/** Bounded, content-free attribution that can safely be stored in a run summary. */
export interface SearchResultDiagnostic {
  sourceUrl: string | null;
  sourceDomain: string | null;
  disposition: SearchResultDisposition;
  reason: string | null;
  evidenceId?: string;
  originalResearchRunId?: string | null;
}

export interface ProviderResultDiagnostic extends SearchResultDiagnostic {
  disposition: "eligible" | "filtered" | "rejected";
}

export const MAX_SEARCH_RESULT_DIAGNOSTICS = 40;

export interface CompanySearchQuery {
  companyName: string;
  domain: string | null;
}

/** Implementations must return normalized results; the research pipeline validates them again. */
export interface CompanySearchProvider {
  /** Stable, non-secret provider label persisted on research runs. */
  readonly name?: string;
  /** False for the safe no-op fallback. */
  readonly enabled: boolean;
  search(query: CompanySearchQuery): Promise<SearchResult[]>;
  /** Optional internal diagnostics; implementations must never include provider payloads or credentials. */
  searchWithDiagnostics?(query: CompanySearchQuery): Promise<{
    results: SearchResult[];
    resultsReturned: number;
    resultsFilteredIrrelevant: number;
    resultsRejectedSafety: number;
    resultDiagnostics?: ProviderResultDiagnostic[];
  }>;
}

/** Safe default until a real provider is deliberately configured. Makes no network calls. */
export const NO_SEARCH_PROVIDER: CompanySearchProvider = {
  name: "noop",
  enabled: false,
  async search() { return []; },
};
