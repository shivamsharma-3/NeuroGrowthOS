import { beforeEach, describe, expect, it, vi } from "vitest";
vi.mock("server-only", () => ({}));

import { NO_SEARCH_PROVIDER } from "./search-provider";
import { buildTavilyQueries, createTavilySearchProvider } from "./tavily-provider";

function mockFetch(makeResponse: (query: string) => Response | Error) {
  return vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body)) as { query: string };
    const response = makeResponse(body.query);
    if (response instanceof Error) throw response;
    return response;
  }) as unknown as typeof fetch;
}

function resultsResponse(results: unknown[]) {
  return new Response(JSON.stringify({ results }), { status: 200 });
}

describe("Tavily search provider", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    vi.stubEnv("GROWTHOS_TRUSTED_RESEARCH_DOMAINS", "");
  });

  it("falls back to no-op when the server key is missing", async () => {
    const fetchImpl = mockFetch(() => new Error("must not fetch"));
    const provider = createTavilySearchProvider(undefined, fetchImpl);
    expect(provider).toBe(NO_SEARCH_PROVIDER);
    expect(provider.enabled).toBe(false);
    expect(await provider.search({ companyName: "Example Store", domain: "example.com" })).toEqual([]);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("builds domain-anchored queries for identity and each ICP research category", () => {
    const queries = buildTavilyQueries("GrowthOS Live Research Verification", "www.patagonia.com");
    expect(queries).toHaveLength(6);
    expect(queries.every(({ query }) => query.includes('"patagonia"')
      && query.includes('"www.patagonia.com"')
      && query.includes('"GrowthOS Live Research Verification"'))).toBe(true);
    const allQueries = queries.map(({ query }) => query).join(" ");
    expect(allQueries).toContain("company profile official business overview");
    expect(allQueries).toContain("industry products product categories business sector");
    expect(allQueries).toContain("ecommerce platform online store technology");
    expect(allQueries).toContain("headquarters based location country");
    expect(allQueries).toContain("number of employees company size team");
    expect(allQueries).toContain("annual revenue sales financial results");
  });

  it("prioritizes restricted official-profile and case-study searches only for configured trusted domains", () => {
    vi.stubEnv("GROWTHOS_TRUSTED_RESEARCH_DOMAINS", "linkedin.com,shopify.com,bcorporation.net,untrusted.example");
    const queries = buildTavilyQueries("Bombas", "bombas.com");
    expect(queries).toHaveLength(9);
    expect(queries.slice(0, 3)).toEqual([
      { query: '"bombas" "bombas.com" "Bombas" official LinkedIn company profile industry headquarters employees', includeDomains: ["linkedin.com"] },
      { query: '"bombas" "bombas.com" "Bombas" official Shopify case study ecommerce platform migration', includeDomains: ["shopify.com"] },
      { query: '"bombas" "bombas.com" "Bombas" official B Corp company profile certification industry headquarters', includeDomains: ["bcorporation.net"] },
    ]);
    expect(queries.slice(3).every(({ includeDomains }) => includeDomains === undefined)).toBe(true);
  });

  it("keeps only company-relevant results, normalizes them, and deduplicates across targeted queries", async () => {
    const fetchImpl = mockFetch(() => resultsResponse([
      { title: "Patagonia repairs and product care", url: "https://news.example.org/patagonia#section", content: "Patagonia describes repair services for its products." },
      { title: "Accenture invests in Wevo", url: "https://news.example.org/wevo", content: "GrowthOS is mentioned in this investment story." },
      { title: "Other company", url: "https://other.example.org/company", content: "Generic company profile." },
      { title: "Unsafe scheme", url: "javascript:alert(1)", content: "Patagonia" },
    ]));
    const provider = createTavilySearchProvider("test-only-token", fetchImpl);
    const results = await provider.search({ companyName: "Patagonia", domain: "patagonia.com" });

    expect(provider.enabled).toBe(true);
    expect(results).toEqual([{
      title: "Patagonia repairs and product care",
      url: "https://news.example.org/patagonia",
      sourceDomain: "news.example.org",
      snippet: "Patagonia describes repair services for its products.",
    }]);
    expect(fetchImpl).toHaveBeenCalledTimes(6);
    const calls = vi.mocked(fetchImpl).mock.calls;
    expect(calls.every(([url, options]) => url === "https://api.tavily.com/search"
      && options?.method === "POST"
      && options?.redirect === "error"
      && options?.cache === "no-store")).toBe(true);
    const requestBodies = calls.map(([, options]) => JSON.parse(String(options?.body)) as Record<string, unknown>);
    expect(requestBodies.map((body) => body.query)).toEqual(buildTavilyQueries(
      "Patagonia", "patagonia.com",
    ).map(({ query }) => query));
    expect(requestBodies.every((body) => body.search_depth === "basic" && body.max_results === 2
      && body.include_answer === false && body.include_raw_content === false)).toBe(true);
    expect(requestBodies[0].api_key).toBe("test-only-token");
  });

  it("sends trusted-domain restrictions and prioritizes fresh approved-source results", async () => {
    vi.stubEnv("GROWTHOS_TRUSTED_RESEARCH_DOMAINS", "linkedin.com,shopify.com,bcorporation.net");
    const fetchImpl = mockFetch((query) => {
      if (query.includes("LinkedIn")) return resultsResponse([
        { title: "Bombas | LinkedIn", url: "https://www.linkedin.com/company/bombas/", content: "Bombas company profile." },
      ]);
      if (query.includes("Shopify case study")) return resultsResponse([
        { title: "Bombas Shopify case study", url: "https://www.shopify.com/case-studies/bombas", content: "Bombas migrated its ecommerce store." },
      ]);
      if (query.includes("B Corp")) return resultsResponse([
        { title: "Bombas | Certified B Corporation", url: "https://www.bcorporation.net/find-a-b-corp/company/bombas", content: "Bombas is a certified B Corporation." },
      ]);
      return resultsResponse([]);
    });
    const provider = createTavilySearchProvider("test-only-token", fetchImpl);
    const results = await provider.search({ companyName: "Bombas", domain: "bombas.com" });

    expect(results.map(({ sourceDomain }) => sourceDomain)).toEqual([
      "www.linkedin.com", "www.shopify.com", "www.bcorporation.net",
    ]);
    const requestBodies = vi.mocked(fetchImpl).mock.calls.map(([, options]) =>
      JSON.parse(String(options?.body)) as Record<string, unknown>);
    expect(requestBodies.slice(0, 3).map(({ include_domains, include_domains_mode }) => ({ include_domains, include_domains_mode })))
      .toEqual([
        { include_domains: ["linkedin.com"], include_domains_mode: "restrict" },
        { include_domains: ["shopify.com"], include_domains_mode: "restrict" },
        { include_domains: ["bcorporation.net"], include_domains_mode: "restrict" },
      ]);
    expect(requestBodies.slice(0, 3).map(({ query }) => query)).toEqual(
      buildTavilyQueries("Bombas", "bombas.com").slice(0, 3).map(({ query }) => query),
    );
  });

  it("filters Bombas namesakes while keeping the genuine profile and a supported case study", async () => {
    vi.stubEnv("GROWTHOS_TRUSTED_RESEARCH_DOMAINS", "linkedin.com,shopify.com,bcorporation.net");
    const fetchImpl = mockFetch(() => resultsResponse([
      { title: "Bombas Klassen", url: "https://www.linkedin.com/company/bombas-klassen", content: "Bombas Klassen makes industrial pumps." },
      { title: "Bombas Rodase", url: "https://www.linkedin.com/company/bombas-rodase", content: "Bombas Rodase is based in Mexico." },
      { title: "Bombas | LinkedIn", url: "https://www.linkedin.com/company/bombas", content: "Bombas is an apparel company." },
      { title: "Bombas Shopify case study", url: "https://www.shopify.com/case-studies/bombas", content: "Shopify migrated the Bombas online store." },
    ]));
    const output = await createTavilySearchProvider("test-only-token", fetchImpl)
      .searchWithDiagnostics!({ companyName: "Bombas", domain: "bombas.com" });

    expect(output.results.map(({ url }) => url)).toEqual([
      "https://www.linkedin.com/company/bombas",
      "https://www.shopify.com/case-studies/bombas",
    ]);
    expect(output.resultDiagnostics?.filter(({ reason }) => reason === "company_identity_not_established")).toHaveLength(18);
    expect(output.resultDiagnostics?.some(({ sourceUrl }) => sourceUrl?.includes("bombas-klassen"))).toBe(true);
    expect(output.resultDiagnostics?.some(({ sourceUrl }) => sourceUrl?.includes("bombas-rodase"))).toBe(true);
  });

  it("reports aggregate returned and irrelevant counts without retaining provider payloads", async () => {
    const fetchImpl = mockFetch(() => resultsResponse([
      { title: "Patagonia company profile", url: "https://news.example.org/patagonia", content: "Patagonia" },
      { title: "Unrelated retailer", url: "https://other.example.org/store", content: "A different company" },
      { title: "Patagonia unsafe result", url: "javascript:alert(1)", content: "Patagonia" },
    ]));
    const provider = createTavilySearchProvider("test-only-token", fetchImpl);
    const output = await provider.searchWithDiagnostics!({ companyName: "Patagonia", domain: "patagonia.com" });
    expect(output.resultsReturned).toBe(18);
    expect(output.resultsFilteredIrrelevant).toBe(6);
    expect(output.resultsRejectedSafety).toBe(6);
    expect(output.results).toHaveLength(1);
    expect(output.resultDiagnostics).toHaveLength(18);
    expect(output.resultDiagnostics?.filter(({ disposition }) => disposition === "rejected")).toHaveLength(6);
    expect(output.resultDiagnostics?.filter(({ reason }) => reason === "company_identity_not_established")).toHaveLength(6);
    expect(output.resultDiagnostics?.filter(({ reason }) => reason === "duplicate_provider_url")).toHaveLength(5);
    expect(JSON.stringify(output)).not.toContain("test-only-token");
  });

  it("caps the aggregate normalized results at ten across all topic queries", async () => {
    let queryNumber = 0;
    const fetchImpl = mockFetch(() => {
      const index = queryNumber++;
      return resultsResponse([0, 1].map((item) => ({
        title: `Patagonia result ${index}-${item}`,
        url: `https://news.example.org/patagonia/${index}-${item}`,
        content: "Patagonia company information.",
      })));
    });
    const results = await createTavilySearchProvider("test-only-token", fetchImpl)
      .search({ companyName: "Patagonia", domain: "patagonia.com" });
    expect(fetchImpl).toHaveBeenCalledTimes(6);
    expect(results).toHaveLength(10);
  });

  it("maps rate limits to a safe provider error", async () => {
    const provider = createTavilySearchProvider("test-only-token", mockFetch(() => new Response("", { status: 429 })));
    await expect(provider.search({ companyName: "Example", domain: null }))
      .rejects.toMatchObject({ code: "tavily_rate_limited" });
  });

  it("handles HTTP errors, malformed JSON, and malformed response shapes safely", async () => {
    const context = { companyName: "Example", domain: null };
    await expect(createTavilySearchProvider("test-only-token", mockFetch(() => new Response("", { status: 503 }))).search(context))
      .rejects.toMatchObject({ code: "tavily_unavailable" });
    await expect(createTavilySearchProvider("test-only-token", mockFetch(() => new Response("not-json", {
      status: 200, headers: { "content-type": "application/json; charset=utf-8" },
    }))).search(context)).rejects.toMatchObject({
      code: "tavily_invalid_response",
      diagnostic: { reason: "invalid_json", httpStatus: 200, contentType: "application/json", responseExcerpt: null },
    });
    await expect(createTavilySearchProvider("test-only-token", mockFetch(() => new Response(JSON.stringify({ status: "ok" }), {
      status: 200, headers: { "content-type": "application/json" },
    }))).search(context)).rejects.toMatchObject({
      code: "tavily_invalid_response",
      diagnostic: { reason: "missing_results", httpStatus: 200, contentType: "application/json" },
    });
    await expect(createTavilySearchProvider("test-only-token", mockFetch(() => new Response(JSON.stringify({ results: "bad", api_key: "never-store-this-value" }), {
      status: 200, headers: { "content-type": "application/json" },
    }))).search(context)).rejects.toMatchObject({
      code: "tavily_invalid_response",
      diagnostic: { reason: "malformed_results", httpStatus: 200, contentType: "application/json" },
    });
  });

  it("stores a short safe plain-text excerpt but omits sensitive or unrecognized response content", async () => {
    const context = { companyName: "Example", domain: null };
    const safeProvider = createTavilySearchProvider("test-only-token", mockFetch(() => new Response("temporary provider error", {
      status: 200, headers: { "content-type": "text/plain; charset=utf-8" },
    })));
    await expect(safeProvider.search(context)).rejects.toMatchObject({
      diagnostic: {
        reason: "invalid_json", httpStatus: 200, contentType: "text/plain", responseExcerpt: "temporary provider error",
      },
    });

    const sensitive = "Authorization: Bearer abcdef0123456789abcdef0123456789";
    const sensitiveProvider = createTavilySearchProvider("test-only-token", mockFetch(() => new Response(sensitive, {
      status: 200, headers: { "content-type": "text/plain" },
    })));
    await expect(sensitiveProvider.search(context)).rejects.toMatchObject({
      code: "tavily_invalid_response",
      diagnostic: { responseExcerpt: null },
    });
  });

  it("limits diagnostic excerpts and reports a structural-only malformed results summary", async () => {
    const context = { companyName: "Example", domain: null };
    const longTextProvider = createTavilySearchProvider("test-only-token", mockFetch(() => new Response("safe ".repeat(300), {
      status: 200, headers: { "content-type": "text/plain" },
    })));
    try {
      await longTextProvider.search(context);
      throw new Error("expected malformed response");
    } catch (error) {
      const excerpt = (error as { diagnostic?: { responseExcerpt?: string | null } }).diagnostic?.responseExcerpt;
      expect(excerpt).toEqual(expect.any(String));
      expect(excerpt?.length).toBeLessThanOrEqual(512);
    }

    const malformedProvider = createTavilySearchProvider("test-only-token", mockFetch(() => new Response(JSON.stringify({
      results: [{ title: "private result body", url: "https://example.com", content: 42 }],
    }), { status: 200, headers: { "content-type": "application/json" } })));
    await expect(malformedProvider.search(context)).rejects.toMatchObject({
      diagnostic: {
        reason: "malformed_results",
        responseExcerpt: JSON.stringify({
          topLevelKeys: ["results"], resultsType: "array", firstResultType: "object", firstResultKeys: ["title", "url", "content"],
        }),
      },
    });
  });

  it("maps timeout and network errors without exposing provider details", async () => {
    const context = { companyName: "Example", domain: null };
    const timeoutProvider = createTavilySearchProvider(
      "test-only-token",
      mockFetch(() => Object.assign(new Error("private detail"), { name: "TimeoutError" })),
    );
    const failingProvider = createTavilySearchProvider("test-only-token", mockFetch(() => new Error("private detail")));
    await expect(timeoutProvider.search(context)).rejects.toMatchObject({ code: "tavily_timeout" });
    await expect(failingProvider.search(context)).rejects.toMatchObject({ code: "tavily_unavailable" });
  });
});
