import "server-only";
import { z } from "zod";
import {
  MAX_SEARCH_RESULT_DIAGNOSTICS,
  NO_SEARCH_PROVIDER,
  SearchResultSchema,
  type CompanySearchProvider,
  type ProviderResultDiagnostic,
} from "@/lib/research/search-provider";
import {
  evidenceMatchesCompanyIdentity,
  parseTrustedResearchDomains,
  safeResearchSourceLocation,
} from "./source-quality";

const TAVILY_SEARCH_URL = "https://api.tavily.com/search";
const REQUEST_TIMEOUT_MS = 8_000;
const MAX_RESULTS_PER_QUERY = 2;
const TRUSTED_SOURCE_SEARCHES = [
  { domain: "linkedin.com", query: "official LinkedIn company profile industry headquarters employees" },
  { domain: "shopify.com", query: "official Shopify case study ecommerce platform migration" },
  { domain: "bcorporation.net", query: "official B Corp company profile certification industry headquarters" },
] as const;
const SEARCH_TOPICS = [
  "company profile official business overview",
  "industry products product categories business sector",
  "ecommerce platform online store technology Shopify commerce",
  "headquarters based location country",
  "number of employees company size team",
  "annual revenue sales financial results",
] as const;

const RESPONSE_SCHEMA = z.object({
  results: z.array(z.object({
    title: z.string().optional().default(""),
    url: z.string().optional().default(""),
    content: z.string().optional().default(""),
  })),
});

export type TavilySearchErrorCode = "tavily_timeout" | "tavily_rate_limited" | "tavily_unavailable" | "tavily_invalid_response";

export interface TavilyFailureDiagnostic {
  reason: "invalid_json" | "missing_results" | "malformed_results";
  httpStatus: number;
  contentType: string | null;
  responseExcerpt: string | null;
}

export class TavilySearchError extends Error {
  constructor(readonly code: TavilySearchErrorCode, readonly diagnostic?: TavilyFailureDiagnostic) {
    super(code);
    this.name = "TavilySearchError";
  }
}

const MAX_DIAGNOSTIC_EXCERPT_LENGTH = 512;

function responseContentType(response: Response): string | null {
  const raw = response.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase();
  return raw && /^[a-z0-9!#$&^_.+-]+\/[a-z0-9!#$&^_.+-]+$/.test(raw) ? raw.slice(0, 100) : null;
}

function safeTextExcerpt(body: string, contentType: string | null): string | null {
  if (contentType !== "text/plain") return null;
  const excerpt = body.slice(0, MAX_DIAGNOSTIC_EXCERPT_LENGTH).replace(/[\u0000-\u001f\u007f]/g, " ").trim();
  // Omit rather than risk persisting credentials, personal data, URLs, or opaque tokens.
  if (!excerpt || /(?:api[_ -]?key|authorization|bearer|secret|token|password|email|https?:\/\/|www\.)/i.test(excerpt)
    || /\b[\w.+-]+@[\w.-]+\.[A-Za-z]{2,}\b/.test(excerpt)
    || /[A-Za-z0-9_-]{24,}/.test(excerpt)) return null;
  return excerpt;
}

function safeShapeExcerpt(payload: unknown): string {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    return JSON.stringify({ responseType: Array.isArray(payload) ? "array" : typeof payload });
  }
  const record = payload as Record<string, unknown>;
  const safeKeys = (value: unknown) => value && typeof value === "object" && !Array.isArray(value)
    ? Object.keys(value).filter((key) => /^[A-Za-z][A-Za-z0-9_]{0,39}$/.test(key)).slice(0, 20)
    : [];
  const results = record.results;
  const firstResult = Array.isArray(results) ? results[0] : undefined;
  return JSON.stringify({
    topLevelKeys: safeKeys(record),
    resultsType: results === undefined ? "missing" : Array.isArray(results) ? "array" : typeof results,
    firstResultType: firstResult === undefined ? null : Array.isArray(firstResult) ? "array" : typeof firstResult,
    firstResultKeys: safeKeys(firstResult),
  }).slice(0, MAX_DIAGNOSTIC_EXCERPT_LENGTH);
}

function invalidResponseDiagnostic(
  response: Response,
  reason: TavilyFailureDiagnostic["reason"],
  body: string,
  payload?: unknown,
): TavilyFailureDiagnostic {
  const contentType = responseContentType(response);
  return {
    reason,
    httpStatus: response.status,
    contentType,
    responseExcerpt: reason === "invalid_json"
      ? safeTextExcerpt(body, contentType)
      : safeShapeExcerpt(payload),
  };
}

export type FetchLike = typeof fetch;

function cleanQueryText(value: string): string {
  return value.replace(/["\\]/g, " ").replace(/\s+/g, " ").trim().slice(0, 160);
}

function domainBrand(domain: string): string {
  try {
    const host = new URL(domain.includes("://") ? domain : `https://${domain}`).hostname.toLowerCase().replace(/^www\./, "");
    const labels = host.split(".");
    const commonSecondLevel = new Set(["co", "com", "org", "net", "gov", "ac"]);
    const index = labels.length > 2 && commonSecondLevel.has(labels.at(-2) ?? "") ? labels.length - 3 : labels.length - 2;
    return labels[index] ?? "";
  } catch {
    return "";
  }
}

export interface TavilyQuery {
  query: string;
  includeDomains?: string[];
}

/** Prioritize domain-restricted searches for configured trusted sources, then broader categories. */
export function buildTavilyQueries(companyName: string, domain: string | null): TavilyQuery[] {
  const name = cleanQueryText(companyName);
  const exactDomain = domain ? cleanQueryText(domain.toLowerCase()) : "";
  const brand = domain ? domainBrand(domain) : "";
  const identity = [brand && `"${brand}"`, exactDomain && `"${exactDomain}"`, name && `"${name}"`]
    .filter(Boolean).join(" ");
  const trustedDomains = new Set(parseTrustedResearchDomains(process.env.GROWTHOS_TRUSTED_RESEARCH_DOMAINS)
    .map((trustedDomain) => trustedDomain.replace(/^www\./, "")));
  const trustedQueries = TRUSTED_SOURCE_SEARCHES
    .filter(({ domain: trustedDomain }) => trustedDomains.has(trustedDomain))
    .map(({ domain: trustedDomain, query }) => ({
      query: `${identity} ${query}`.slice(0, 500),
      includeDomains: [trustedDomain],
    }));
  const categoryQueries = SEARCH_TOPICS.map((topic) => ({ query: `${identity} ${topic}`.slice(0, 500) }));
  return [...trustedQueries, ...categoryQueries];
}

function resultMatchesCompany(
  item: { title: string; url: string; content: string },
  companyName: string,
  domain: string | null,
): boolean {
  return evidenceMatchesCompanyIdentity(item.title + " " + item.url + " " + item.content, { name: companyName, domain }, item.url);
}

export function createTavilySearchProvider(apiKey: string | undefined, fetchImpl: FetchLike = fetch): CompanySearchProvider {
  const key = apiKey?.trim();
  if (!key) return NO_SEARCH_PROVIDER;

  async function searchWithDiagnostics({ companyName, domain }: { companyName: string; domain: string | null }) {
    const queries = buildTavilyQueries(companyName, domain);
    const seenUrls = new Set<string>();
    const normalized = [];
    const resultDiagnostics: ProviderResultDiagnostic[] = [];
    let resultsReturned = 0;
    let resultsFilteredIrrelevant = 0;
    let resultsRejectedSafety = 0;

    for (const search of queries) {
      let response: Response;
      try {
        response = await fetchImpl(TAVILY_SEARCH_URL, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            api_key: key,
            query: search.query,
            search_depth: "basic",
            max_results: MAX_RESULTS_PER_QUERY,
            ...(search.includeDomains ? {
              include_domains: search.includeDomains,
              include_domains_mode: "restrict",
            } : {}),
            include_answer: false,
            include_raw_content: false,
          }),
          signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
          cache: "no-store",
          redirect: "error",
        });
      } catch (error) {
        if (error instanceof Error && (error.name === "TimeoutError" || error.name === "AbortError")) {
          throw new TavilySearchError("tavily_timeout");
        }
        throw new TavilySearchError("tavily_unavailable");
      }

      if (response.status === 429) throw new TavilySearchError("tavily_rate_limited");
      if (!response.ok) throw new TavilySearchError("tavily_unavailable");

      let body: string;
      let payload: unknown;
      try {
        body = await response.text();
      } catch {
        throw new TavilySearchError("tavily_invalid_response", invalidResponseDiagnostic(response, "invalid_json", ""));
      }
      try {
        payload = JSON.parse(body) as unknown;
      } catch {
        throw new TavilySearchError("tavily_invalid_response", invalidResponseDiagnostic(response, "invalid_json", body));
      }
      if (!payload || typeof payload !== "object" || Array.isArray(payload)
        || !Object.prototype.hasOwnProperty.call(payload, "results")) {
        throw new TavilySearchError("tavily_invalid_response", invalidResponseDiagnostic(response, "missing_results", body, payload));
      }
      const parsed = RESPONSE_SCHEMA.safeParse(payload);
      if (!parsed.success) {
        throw new TavilySearchError("tavily_invalid_response", invalidResponseDiagnostic(response, "malformed_results", body, payload));
      }

      for (const item of parsed.data.results) {
        resultsReturned += 1;
        let url: URL;
        try { url = new URL(item.url); } catch {
          resultsRejectedSafety += 1;
          if (resultDiagnostics.length < MAX_SEARCH_RESULT_DIAGNOSTICS) resultDiagnostics.push({
            ...safeResearchSourceLocation(item.url), disposition: "rejected", reason: "invalid_source_url",
          });
          continue;
        }
        if (!(url.protocol === "http:" || url.protocol === "https:") || url.username || url.password) {
          resultsRejectedSafety += 1;
          if (resultDiagnostics.length < MAX_SEARCH_RESULT_DIAGNOSTICS) resultDiagnostics.push({
            ...safeResearchSourceLocation(item.url), disposition: "rejected", reason: "unsafe_source_url",
          });
          continue;
        }
        url.hash = "";
        const sourceLocation = safeResearchSourceLocation(url.toString());
        if (!resultMatchesCompany(item, companyName, domain)) {
          resultsFilteredIrrelevant += 1;
          if (resultDiagnostics.length < MAX_SEARCH_RESULT_DIAGNOSTICS) resultDiagnostics.push({
            ...sourceLocation, disposition: "filtered", reason: "company_identity_not_established",
          });
          continue;
        }
        if (seenUrls.has(url.toString())) {
          if (resultDiagnostics.length < MAX_SEARCH_RESULT_DIAGNOSTICS) resultDiagnostics.push({
            ...sourceLocation, disposition: "filtered", reason: "duplicate_provider_url",
          });
          continue;
        }
        const result = SearchResultSchema.safeParse({
          title: item.title.slice(0, 300),
          url: url.toString(),
          sourceDomain: url.hostname.toLowerCase().replace(/\.$/, ""),
          snippet: item.content.slice(0, 2_000),
        });
        if (!result.success) {
          resultsRejectedSafety += 1;
          if (resultDiagnostics.length < MAX_SEARCH_RESULT_DIAGNOSTICS) resultDiagnostics.push({
            ...sourceLocation, disposition: "rejected", reason: "malformed_search_result",
          });
          continue;
        }
        seenUrls.add(url.toString());
        if (normalized.length < 10) {
          normalized.push(result.data);
          if (resultDiagnostics.length < MAX_SEARCH_RESULT_DIAGNOSTICS) resultDiagnostics.push({
            ...sourceLocation, disposition: "eligible", reason: null,
          });
        } else if (resultDiagnostics.length < MAX_SEARCH_RESULT_DIAGNOSTICS) {
          resultDiagnostics.push({ ...sourceLocation, disposition: "filtered", reason: "per_run_result_limit" });
        }
      }
    }
    return { results: normalized, resultsReturned, resultsFilteredIrrelevant, resultsRejectedSafety, resultDiagnostics };
  }

  return {
    name: "tavily",
    enabled: true,
    async search(query) { return (await searchWithDiagnostics(query)).results; },
    searchWithDiagnostics,
  };
}

/** Reads the server-only key lazily so missing configuration safely disables search. */
export function getConfiguredSearchProvider(): CompanySearchProvider {
  return createTavilySearchProvider(process.env.TAVILY_API_KEY);
}
