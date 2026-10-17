import { ECOM_D2C_V1 } from "@/config/icp/ecom-d2c-v1.0.0";
import { ICP_FACTOR_KEYS, type IcpCompanyInput, type IcpFactorKey, type IcpFactorResult, type IcpScoreResult, type RevenueEvidence } from "@/types/icp";

const normalize = (value: string) => value.trim().toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
const unknown = (maxScore: number, reason: string, evidence: Record<string, string | number | null> = {}): IcpFactorResult => ({ score: null, maxScore, status: "unknown", reason, evidence });
const known = (score: number, maxScore: number, reason: string, evidence: Record<string, string | number | null> = {}): IcpFactorResult => ({ score, maxScore, status: score / maxScore >= ECOM_D2C_V1.factorStatus.strongMinimum ? "strong" : score / maxScore <= ECOM_D2C_V1.factorStatus.poorMaximum ? "poor" : "partial", reason, evidence });

function revenueFactor(revenue: RevenueEvidence): IcpFactorResult {
  const max = ECOM_D2C_V1.weights.revenue;
  if (revenue.amount === null || !revenue.currency || !revenue.period || revenue.period === "unknown" || revenue.period === "lifetime") {
    const legacy = revenue.legacyEstimatedRevenue != null ? " Legacy estimated_revenue was ignored because currency and period are not known." : "";
    return unknown(max, `Revenue evidence requires an amount, currency, and annualizable period.${legacy}`);
  }
  if (!Number.isFinite(revenue.amount) || revenue.amount < 0) return unknown(max, "Revenue amount is invalid.");
  const currency = revenue.currency.trim().toUpperCase();
  const rate = ECOM_D2C_V1.fxRatesToUsd[currency];
  const multiplier = ECOM_D2C_V1.annualization[revenue.period];
  if (!rate || !multiplier) return unknown(max, `Revenue currency or period is unsupported (${currency}, ${revenue.period}).`);
  const annualUsd = revenue.amount * rate * multiplier;
  const band = ECOM_D2C_V1.revenueBands.find(({ minimum, maximum }) => annualUsd >= minimum && (maximum === null || annualUsd < maximum));
  if (!band) return unknown(max, "Revenue amount could not be matched to a scoring band.");
  return known(band.score, max, `Annualized revenue is approximately $${Math.round(annualUsd).toLocaleString("en-US")} USD, using ${currency} profile rate dated ${ECOM_D2C_V1.fxRatesAsOf}.`, { annualizedUsd: Math.round(annualUsd), currency, period: revenue.period, source: revenue.source });
}

function mappedFactor(value: string | null, max: number, groups: Record<string, number>, aliases: Record<string, readonly string[]>, label: string): IcpFactorResult {
  if (!value?.trim()) return unknown(max, `${label} is not known.`);
  const normalized = normalize(value);
  for (const [group, names] of Object.entries(aliases)) {
    if (names.some((alias) => normalize(alias) === normalized)) return known(groups[group] ?? 0, max, `${value} maps to ${group.replace(/([A-Z])/g, " $1").toLowerCase()} ${label.toLowerCase()} fit.`, { value, mapping: group });
  }
  return unknown(max, `${value} is not covered by the configured ${label.toLowerCase()} mappings.`, { value, mapping: "unmapped" });
}

function industryFactor(value: string | null): IcpFactorResult {
  const groups = ECOM_D2C_V1.industry.scores;
  return mappedFactor(value, ECOM_D2C_V1.weights.industry, groups, ECOM_D2C_V1.industry.aliases, "Industry");
}
function platformFactor(value: string | null): IcpFactorResult {
  const groups = ECOM_D2C_V1.platform.scores;
  return mappedFactor(value, ECOM_D2C_V1.weights.platform, groups, ECOM_D2C_V1.platform.aliases, "Platform");
}
function geographyFactor(value: string | null): IcpFactorResult {
  const max = ECOM_D2C_V1.weights.geography;
  if (!value?.trim()) return unknown(max, "Company country is not known.");
  const normalized = normalize(value);
  const { scores, countryAliases, explicitlyExcluded } = ECOM_D2C_V1.geography;
  const group = explicitlyExcluded.some((item) => normalize(item) === normalized) ? "excluded" : Object.entries(countryAliases).find(([, values]) => values.some((item) => normalize(item) === normalized))?.[0];
  if (!group) return unknown(max, `${value} is not covered by the configured geography mappings.`, { value, mapping: "unmapped" });
  const score = scores[group as keyof typeof scores];
  return known(score, max, `${value} is in the configured ${group} geography tier.`, { value, tier: group });
}
function sizeFactor(value: number | null): IcpFactorResult {
  const max = ECOM_D2C_V1.weights.company_size;
  if (value === null) return unknown(max, "Employee count is not known.");
  if (!Number.isInteger(value) || value < 0) return unknown(max, "Employee count is invalid.");
  const band = ECOM_D2C_V1.companySizeBands.find(({ minimum, maximum }) => value >= minimum && (maximum === null || value <= maximum));
  return band ? known(band.score, max, `${value.toLocaleString()} employees falls within a configured company size band.`, { employeeCount: value }) : unknown(max, "Employee count could not be matched to a scoring band.");
}
function growthFactor(input: IcpCompanyInput["growthSignals"], asOf: Date): IcpFactorResult {
  const max = ECOM_D2C_V1.weights.growth_signal;
  if (!input) return unknown(max, "Growth signals have not been researched.");
  const researchedAt = Date.parse(input.researchedAt);
  if (!Number.isFinite(researchedAt) || researchedAt > asOf.getTime()) return unknown(max, "Growth research date is invalid.");
  const ageDays = (asOf.getTime() - researchedAt) / 86_400_000;
  if (ageDays > 365) return unknown(max, "Growth research is older than one year.");
  let points = 0;
  const accepted: string[] = [];
  for (const signal of input.signals) {
    if (!Number.isFinite(signal.confidence) || signal.confidence < ECOM_D2C_V1.growthSignals.minimumConfidence) continue;
    const observedAt = Date.parse(signal.observedAt);
    if (!Number.isFinite(observedAt) || observedAt > asOf.getTime()) continue;
    const type = signal.type;
    const maxAge = ECOM_D2C_V1.growthSignals.maxAgeDays[type === "verified_contraction" ? "verified_growth" : type];
    if ((asOf.getTime() - observedAt) / 86_400_000 > maxAge) continue;
    if (type === "verified_contraction") { points = 0; accepted.push(type); continue; }
    points += ECOM_D2C_V1.growthSignals.points[type]; accepted.push(type);
  }
  if (!accepted.length) points = ECOM_D2C_V1.growthSignals.researchedNoSignalScore;
  return known(Math.min(points, max), max, accepted.length ? `Recent, sufficiently confident growth evidence: ${accepted.join(", ")}.` : "Recent research found no configured positive growth signals.", { researchedAt: input.researchedAt, signals: accepted.length });
}

export function scoreIcp(company: IcpCompanyInput, asOf = new Date()): IcpScoreResult {
  if (!Number.isFinite(asOf.getTime())) throw new TypeError("asOf must be a valid date.");
  if (!company || typeof company !== "object") throw new TypeError("Company scoring input is required.");
  const factors: Record<IcpFactorKey, IcpFactorResult> = {
    revenue: revenueFactor(company.revenue),
    industry: industryFactor(company.industry),
    platform: platformFactor(company.platform),
    geography: geographyFactor(company.country),
    company_size: sizeFactor(company.employeeCount),
    growth_signal: growthFactor(company.growthSignals, asOf),
  };
  const totalWeight = Object.values(ECOM_D2C_V1.weights).reduce((sum, weight) => sum + weight, 0);
  const assessed = ICP_FACTOR_KEYS.filter((key) => factors[key].score !== null);
  const assessedWeight = assessed.reduce((sum, key) => sum + factors[key].maxScore, 0);
  const percent = Math.round((assessedWeight / totalWeight) * 100);
  const enough = percent >= ECOM_D2C_V1.minimumEvidence.coveragePercent && assessed.length >= ECOM_D2C_V1.minimumEvidence.assessedFactors && ECOM_D2C_V1.minimumEvidence.atLeastOneOf.some((key) => factors[key].score !== null);
  const total = enough ? Math.round(assessed.reduce((sum, key) => sum + (factors[key].score ?? 0), 0) / assessedWeight * totalWeight) : null;
  const priority = total === null ? "insufficient_data" : total >= ECOM_D2C_V1.priorityBands.high ? "high" : total >= ECOM_D2C_V1.priorityBands.medium ? "medium" : "low";
  return { totalScore: total, priority, scoringStatus: total === null ? "insufficient_data" : "scored", scoreVersion: ECOM_D2C_V1.version, scoredAt: asOf.toISOString(), coverage: { assessedWeight, totalWeight, percent }, factors };
}
