import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import {
  collectOfficialWebsiteEvidence,
  isPublicAddress,
  OfficialWebsiteResearchError,
  type OfficialWebsiteDependencies,
  type OfficialWebsiteResponse,
} from "./official-website";

const company = { id: "af2b7bb2-21cc-46f2-97c3-b83bfdc990a2", website: "https://shop.example.org", domain: null };
const publicAddress = [{ address: "8.8.8.8", family: 4 as const }];
const html = `<!doctype html><html><head><title>Store &amp; Co</title><meta name="description" content="A great store"><link rel="canonical" href="/"></head><body><nav>Menu</nav><main><h1>Welcome</h1><p>We make thoughtful household goods for everyone and share information about the people and story behind our company.</p></main></body></html>`;
const ok: OfficialWebsiteResponse = {
  statusCode: 200,
  headers: { "content-type": "text/html; charset=utf-8" },
  body: html,
};

function dependencies(overrides: Partial<OfficialWebsiteDependencies> = {}): OfficialWebsiteDependencies {
  return {
    resolveHost: vi.fn(async () => publicAddress),
    request: vi.fn(async () => ok),
    now: () => new Date("2026-10-06T10:00:00.000Z"),
    timeoutMs: 1_000,
    ...overrides,
  };
}

function response(body: string, contentType = "text/html; charset=utf-8"): OfficialWebsiteResponse {
  return { statusCode: 200, headers: { "content-type": contentType }, body };
}

function lowContentHome(links = "", head = "") {
  return `<!doctype html><html><head><title>Hang Tight! Routing to checkout...</title>${head}</head><body><main><h1>Hang Tight!</h1><p>This page will automatically refresh shortly.</p>${links}</main></body></html>`;
}

function usefulPage(title: string, body = "Our company designs, makes, and sells thoughtfully produced goods. Learn about our team, the company, and our commitment to serving customers around the world.") {
  return `<!doctype html><html><head><title>${title}</title><meta name="description" content="${title} information from our company"></head><body><main><h1>${title}</h1><p>${body}</p></main></body></html>`;
}

describe("collectOfficialWebsiteEvidence", () => {
  it("preserves existing homepage metadata and candidate evidence behavior", async () => {
    const deps = dependencies({ request: vi.fn(async () => ok) });
    const result = await collectOfficialWebsiteEvidence(company, "b3054407-5e28-49b6-aceb-0284df07c8ff", deps);

    expect(result.metadata).toEqual({
      pageTitle: "Store & Co",
      metaDescription: "A great store",
      canonicalUrl: "https://shop.example.org/",
      readableTextExcerpt: "Welcome We make thoughtful household goods for everyone and share information about the people and story behind our company.",
    });
    expect(result.evidence).toHaveLength(1);
    expect(result.evidence[0]).toMatchObject({
      company_id: company.id,
      source_type: "official_website",
      source_url: "https://shop.example.org/",
      observed_at: "2026-10-06T10:00:00.000Z",
      retrieved_at: "2026-10-06T10:00:00.000Z",
      confidence: 0.7,
      status: "candidate",
    });
    expect(result.evidence[0].excerpt.length).toBeLessThan(3_000);
    expect(deps.request).toHaveBeenCalledTimes(1);
  });

  it("discovers and prefers useful same-origin internal pages when the homepage is low-content", async () => {
    const requested: string[] = [];
    const deps = dependencies({
      request: vi.fn(async (url: URL) => {
        requested.push(url.toString());
        if (url.pathname === "/") return response(lowContentHome('<a href="/contact">Contact</a><a href="/about">About</a>'));
        if (url.pathname === "/robots.txt") return { statusCode: 404, headers: {}, body: "" };
        if (url.pathname === "/sitemap.xml") return { statusCode: 404, headers: {}, body: "" };
        if (url.pathname === "/about") return response(usefulPage("About our company"));
        return { statusCode: 404, headers: {}, body: "Not found" };
      }),
    });

    const result = await collectOfficialWebsiteEvidence(company, "run-id", deps);

    expect(requested).toContain("https://shop.example.org/about");
    expect(result.evidence.map((item) => item.source_url)).toEqual(["https://shop.example.org/about"]);
    expect(JSON.parse(result.evidence[0].excerpt).pageTitle).toBe("About our company");
  });

  it("discovers same-origin pages from a sitemap", async () => {
    const requested: string[] = [];
    const deps = dependencies({
      request: vi.fn(async (url: URL) => {
        requested.push(url.toString());
        if (url.pathname === "/") return response(lowContentHome("", '<link rel="sitemap" href="/sitemap.xml">'));
        if (url.pathname === "/sitemap.xml") return response(
          "<?xml version=\"1.0\"?><urlset><url><loc>https://shop.example.org/pricing</loc></url><url><loc>https://shop.example.org/team</loc></url></urlset>",
          "application/xml",
        );
        if (url.pathname === "/pricing") return response(usefulPage("Pricing"));
        if (url.pathname === "/team") return response(usefulPage("Our Team"));
        return { statusCode: 404, headers: {}, body: "Not found" };
      }),
    });

    const result = await collectOfficialWebsiteEvidence(company, "run-id", deps);

    expect(requested).toContain("https://shop.example.org/sitemap.xml");
    expect(result.evidence.map((item) => item.source_url)).toEqual(expect.arrayContaining([
      "https://shop.example.org/team",
      "https://shop.example.org/pricing",
    ]));
  });

  it("deduplicates link variants before fetching a page", async () => {
    const requested: string[] = [];
    const links = ["/about", "/about/", "/about?utm_source=menu", "/about#team"]
      .map((url) => `<a href="${url}">About</a>`).join("");
    const deps = dependencies({
      request: vi.fn(async (url: URL) => {
        requested.push(url.toString());
        if (url.pathname === "/") return response(lowContentHome(links, '<link rel="sitemap" href="/sitemap.xml">'));
        if (url.pathname === "/sitemap.xml") return response("<urlset></urlset>", "application/xml");
        if (url.pathname === "/about") return response(usefulPage("About"));
        return { statusCode: 404, headers: {}, body: "Not found" };
      }),
    });

    await collectOfficialWebsiteEvidence(company, "run-id", deps);

    expect(requested.filter((url) => new URL(url).pathname === "/about")).toHaveLength(1);
  });

  it("fetches no more than five HTML pages in one research run", async () => {
    const pageUrls: string[] = [];
    const links = ["about", "about-us", "company", "contact", "team", "careers", "jobs", "pricing"]
      .map((path) => `<a href="/${path}">${path}</a>`).join("");
    const deps = dependencies({
      request: vi.fn(async (url: URL) => {
        if (url.pathname === "/") {
          pageUrls.push(url.toString());
          return response(lowContentHome(links, '<link rel="sitemap" href="/sitemap.xml">'));
        }
        if (url.pathname === "/sitemap.xml") return response("<urlset></urlset>", "application/xml");
        pageUrls.push(url.toString());
        return response(usefulPage(`Page ${url.pathname}`));
      }),
    });

    await collectOfficialWebsiteEvidence(company, "run-id", deps);

    expect(pageUrls).toHaveLength(5);
  });

  it("rejects external links and sitemap locations", async () => {
    const requested: string[] = [];
    const deps = dependencies({
      request: vi.fn(async (url: URL) => {
        requested.push(url.toString());
        if (url.pathname === "/") return response(lowContentHome(
          '<a href="https://attacker.example/about">About</a><a href="/about">Internal about</a>',
          '<link rel="sitemap" href="/sitemap.xml">',
        ));
        if (url.pathname === "/sitemap.xml") return response(
          "<urlset><url><loc>https://attacker.example/company</loc><loc>https://shop.example.org/about</loc></url></urlset>",
          "application/xml",
        );
        if (url.pathname === "/about") return response(usefulPage("About"));
        return { statusCode: 404, headers: {}, body: "Not found" };
      }),
    });

    await collectOfficialWebsiteEvidence(company, "run-id", deps);

    expect(requested.some((url) => new URL(url).origin === "https://attacker.example")).toBe(false);
    expect(requested).toContain("https://shop.example.org/about");
  });

  it("applies SSRF checks to discovered URLs and DNS results", async () => {
    let resolutionCount = 0;
    const requested: string[] = [];
    const deps = dependencies({
      resolveHost: vi.fn(async () => {
        resolutionCount += 1;
        return resolutionCount === 1 ? publicAddress : [{ address: "10.0.0.7", family: 4 as const }];
      }),
      request: vi.fn(async (url: URL) => {
        requested.push(url.toString());
        return response(lowContentHome('<a href="/about">About</a><a href="http://127.0.0.1/private">Private</a>', '<link rel="sitemap" href="/sitemap.xml">'));
      }),
    });

    const result = await collectOfficialWebsiteEvidence(company, "run-id", deps);

    expect(resolutionCount).toBeGreaterThan(1);
    expect(requested).toEqual(["https://shop.example.org/"]);
    expect(result.evidence).toEqual([]);
  });

  it("does not persist checkout or low-content pages when a useful page is found", async () => {
    const requested: string[] = [];
    const deps = dependencies({
      request: vi.fn(async (url: URL) => {
        requested.push(url.toString());
        if (url.pathname === "/") return response(lowContentHome('<a href="/checkout">Checkout</a><a href="/about">About</a>', '<link rel="sitemap" href="/sitemap.xml">'));
        if (url.pathname === "/sitemap.xml") return response("<urlset></urlset>", "application/xml");
        if (url.pathname === "/about") return response(usefulPage("Company story"));
        return { statusCode: 404, headers: {}, body: "Not found" };
      }),
    });

    const result = await collectOfficialWebsiteEvidence(company, "run-id", deps);

    expect(requested.some((url) => new URL(url).pathname === "/checkout")).toBe(false);
    expect(result.evidence.map((item) => item.source_url)).toEqual(["https://shop.example.org/about"]);
  });

  it.each(["http://localhost", "https://127.0.0.1", "file:///etc/passwd", "https://user:pass@example.com", "https://example.com:8443"])(
    "rejects invalid or unsafe URL %s before requesting",
    async (website) => {
      const request = vi.fn(async () => ok);
      await expect(collectOfficialWebsiteEvidence({ ...company, website }, "run", dependencies({ request })))
        .rejects.toBeInstanceOf(OfficialWebsiteResearchError);
      expect(request).not.toHaveBeenCalled();
    },
  );

  it("blocks private and reserved IPs", () => {
    for (const ip of ["127.0.0.1", "10.1.2.3", "172.16.0.1", "192.168.1.1", "169.254.1.1", "::1", "fc00::1", "2001:db8::1"]) {
      expect(isPublicAddress(ip)).toBe(false);
    }
    expect(isPublicAddress("8.8.8.8")).toBe(true);
  });

  it("blocks a private DNS result without making an HTTP request", async () => {
    const request = vi.fn(async () => ok);
    await expect(collectOfficialWebsiteEvidence(company, "run", dependencies({
      resolveHost: async () => [{ address: "10.0.0.7", family: 4 }], request,
    }))).rejects.toMatchObject({ code: "website_target_blocked" });
    expect(request).not.toHaveBeenCalled();
  });

  it("rejects unsafe cross-origin redirects", async () => {
    const request = vi.fn(async (): Promise<OfficialWebsiteResponse> => ({
      statusCode: 302, headers: { location: "https://external.example/about" }, body: "",
    }));
    await expect(collectOfficialWebsiteEvidence(company, "run", dependencies({ request })))
      .rejects.toMatchObject({ code: "website_redirect_blocked" });
    expect(request).toHaveBeenCalledTimes(1);
  });

  it("enforces timeouts, response-size limits, content types, and HTTP status", async () => {
    const timeoutRequest = vi.fn(() => new Promise<OfficialWebsiteResponse>(() => undefined));
    await expect(collectOfficialWebsiteEvidence(company, "run", dependencies({ request: timeoutRequest, timeoutMs: 10 })))
      .rejects.toMatchObject({ code: "website_timeout" });
    await expect(collectOfficialWebsiteEvidence(company, "run", dependencies({
      request: async () => response("x".repeat(1_000_001)),
    }))).rejects.toMatchObject({ code: "website_response_too_large" });
    await expect(collectOfficialWebsiteEvidence(company, "run", dependencies({
      request: async () => response("%PDF", "application/pdf"),
    }))).rejects.toMatchObject({ code: "website_non_html" });
    await expect(collectOfficialWebsiteEvidence(company, "run", dependencies({
      request: async () => ({ statusCode: 503, headers: {}, body: "unavailable" }),
    }))).rejects.toMatchObject({ code: "website_http_error" });
  });
});
