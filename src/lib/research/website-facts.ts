import "server-only";
import { z } from "zod";
import {
  CompanyEvidenceSchema,
  RevenueFactValueSchema,
  ResearchRecordStatusSchema,
} from "@/lib/research/schemas";
import type { CompanyFactKey } from "@/types/research";
import { evidenceMatchesCompanyIdentity, type CompanyResearchIdentity } from "@/lib/research/source-quality";

const CandidateBaseSchema = z.object({
  company_id: z.string().uuid(),
  fact_key: z.enum(["industry", "geography", "company_size", "revenue", "platform"]),
  status: z.literal("candidate"),
  confidence: z.number().min(0).max(1),
  source_evidence_id: z.string().uuid(),
  observed_at: z.string().datetime({ offset: true }),
  valid_until: z.null(),
});

export const CandidateCompanyFactSchema = z.discriminatedUnion("fact_key", [
  CandidateBaseSchema.extend({ fact_key: z.literal("industry"), value_jsonb: z.string().trim().min(1) }),
  CandidateBaseSchema.extend({ fact_key: z.literal("geography"), value_jsonb: z.string().trim().min(1) }),
  CandidateBaseSchema.extend({ fact_key: z.literal("platform"), value_jsonb: z.string().trim().min(1) }),
  CandidateBaseSchema.extend({ fact_key: z.literal("company_size"), value_jsonb: z.number().int().nonnegative() }),
  CandidateBaseSchema.extend({ fact_key: z.literal("revenue"), value_jsonb: RevenueFactValueSchema }),
]);

export type CandidateCompanyFact = z.infer<typeof CandidateCompanyFactSchema>;

const WebsiteEvidenceInputSchema = CompanyEvidenceSchema.extend({
  source_type: z.enum(["official_website", "search_result"]),
  source_url: z.string().url().refine((value) => /^https?:\/\//i.test(value)),
  excerpt: z.string().min(1),
  confidence: z.number().min(0).max(1),
});

const WebsiteExcerptSchema = z.object({
  pageTitle: z.string().nullable().optional(),
  metaDescription: z.string().nullable().optional(),
  canonicalUrl: z.string().nullable().optional(),
  readableTextExcerpt: z.string().optional(),
}).passthrough();

const CURRENCY_SYMBOLS: Array<{ symbol: string; currency: string }> = [
  { symbol: "US$", currency: "USD" }, { symbol: "USD", currency: "USD" },
  { symbol: "€", currency: "EUR" }, { symbol: "EUR", currency: "EUR" },
  { symbol: "£", currency: "GBP" }, { symbol: "GBP", currency: "GBP" },
  { symbol: "₹", currency: "INR" }, { symbol: "INR", currency: "INR" },
  { symbol: "CAD", currency: "CAD" }, { symbol: "CA$", currency: "CAD" },
  { symbol: "AUD", currency: "AUD" }, { symbol: "A$", currency: "AUD" },
];

function fact(key: CompanyFactKey, value: unknown, evidence: z.infer<typeof WebsiteEvidenceInputSchema>): CandidateCompanyFact | null {
  const parsed = CandidateCompanyFactSchema.safeParse({
    company_id: evidence.company_id,
    fact_key: key,
    value_jsonb: value,
    status: "candidate",
    confidence: evidence.confidence,
    source_evidence_id: evidence.id,
    observed_at: evidence.observed_at,
    valid_until: null,
  });
  return parsed.success ? parsed.data : null;
}

function uniqueFacts(facts: Array<CandidateCompanyFact | null>): CandidateCompanyFact[] {
  const unique = new Map<string, CandidateCompanyFact>();
  for (const item of facts) {
    if (!item) continue;
    const key = `${item.fact_key}:${JSON.stringify(item.value_jsonb)}`;
    unique.set(key, item);
  }
  return [...unique.values()];
}

function extractText(excerpt: z.infer<typeof WebsiteExcerptSchema>): string {
  return [excerpt.readableTextExcerpt, excerpt.pageTitle, excerpt.metaDescription]
    .filter((value): value is string => typeof value === "string")
    .join("\n");
}

function extractIndustry(text: string, evidence: z.infer<typeof WebsiteEvidenceInputSchema>) {
  const values: Array<CandidateCompanyFact | null> = [];
  const patterns = [
    /\bindustry\s*:\s*([^.;\n]{2,80})/gi,
    /(?:^|\n)\s*\|\s*industry\s*\|\s*([^|\n]{2,80})\s*\|/gi,
    /(?:^|\n)\s*(?:#{1,6}\s*)?industry\s*\n\s*([^|\n]{2,80}?)(?=\n|$)/gi,
    /\b(?:we operate|the company operates|our business operates) in the ([^.;\n]{2,80}) industry\b/gi,
    /\b(?:we are|the company is) in the ([^.;\n]{2,80}) industry\b/gi,
  ];
  for (const pattern of patterns) {
    for (const match of text.matchAll(pattern)) values.push(fact("industry", match[1].trim(), evidence));
  }
  return values;
}

function extractPlatforms(text: string, evidence: z.infer<typeof WebsiteEvidenceInputSchema>) {
  const values: Array<CandidateCompanyFact | null> = [];
  const platformName = "(Shopify(?:\\s+Plus)?|BigCommerce|WooCommerce|Magento|Adobe Commerce|Salesforce Commerce Cloud)";
  const patterns = [
    new RegExp(`\\b(?:powered by|built on|runs on|hosted on)\\s+${platformName}\\b`, "gi"),
    new RegExp(`\\buses\\s+${platformName}\\b`, "gi"),
    new RegExp(`\\bplatform\\s*:\\s*${platformName}\\b`, "gi"),
    new RegExp(`\\b(?:our (?:online )?store|the store)\\s+(?:is|runs)\\s+(?:built on\\s+)?${platformName}\\b`, "gi"),
  ];
  for (const pattern of patterns) {
    for (const match of text.matchAll(pattern)) {
      const raw = match[1].replace(/\s+/g, " ");
      const normalized = raw.toLowerCase() === "shopify plus" ? "Shopify Plus"
        : raw.toLowerCase() === "shopify" ? "Shopify"
          : raw.toLowerCase() === "bigcommerce" ? "BigCommerce"
            : raw.toLowerCase() === "woocommerce" ? "WooCommerce"
              : raw.toLowerCase() === "magento" ? "Magento"
                : raw.toLowerCase() === "adobe commerce" ? "Adobe Commerce" : "Salesforce Commerce Cloud";
      values.push(fact("platform", normalized, evidence));
    }
  }
  return values;
}

function extractGeography(text: string, evidence: z.infer<typeof WebsiteEvidenceInputSchema>) {
  const values: Array<CandidateCompanyFact | null> = [];
  const normalizeExplicitLocation = (raw: string) => {
    const value = raw.trim().replace(/\s+/g, " ").replace(/\s*,\s*/g, ", ").replace(/[.,;]+$/, "");
    const explicitUsCountry = value.match(/(?:,\s*|\s+)(United States|U\.S\.A\.|USA|U\.S\.)$/i)?.[1];
    return explicitUsCountry ? "United States" : value;
  };
  const labeledPatterns = [
    /(?:^|\n)\s*\|\s*(?:headquarters|location|operates in)\s*\|\s*([^|\n]{2,80})\s*\|/gi,
    /(?:^|\n)\s*(?:headquarters|location|operates in)\s*(?::|\n)\s*([^|\n]{2,80}?)(?=\n|$)/gi,
  ];
  for (const pattern of labeledPatterns) {
    for (const match of text.matchAll(pattern)) {
      values.push(fact("geography", normalizeExplicitLocation(match[1]), evidence));
    }
  }
  const patterns = [
    /\b(?:headquartered|headquarters|based|located) in\s+([A-Z][A-Za-z.' -]{1,50}(?:,\s*[A-Z][A-Za-z.' -]{1,40})?)(?=[.;\n]|$)/gi,
    /\b(?:country|location)\s*:\s*([A-Z][A-Za-z.' -]{1,50})(?=[.;\n]|$)/gi,
    /\b([A-Z][A-Za-z.'-]*(?:\s+[A-Z][A-Za-z.'-]*)?)-based\b/g,
  ];
  for (const pattern of patterns) {
    for (const match of text.matchAll(pattern)) {
      values.push(fact("geography", normalizeExplicitLocation(match[1]), evidence));
    }
  }
  return values;
}

function extractCompanySize(text: string, evidence: z.infer<typeof WebsiteEvidenceInputSchema>) {
  const values: Array<CandidateCompanyFact | null> = [];
  const patterns = [
    /\b(?:company size|employee count|headcount|employees?)\s*:\s*([\d,]+)\b/gi,
    /\bemployees?\s*[-–—:]?\s*(?:\n\s*[-–—]\s*)?now\s*:\s*([\d,]+)\b/gi,
    /\b([\d,]+)\s+employees?\b/gi,
  ];
  for (const pattern of patterns) {
    for (const match of text.matchAll(pattern)) {
      const start = match.index ?? 0;
      const prefix = text.slice(Math.max(0, start - 32), start);
      const suffix = text.slice(start + match[0].length);
      if (/\b(?:over|more than|at least|about|approximately|around|nearly|almost|roughly|under|fewer than|less than)\s+$/i.test(prefix)) continue;
      if (/(?:\d\s*(?:-|–|—|to)\s*)$/i.test(prefix)) continue;
      if (/^\s*(?:-|–|—|to|\+)\s*\d?/i.test(suffix)) continue;
      // A number before "Employees:" is the preceding label's value, not the
      // employee count (for example: "Founded: 2013 Employees: 250+").
      if (/^\s*:/i.test(suffix)) continue;
      const foundingYearContext = /\b(?:founded|established)(?:\s+in)?\s*:?\s*$/i.test(prefix);
      if (foundingYearContext) continue;
      const count = Number(match[1].replaceAll(",", ""));
      if (Number.isSafeInteger(count) && count >= 0) values.push(fact("company_size", count, evidence));
    }
  }
  return values;
}

function extractRevenue(text: string, evidence: z.infer<typeof WebsiteEvidenceInputSchema>) {
  const values: Array<CandidateCompanyFact | null> = [];
  const currencyAlternation = CURRENCY_SYMBOLS.map(({ symbol }) => symbol.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
    .sort((a, b) => b.length - a.length).join("|");
  const numberAndMagnitude = "([0-9][0-9,]*(?:\\.[0-9]+)?)\\s*(million|billion|m|bn|k|crore|lakh)?";
  const period = "(annual(?:ly)?|yearly|per year|quarterly|per quarter|monthly|per month|lifetime)";
  const periodFirst = new RegExp(`\\b${period}\\s+revenue\\s*(?:of|is|:)?\\s*(${currencyAlternation})\\s*${numberAndMagnitude}`, "gi");
  const revenueFirst = new RegExp(`\\b(?:revenue|revenue stream)\\s*(?:of|is|:)?\\s*(${currencyAlternation})\\s*${numberAndMagnitude}\\s*(?:${period})`, "gi");
  const currencyFirst = new RegExp(`(?:^|\\b)(${currencyAlternation})\\s*${numberAndMagnitude}\\s*(?:in\\s+)?${period}\\s+revenue\\b`, "gi");

  const add = (currencyRaw: string | undefined, amountRaw: string | undefined, magnitudeRaw: string | undefined, periodRaw: string | undefined) => {
    if (!currencyRaw || !amountRaw || !periodRaw) return;
    const currency = CURRENCY_SYMBOLS.find(({ symbol }) => symbol.toLowerCase() === currencyRaw.toLowerCase())?.currency;
    if (!currency) return;
    const multipliers: Record<string, number> = {
      million: 1_000_000, m: 1_000_000, billion: 1_000_000_000, bn: 1_000_000_000,
      k: 1_000, crore: 10_000_000, lakh: 100_000,
    };
    const amountValue = Number(amountRaw) * (magnitudeRaw ? multipliers[magnitudeRaw.toLowerCase()] ?? 1 : 1);
    if (!Number.isFinite(amountValue)) return;
    const normalizedPeriod = /annual|yearly|per year/i.test(periodRaw) ? "annual"
      : /quarter/i.test(periodRaw) ? "quarterly"
        : /month/i.test(periodRaw) ? "monthly" : /lifetime/i.test(periodRaw) ? "lifetime" : null;
    if (!normalizedPeriod) return;
    values.push(fact("revenue", { amount: amountValue, currency, period: normalizedPeriod }, evidence));
  };

  for (const match of text.matchAll(periodFirst)) {
    add(match[2], match[3], match[4], match[1]);
  }
  for (const match of text.matchAll(revenueFirst)) add(match[1], match[2], match[3], match[4]);
  for (const match of text.matchAll(currencyFirst)) add(match[1], match[2], match[3], match[4]);
  return values;
}

/** Extracts only explicit, schema-valid claims from persisted website or search-result evidence. */
export function extractCandidateCompanyFacts(input: unknown, identity?: CompanyResearchIdentity): CandidateCompanyFact[] {
  const evidenceResult = WebsiteEvidenceInputSchema.safeParse(input);
  if (!evidenceResult.success || evidenceResult.data.status === "rejected" || evidenceResult.data.status === "stale") return [];

  let parsedExcerpt: unknown;
  try {
    parsedExcerpt = JSON.parse(evidenceResult.data.excerpt);
  } catch {
    return [];
  }
  const excerptResult = WebsiteExcerptSchema.safeParse(parsedExcerpt);
  if (!excerptResult.success) return [];

  const evidence = evidenceResult.data;
  const text = extractText(excerptResult.data);
  if (evidence.source_type === "search_result"
    && (!identity || !evidenceMatchesCompanyIdentity(text, identity, evidence.source_url))) return [];
  return uniqueFacts([
    ...extractIndustry(text, evidence),
    ...extractPlatforms(text, evidence),
    ...extractGeography(text, evidence),
    ...extractCompanySize(text, evidence),
    ...extractRevenue(text, evidence),
  ]).map((candidate) => CandidateCompanyFactSchema.parse({
    ...candidate,
    status: ResearchRecordStatusSchema.parse("candidate"),
  }));
}
