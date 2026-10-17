import { describe, expect, it } from "vitest";
import { ECOM_D2C_V1 } from "@/config/icp/ecom-d2c-v1.0.0";
import { scoreIcp } from "@/lib/icp/scorer";
import type { IcpCompanyInput } from "@/types/icp";

const base = (): IcpCompanyInput => ({
  revenue: { amount: 10_000_000, currency: "USD", period: "annual", source: "manual", observedAt: "2026-09-01", legacyEstimatedRevenue: null },
  industry: "D2C", platform: "Shopify Plus", country: "United States", employeeCount: 50, growthSignals: null,
});
const asOf = new Date("2026-09-30T00:00:00.000Z");

describe("ecom-d2c-v1.0.0 deterministic scorer", () => {
  it("uses a 100-point profile and highest-fit revenue boundaries", () => {
    expect(Object.values(ECOM_D2C_V1.weights).reduce((a, b) => a + b, 0)).toBe(100);
    expect(scoreIcp({ ...base(), revenue: { ...base().revenue, amount: 10_000_000 } }, asOf).factors.revenue.score).toBe(25);
    expect(scoreIcp({ ...base(), revenue: { ...base().revenue, amount: 75_000_000 } }, asOf).factors.revenue.score).toBe(20);
    expect(scoreIcp({ ...base(), revenue: { ...base().revenue, amount: 1_000_000 } }, asOf).factors.revenue.score).toBe(12);
  });
  it("keeps legacy revenue unknown without currency and period", () => {
    const result = scoreIcp({ ...base(), revenue: { amount: null, currency: null, period: null, source: null, observedAt: null, legacyEstimatedRevenue: 20_000_000 } }, asOf);
    expect(result.factors.revenue.status).toBe("unknown");
    expect(result.totalScore).toBeNull();
    expect(result.priority).toBe("insufficient_data");
  });
  it("normalizes industry and platform aliases", () => {
    const result = scoreIcp({ ...base(), industry: "Direct-to-Consumer", platform: "shopifyplus" }, asOf);
    expect(result.factors.industry.score).toBe(20);
    expect(result.factors.platform.score).toBe(15);
  });
  it("keeps unmapped attributes unknown rather than scoring them as a poor fit", () => {
    const result = scoreIcp({ ...base(), industry: "specialty pet supplies", platform: "unknown hosted platform", country: "Spain" }, asOf);
    expect(result.factors.industry.status).toBe("unknown");
    expect(result.factors.platform.status).toBe("unknown");
    expect(result.factors.geography.status).toBe("unknown");
  });
  it("computes weighted evidence coverage and insufficient data threshold", () => {
    const sparse = scoreIcp({ ...base(), revenue: { ...base().revenue, amount: -5 }, industry: null, platform: "Shopify", country: null, employeeCount: null }, asOf);
    expect(sparse.coverage.percent).toBe(15);
    expect(sparse.totalScore).toBeNull();
    const minimum = scoreIcp({ ...base(), revenue: { ...base().revenue, amount: 5_000_000 }, industry: "D2C", platform: "Shopify", country: null, employeeCount: null }, asOf);
    expect(minimum.coverage.percent).toBe(60);
    expect(minimum.totalScore).not.toBeNull();
  });
  it("uses configured priority boundaries", () => {
    const input = base();
    const high = scoreIcp(input, asOf);
    expect(high.priority).toBe("high");
    expect(high.totalScore).toBeGreaterThanOrEqual(ECOM_D2C_V1.priorityBands.high);
    const low = scoreIcp({ ...input, industry: "Industrial manufacturing", platform: "None", country: "North Korea", employeeCount: 8_000 }, asOf);
    expect(low.priority).toBe("low");
  });
  it("is repeatable for the same data and explicit timestamp", () => {
    expect(scoreIcp(base(), asOf)).toEqual(scoreIcp(base(), asOf));
  });
  it("rejects invalid dates and keeps unsupported revenue unknown", () => {
    expect(() => scoreIcp(base(), new Date("bad"))).toThrow(TypeError);
    const result = scoreIcp({ ...base(), revenue: { ...base().revenue, currency: "XYZ" } }, asOf);
    expect(result.factors.revenue.status).toBe("unknown");
  });
});
