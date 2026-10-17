import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import { evidenceMatchesCompanyIdentity } from "./source-quality";

const bombas = {
  name: "Bombas",
  domain: "bombas.com",
  website: "https://bombas.com",
  linkedin_url: "https://www.linkedin.com/company/bombas",
};

describe("evidenceMatchesCompanyIdentity", () => {
  it.each([
    ["Bombas Klassen", "https://www.linkedin.com/company/bombas-klassen"],
    ["Bombas Rodase", "https://www.linkedin.com/company/bombas-rodase"],
  ])("rejects the Bombas namesake %s", (name, sourceUrl) => {
    expect(evidenceMatchesCompanyIdentity(`${name} company profile.`, bombas, sourceUrl)).toBe(false);
  });

  it("accepts the canonical official Bombas LinkedIn profile", () => {
    expect(evidenceMatchesCompanyIdentity("Bombas | LinkedIn company profile", bombas, "https://linkedin.com/company/bombas/?trk=abc"))
      .toBe(true);
  });

  it("accepts a third-party profile or case study when the source URL and company name connect", () => {
    expect(evidenceMatchesCompanyIdentity("Bombas LLC - Certified B Corporation", bombas,
      "https://www.bcorporation.net/find-a-b-corp/company/bombas")).toBe(true);
    expect(evidenceMatchesCompanyIdentity("Bombas Shopify case study", bombas,
      "https://www.shopify.com/case-studies/bombas")).toBe(true);
  });

  it("does not treat a standalone company-name token as sufficient identity evidence", () => {
    expect(evidenceMatchesCompanyIdentity("Bombas raised Series B funding on October 1, 2026.", bombas,
      "https://news.example.org/funding-round")).toBe(false);
  });

  it("accepts explicit canonical-domain references in otherwise contextual text", () => {
    expect(evidenceMatchesCompanyIdentity("Bombas is the apparel brand at bombas.com", bombas,
      "https://news.example.org/company-profile")).toBe(true);
  });

  it.each([
    "bombas.com.evil.example", "notbombas.com", "bombas.com-evil.example",
    "bombas-klassen.com", "bombas-rodase.com",
  ])("does not accept a deceptive or namesake hostname %s as the canonical domain", (host) => {
    expect(evidenceMatchesCompanyIdentity(`Bombas company profile at ${host}`, bombas,
      "https://news.example.org/company-profile")).toBe(false);
  });

  it("normalizes domain case and accepts an intentional canonical subdomain", () => {
    expect(evidenceMatchesCompanyIdentity("Bombas is the apparel brand at HTTPS://SHOP.BOMBAS.COM/about", bombas,
      "https://news.example.org/company-profile")).toBe(true);
    expect(evidenceMatchesCompanyIdentity("Bombas is the apparel brand", bombas,
      "https://SHOP.BOMBAS.COM/about")).toBe(true);
  });
});
