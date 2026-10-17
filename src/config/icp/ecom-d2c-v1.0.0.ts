import type { IcpFactorKey } from "@/types/icp";

export interface NumericBand {
  minimum: number;
  maximum: number | null;
  score: number;
}

export const ECOM_D2C_V1 = {
  version: "ecom-d2c-v1.0.0",
  baseCurrency: "USD",
  fxRatesToUsd: {
    // Fixed profile rates: USD per unit of currency, using ECB reference data dated 2026-09-29.
    // Change these only with a scoring-profile version update.
    USD: 1,
    EUR: 1 / 1.1355,
    GBP: 0.85718 / 1.1355,
    INR: 108.991 / 1.1355,
    CAD: 1.6101 / 1.1355,
    AUD: 1.6211 / 1.1355,
    JPY: 178.41 / 1.1355,
    SGD: 1.4504 / 1.1355,
  } as Readonly<Record<string, number>>,
  fxRatesAsOf: "2026-09-29",
  annualization: {
    annual: 1,
    quarterly: 4,
    monthly: 12,
  } as Readonly<Record<string, number>>,
  weights: {
    revenue: 25,
    industry: 20,
    platform: 15,
    geography: 10,
    company_size: 10,
    growth_signal: 20,
  } satisfies Record<IcpFactorKey, number>,
  minimumEvidence: {
    coveragePercent: 60,
    assessedFactors: 3,
    atLeastOneOf: ["revenue", "industry"] as const,
  },
  priorityBands: {
    high: 80,
    medium: 60,
  },
  factorStatus: {
    strongMinimum: 0.8,
    poorMaximum: 0.25,
  },
  revenueBands: [
    { minimum: 0, maximum: 1_000_000, score: 4 },
    { minimum: 1_000_000, maximum: 5_000_000, score: 12 },
    { minimum: 5_000_000, maximum: 10_000_000, score: 20 },
    { minimum: 10_000_000, maximum: 75_000_000, score: 25 },
    { minimum: 75_000_000, maximum: 150_000_000, score: 20 },
    { minimum: 150_000_000, maximum: 250_000_000, score: 12 },
    { minimum: 250_000_000, maximum: null, score: 4 },
  ] satisfies readonly NumericBand[],
  industry: {
    scores: { core: 20, adjacent: 14, related: 10, nonTarget: 4, unrelated: 0 },
    aliases: {
      core: ["d2c", "direct to consumer", "beauty", "cosmetics", "skincare", "apparel", "fashion", "wellness", "health and beauty", "food and beverage", "home goods", "consumer electronics"],
      adjacent: ["e commerce", "ecommerce", "online retail", "retail", "subscription commerce", "multi brand retail"],
      related: ["marketplace", "consumer products", "consumer goods", "retail technology"],
      nonTarget: ["wholesale", "agency", "marketing agency", "saas", "software"],
      unrelated: ["industrial manufacturing", "construction", "government", "nonprofit"],
    } as Readonly<Record<string, readonly string[]>>,
  },
  platform: {
    scores: { shopifyPlus: 15, shopify: 14, bigCommerce: 12, otherKnownCommerce: 10, customCommerce: 8, noCommerce: 0 },
    aliases: {
      shopifyPlus: ["shopify plus", "shopifyplus"],
      shopify: ["shopify"],
      bigCommerce: ["bigcommerce", "big commerce"],
      otherKnownCommerce: ["magento", "adobe commerce", "salesforce commerce", "salesforce commerce cloud", "woocommerce", "commercetools"],
      customCommerce: ["custom ecommerce", "custom e commerce", "headless commerce"],
      noCommerce: ["none", "no ecommerce", "no e commerce platform"],
    } as Readonly<Record<string, readonly string[]>>,
  },
  geography: {
    scores: { priority: 10, supported: 6, limited: 3, excluded: 0 },
    countryAliases: {
      priority: ["us", "usa", "united states", "united states of america", "ca", "canada", "gb", "uk", "united kingdom", "au", "australia"],
      supported: ["de", "germany", "fr", "france", "nl", "netherlands", "ie", "ireland", "nz", "new zealand", "sg", "singapore"],
      limited: ["in", "india", "br", "brazil", "mx", "mexico", "za", "south africa"],
    } as Readonly<Record<string, readonly string[]>>,
    explicitlyExcluded: ["kp", "north korea"] as readonly string[],
  },
  companySizeBands: [
    { minimum: 0, maximum: 1, score: 2 },
    { minimum: 2, maximum: 9, score: 4 },
    { minimum: 10, maximum: 19, score: 7 },
    { minimum: 20, maximum: 500, score: 10 },
    { minimum: 501, maximum: 1_000, score: 7 },
    { minimum: 1_001, maximum: 5_000, score: 4 },
    { minimum: 5_001, maximum: null, score: 2 },
  ] satisfies readonly NumericBand[],
  growthSignals: {
    points: { recent_funding: 5, relevant_hiring: 5, market_expansion: 5, verified_growth: 5 },
    maxAgeDays: { recent_funding: 548, relevant_hiring: 180, market_expansion: 365, verified_growth: 180 },
    minimumConfidence: 0.6,
    researchedNoSignalScore: 8,
    verifiedContractionScore: 0,
  },
} as const;
