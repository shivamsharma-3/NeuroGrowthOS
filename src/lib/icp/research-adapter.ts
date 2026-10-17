import { z } from "zod";
import { CompanyEvidenceSchema, CompanyFactSchema, CompanyGrowthSignalSchema } from "@/lib/research/schemas";
import { ECOM_D2C_V1 } from "@/config/icp/ecom-d2c-v1.0.0";
import type { CompanyFactKey } from "@/types/research";
import type { IcpCompanyInput, IcpFactorKey, IcpScoreResult } from "@/types/icp";

export interface IcpResearchProvenance {
  factId: string;
  evidenceId: string;
}

export type IcpResearchProvenanceMap = Partial<Record<Exclude<IcpFactorKey, "growth_signal">, IcpResearchProvenance>>;
export interface IcpGrowthSignalProvenance { signalId: string; evidenceId: string }

const FACT_TO_FACTOR: Record<CompanyFactKey, Exclude<IcpFactorKey, "growth_signal">> = {
  industry: "industry",
  geography: "geography",
  company_size: "company_size",
  revenue: "revenue",
  platform: "platform",
};

function canonicalValue(value: unknown): string {
  return JSON.stringify(value);
}

/**
 * Applies only accepted, current, schema-valid research facts to canonical scoring inputs.
 * Conflicting accepted rows fail closed for that factor rather than selecting one arbitrarily.
 */
export function adaptAcceptedResearchFacts(
  canonical: IcpCompanyInput,
  factRows: unknown[],
  evidenceRows: unknown[],
  asOf: Date,
  companyId: string,
): { input: IcpCompanyInput; provenance: IcpResearchProvenanceMap } {
  if (!Number.isFinite(asOf.getTime())) throw new TypeError("asOf must be a valid date.");
  const evidenceById = new Map<string, z.infer<typeof CompanyEvidenceSchema>>();
  for (const row of evidenceRows) {
    const parsed = CompanyEvidenceSchema.safeParse(row);
    if (parsed.success && parsed.data.company_id === companyId) evidenceById.set(parsed.data.id, parsed.data);
  }

  const currentByKey = new Map<CompanyFactKey, Array<z.infer<typeof CompanyFactSchema>>>();
  for (const row of factRows) {
    const parsed = CompanyFactSchema.safeParse(row);
    if (!parsed.success || parsed.data.status !== "accepted" || parsed.data.company_id !== companyId) continue;
    const fact = parsed.data;
    const observedAt = Date.parse(fact.observed_at);
    if (observedAt > asOf.getTime() || (fact.valid_until !== null && Date.parse(fact.valid_until) <= asOf.getTime())) continue;
    const evidence = evidenceById.get(fact.source_evidence_id);
    if (!evidence || evidence.company_id !== fact.company_id) continue;
    if (["stale", "rejected", "conflicted"].includes(evidence.status)) continue;
    const values = currentByKey.get(fact.fact_key) ?? [];
    values.push(fact);
    currentByKey.set(fact.fact_key, values);
  }

  const input: IcpCompanyInput = { ...canonical };
  const provenance: IcpResearchProvenanceMap = {};
  for (const [factKey, acceptedFacts] of currentByKey) {
    const distinctValues = new Set(acceptedFacts.map(({ value_jsonb }) => canonicalValue(value_jsonb)));
    if (distinctValues.size !== 1) continue;
    const selected = [...acceptedFacts].sort((a, b) =>
      Date.parse(b.observed_at) - Date.parse(a.observed_at) || a.id.localeCompare(b.id),
    )[0];
    const evidence = evidenceById.get(selected.source_evidence_id);
    if (!evidence) continue;

    switch (factKey) {
      case "industry":
        input.industry = selected.value_jsonb as string;
        break;
      case "geography":
        input.country = selected.value_jsonb as string;
        break;
      case "platform":
        input.platform = selected.value_jsonb as string;
        break;
      case "company_size":
        input.employeeCount = selected.value_jsonb as number;
        break;
      case "revenue": {
        const value = selected.value_jsonb as { amount: number; currency: string; period: IcpCompanyInput["revenue"]["period"] };
        input.revenue = {
          amount: value.amount,
          currency: value.currency,
          period: value.period,
          source: "accepted_company_fact",
          observedAt: selected.observed_at,
          legacyEstimatedRevenue: null,
        };
        break;
      }
    }
    provenance[FACT_TO_FACTOR[factKey]] = { factId: selected.id, evidenceId: selected.source_evidence_id };
  }

  return { input, provenance };
}

/** Maps only accepted, fresh, same-company growth signals with valid same-company evidence. */
export function adaptAcceptedGrowthSignals(
  canonical: IcpCompanyInput,
  signalRows: unknown[],
  evidenceRows: unknown[],
  researchedAt: string | null,
  asOf: Date,
  companyId: string,
): { input: IcpCompanyInput; provenance: IcpGrowthSignalProvenance[] } {
  if (!Number.isFinite(asOf.getTime())) throw new TypeError("asOf must be a valid date.");
  const evidenceById = new Map<string, z.infer<typeof CompanyEvidenceSchema>>();
  for (const row of evidenceRows) {
    const parsed = CompanyEvidenceSchema.safeParse(row);
    if (parsed.success && parsed.data.company_id === companyId) evidenceById.set(parsed.data.id, parsed.data);
  }
  const parsed = signalRows.flatMap((row) => {
    const result = CompanyGrowthSignalSchema.safeParse(row);
    return result.success && result.data.company_id === companyId ? [result.data] : [];
  });
  const accepted = parsed.filter((signal) => {
    if (signal.status !== "accepted" || signal.confidence < ECOM_D2C_V1.growthSignals.minimumConfidence) return false;
    const eventAt = Date.parse(signal.observed_at);
    if (!Number.isFinite(eventAt) || eventAt > asOf.getTime()
      || (signal.valid_until !== null && Date.parse(signal.valid_until) <= asOf.getTime())) return false;
    const maxAge = ECOM_D2C_V1.growthSignals.maxAgeDays[signal.signal_type === "verified_contraction" ? "verified_growth" : signal.signal_type];
    if ((asOf.getTime() - eventAt) / 86_400_000 > maxAge) return false;
    const evidence = evidenceById.get(signal.evidence_id);
    return Boolean(evidence && evidence.company_id === signal.company_id && evidence.status !== "stale"
      && evidence.status !== "rejected" && evidence.status !== "conflicted");
  });

  // Fail closed if a same-date claim is still recorded with a conflicting status/value.
  const conflictKey = (signal: z.infer<typeof CompanyGrowthSignalSchema>) => `${signal.signal_type}:${Date.parse(signal.observed_at)}`;
  const acceptedKeys = new Set(accepted.map(conflictKey));
  const conflictedKeys = new Set(parsed.filter((signal) => acceptedKeys.has(conflictKey(signal))
    && signal.status !== "accepted" && signal.summary !== accepted.find((other) => conflictKey(other) === conflictKey(signal))?.summary)
    .map(conflictKey));
  const usable = accepted.filter((signal) => !conflictedKeys.has(conflictKey(signal)));
  const uniqueEvents = new Map<string, (typeof usable)[number]>();
  for (const signal of usable) {
    const key = conflictKey(signal);
    const prior = uniqueEvents.get(key);
    if (!prior || signal.id.localeCompare(prior.id) < 0) uniqueEvents.set(key, signal);
  }
  const ordered = [...uniqueEvents.values()].sort((a, b) => Date.parse(a.observed_at) - Date.parse(b.observed_at)
    || a.signal_type.localeCompare(b.signal_type) || a.id.localeCompare(b.id));
  const validResearchDate = researchedAt !== null && Number.isFinite(Date.parse(researchedAt)) && Date.parse(researchedAt) <= asOf.getTime()
    && (asOf.getTime() - Date.parse(researchedAt)) / 86_400_000 <= 365;
  const growthSignals = ordered.length > 0 || validResearchDate
    ? {
      researchedAt: validResearchDate ? researchedAt! : ordered.reduce((latest, signal) => {
        const retrieved = evidenceById.get(signal.evidence_id)?.retrieved_at ?? signal.observed_at;
        return Date.parse(retrieved) > Date.parse(latest) ? retrieved : latest;
      }, ordered[0]?.observed_at ?? asOf.toISOString()),
      signals: ordered.map((signal) => ({ type: signal.signal_type, observedAt: signal.observed_at, confidence: signal.confidence })),
    }
    : null;
  return {
    input: { ...canonical, growthSignals },
    provenance: ordered.map((signal) => ({ signalId: signal.id, evidenceId: signal.evidence_id })),
  };
}

/** Adds provenance to factor output without affecting the scorer's numerical result. */
export function attachIcpResearchProvenance(
  result: IcpScoreResult,
  provenance: IcpResearchProvenanceMap,
): IcpScoreResult {
  const factors = { ...result.factors };
  for (const [factorKey, reference] of Object.entries(provenance)) {
    if (!reference) continue;
    const key = factorKey as keyof typeof factors;
    const factor = factors[key];
    factors[key] = {
      ...factor,
      evidence: {
      ...factor.evidence,
      sourceFactId: reference.factId,
      sourceEvidenceId: reference.evidenceId,
      },
      reason: `${factor.reason} Accepted research fact ${reference.factId} is supported by evidence ${reference.evidenceId}.`,
    };
  }
  return { ...result, factors };
}

/** Attaches source IDs to the growth factor after scoring; it does not change points. */
export function attachIcpGrowthSignalProvenance(
  result: IcpScoreResult,
  provenance: IcpGrowthSignalProvenance[],
): IcpScoreResult {
  if (provenance.length === 0) return result;
  const factor = result.factors.growth_signal;
  return {
    ...result,
    factors: {
      ...result.factors,
      growth_signal: {
        ...factor,
        evidence: {
          ...factor.evidence,
          sourceSignalIds: provenance.map(({ signalId }) => signalId).join(","),
          sourceEvidenceIds: provenance.map(({ evidenceId }) => evidenceId).join(","),
        },
        reason: `${factor.reason} Accepted growth signal(s) ${provenance.map(({ signalId, evidenceId }) => `${signalId} (evidence ${evidenceId})`).join(", ")}.`,
      },
    },
  };
}
