import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import { extractCandidateCompanyFacts } from "./website-facts";

const evidence = {
  id: "b3054407-5e28-49b6-aceb-0284df07c8ff",
  company_id: "af2b7bb2-21cc-46f2-97c3-b83bfdc990a2",
  research_run_id: "ccddeeff-21cc-46f2-97c3-b83bfdc990a2",
  source_type: "official_website",
  source_name: "Official website",
  source_url: "https://example.com/about",
  observed_at: "2026-10-06T10:00:00.000Z",
  retrieved_at: "2026-10-06T10:00:00.000Z",
  confidence: 0.7,
  status: "candidate",
  content_hash: "a".repeat(64),
  created_at: "2026-10-06T10:00:00.000Z",
};

function fromText(readableTextExcerpt: string) {
  return extractCandidateCompanyFacts({ ...evidence, excerpt: JSON.stringify({ readableTextExcerpt }) });
}

function bombasSearchEvidence(readableTextExcerpt: string) {
  return {
    ...evidence,
    source_type: "search_result",
    source_name: "bcorporation.net",
    source_url: "https://www.bcorporation.net/find-a-b-corp/company/bombas",
    confidence: 0.35,
    excerpt: JSON.stringify({ pageTitle: "Bombas LLC - Certified B Corporation - B Lab", readableTextExcerpt }),
  };
}

function fromBombasSearchText(readableTextExcerpt: string) {
  return extractCandidateCompanyFacts(bombasSearchEvidence(readableTextExcerpt), {
    name: "Bombas",
    domain: "bombas.com",
  });
}

describe("extractCandidateCompanyFacts", () => {
  it("extracts explicit industry statements", () => {
    expect(fromText("Industry: Sustainable skincare")).toContainEqual(expect.objectContaining({
      fact_key: "industry", value_jsonb: "Sustainable skincare", status: "candidate",
    }));
  });

  it("extracts an explicit e-commerce platform", () => {
    expect(fromText("Our online store is built on Shopify Plus.")).toContainEqual(expect.objectContaining({
      fact_key: "platform", value_jsonb: "Shopify Plus",
    }));
  });

  it("extracts explicit claims from search evidence only as candidate facts", () => {
    const searchEvidence = {
      ...evidence,
      source_type: "search_result",
      source_name: "example.com",
      confidence: 0.35,
      excerpt: JSON.stringify({ readableTextExcerpt: "Example Store platform: Shopify Plus." }),
    };
    expect(extractCandidateCompanyFacts(searchEvidence, { name: "Example Store", domain: "example.com" })).toContainEqual(expect.objectContaining({
      fact_key: "platform",
      value_jsonb: "Shopify Plus",
      source_evidence_id: evidence.id,
      status: "candidate",
    }));
  });

  it("extracts Bombas-style industry and geography label/value layouts", () => {
    const facts = fromBombasSearchText([
      "# Bombas LLC",
      "Certified B Corporation",
      "Headquarters",
      "New York,United States",
      "Industry",
      "Apparel",
      "Sector",
      "Wholesale/Retail",
      "Operates In",
      "United States",
    ].join("\n"));

    expect(facts).toContainEqual(expect.objectContaining({ fact_key: "industry", value_jsonb: "Apparel" }));
    expect(facts).toContainEqual(expect.objectContaining({ fact_key: "geography", value_jsonb: "United States" }));
    expect(facts.every((candidate) => candidate.status === "candidate"
      && candidate.source_evidence_id === evidence.id && candidate.confidence === 0.35)).toBe(true);
  });

  it("extracts the pipe-delimited industry and headquarters format", () => {
    const facts = fromBombasSearchText("Bombas\n| Industry | Clothing |\n| Headquarters | New York City, United States |");
    expect(facts).toContainEqual(expect.objectContaining({ fact_key: "industry", value_jsonb: "Clothing" }));
    expect(facts).toContainEqual(expect.objectContaining({ fact_key: "geography", value_jsonb: "United States" }));
  });

  it("extracts a current explicit platform usage statement", () => {
    const text = "Bombas uses Shopify Plus for its online store.";
    expect(fromBombasSearchText(text)).toContainEqual(expect.objectContaining({
      fact_key: "platform", value_jsonb: "Shopify Plus", status: "candidate",
    }));
  });

  it.each([
    "Bombas migrated to Shopify Plus as its ecommerce platform.",
    "After migrating to Shopify Plus, Bombas saved $108,000 a year.",
    "Bombas turned to Shopify Plus to support its long-term growth.",
    "Bombas switched to Shopify Plus in 2020.",
  ])("does not treat historical/transition language as the current platform: %s", (text) => {
    expect(fromBombasSearchText(text).some((candidate) => candidate.fact_key === "platform")).toBe(false);
  });

  it("extracts an explicit New York-based location phrase", () => {
    expect(fromBombasSearchText("Bombas is a New York-based retail apparel and fashion brand.")).toContainEqual(
      expect.objectContaining({ fact_key: "geography", value_jsonb: "New York" }),
    );
  });

  it("does not extract third-party claims for unrelated or unidentified companies", () => {
    const searchEvidence = {
      ...evidence, source_type: "search_result", confidence: 0.7,
      excerpt: JSON.stringify({ pageTitle: "Acme profile", readableTextExcerpt: "Platform: Shopify Plus." }),
    };
    expect(extractCandidateCompanyFacts(searchEvidence, { name: "Example Store", domain: "example.com" })).toEqual([]);
    expect(extractCandidateCompanyFacts(searchEvidence)).toEqual([]);
  });

  it("extracts candidate facts from trusted third-party identity text without accepting them", () => {
    const searchEvidence = {
      ...evidence, source_type: "search_result", confidence: 0.7,
      excerpt: JSON.stringify({ pageTitle: "Example Store company profile", readableTextExcerpt: "Headquartered in Austin, Texas." }),
    };
    const facts = extractCandidateCompanyFacts(searchEvidence, { name: "Example Store", domain: "example.com" });
    expect(facts).toContainEqual(expect.objectContaining({ fact_key: "geography", value_jsonb: "Austin, Texas", status: "candidate" }));
  });

  it.each([
    ["Bombas Klassen", "https://www.linkedin.com/company/bombas-klassen", "Industrial Machinery Manufacturing"],
    ["Bombas Rodase", "https://www.linkedin.com/company/bombas-rodase", "Consumer Goods"],
  ])("does not extract Bombas facts from the namesake %s", (name, sourceUrl, industry) => {
    const searchEvidence = {
      ...evidence,
      source_type: "search_result",
      source_name: "www.linkedin.com",
      source_url: sourceUrl,
      confidence: 0.7,
      excerpt: JSON.stringify({ pageTitle: name, readableTextExcerpt: `${name}\nIndustry: ${industry}\nHeadquarters: Mexico` }),
    };
    expect(extractCandidateCompanyFacts(searchEvidence, {
      name: "Bombas", domain: "bombas.com", linkedin_url: "https://www.linkedin.com/company/bombas",
    })).toEqual([]);
  });

  it("keeps facts from the canonical Bombas company profile eligible as candidates", () => {
    const searchEvidence = {
      ...evidence,
      source_type: "search_result",
      source_name: "www.linkedin.com",
      source_url: "https://www.linkedin.com/company/bombas/",
      confidence: 0.7,
      excerpt: JSON.stringify({ pageTitle: "Bombas | LinkedIn", readableTextExcerpt: "Bombas\nIndustry: Retail Apparel and Fashion\nHeadquarters: New York, NY, United States" }),
    };
    const facts = extractCandidateCompanyFacts(searchEvidence, {
      name: "Bombas", domain: "bombas.com", linkedin_url: "https://www.linkedin.com/company/bombas",
    });
    expect(facts).toContainEqual(expect.objectContaining({ fact_key: "industry", value_jsonb: "Retail Apparel and Fashion" }));
    expect(facts.every(({ status }) => status === "candidate")).toBe(true);
  });

  it("extracts explicit geography", () => {
    expect(fromText("Headquartered in Austin, Texas.")).toContainEqual(expect.objectContaining({
      fact_key: "geography", value_jsonb: "Austin, Texas",
    }));
  });

  it("extracts explicit employee count as a nonnegative integer", () => {
    expect(fromText("Bombas employs 250 employees.")).toContainEqual(expect.objectContaining({
      fact_key: "company_size", value_jsonb: 250,
    }));
    expect(fromText("Company size: 1,250 employees.")).toContainEqual(expect.objectContaining({
      fact_key: "company_size", value_jsonb: 1250,
    }));
    expect(fromText("Employee count: 1,250.")).toContainEqual(expect.objectContaining({
      fact_key: "company_size", value_jsonb: 1250,
    }));
  });

  it("extracts an exact count explicitly listed in an Employees / Now section", () => {
    const text = [
      "Bombas: Jobs",
      "Industry: Retail Apparel and Fashion",
      "## Employees",
      "- Now: 296",
    ].join("\n");
    expect(fromBombasSearchText(text)).toContainEqual(expect.objectContaining({
      fact_key: "company_size", value_jsonb: 296, status: "candidate",
    }));
  });

  it("does not interpret a founding year before an Employees label as headcount", () => {
    const bombasExcerpt = "Founded: 2013  Employees: 250+  Industry: E-commerce  Location: New York, NY";
    expect(fromText(bombasExcerpt).some((item) => item.fact_key === "company_size")).toBe(false);
  });

  it("does not turn a lower-bound employee count into an exact count", () => {
    expect(fromText("Bombas has 250+ employees.").some((item) => item.fact_key === "company_size")).toBe(false);
  });

  it("does not turn approximate or ranged employee counts into exact values", () => {
    for (const statement of [
      "Over 500 employees.",
      "More than 500 employees.",
      "Team of 100-200 people.",
      "201–500 Employees.",
      "201-500 Employees.",
      "201 to 500 employees.",
    ]) {
      expect(fromText(statement).some((item) => item.fact_key === "company_size")).toBe(false);
    }
  });

  it("extracts revenue only with explicit currency and reporting period", () => {
    expect(fromText("Annual revenue of USD 12.5 million.")).toContainEqual(expect.objectContaining({
      fact_key: "revenue",
      value_jsonb: { amount: 12_500_000, currency: "USD", period: "annual" },
    }));
    expect(fromText("We generate $2 million in revenue.").some((item) => item.fact_key === "revenue")).toBe(false);
    expect(fromText("Annual revenue of $2 million.").some((item) => item.fact_key === "revenue")).toBe(false);
  });

  it("keeps unsupported Bombas revenue estimates unknown", () => {
    const snippets = [
      "Bombas generated an estimated $325 million in revenue in 2024.",
      "Bombas has over $325 million in annual revenue.",
      "Bombas has an estimated valuation of $3.42 billion.",
      "Bombas achieved over $1.3 billion in lifetime sales.",
      "Bombas's annual sales amounted to US$130m in 2025.",
    ];
    for (const snippet of snippets) {
      expect(fromBombasSearchText(snippet).some((item) => item.fact_key === "revenue"), snippet).toBe(false);
    }
  });

  it("leaves unsupported or missing information unknown", () => {
    expect(fromText("We make products customers love and serve people worldwide.")).toEqual([]);
  });

  it("preserves conflicting explicit claims as separate candidates", () => {
    const facts = fromText("Platform: Shopify. Platform: BigCommerce.");
    expect(facts.filter((item) => item.fact_key === "platform").map((item) => item.value_jsonb)).toEqual([
      "Shopify", "BigCommerce",
    ]);
    expect(facts.every((item) => item.status === "candidate")).toBe(true);
  });

  it("uses the exact source evidence id, company, confidence, and observed timestamp", () => {
    const [candidate] = fromText("Industry: Apparel");
    expect(candidate).toMatchObject({
      company_id: evidence.company_id,
      source_evidence_id: evidence.id,
      confidence: evidence.confidence,
      observed_at: evidence.observed_at,
      valid_until: null,
    });
  });

  it.each([
    null,
    { ...evidence, excerpt: "not-json" },
    { ...evidence, source_type: "third_party", excerpt: "{}" },
    { ...evidence, company_id: "not-a-uuid", excerpt: "{}" },
    { ...evidence, status: "stale", excerpt: JSON.stringify({ readableTextExcerpt: "Industry: Apparel" }) },
    { ...evidence, excerpt: JSON.stringify({ readableTextExcerpt: 10 }) },
  ])("returns no candidate facts for malformed or ineligible evidence", (input) => {
    expect(extractCandidateCompanyFacts(input)).toEqual([]);
  });
});
