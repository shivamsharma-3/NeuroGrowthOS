import "server-only";
import { z } from "zod";
import { ECOM_D2C_V1 } from "@/config/icp/ecom-d2c-v1.0.0";
import { CompanyEvidenceSchema, CompanyGrowthSignalTypeSchema } from "@/lib/research/schemas";
import { evidenceMatchesCompanyIdentity, isTrustedResearchHost, getConfiguredTrustedResearchDomains, type CompanyResearchIdentity } from "@/lib/research/source-quality";

const EvidenceInput = CompanyEvidenceSchema.extend({
  source_type: z.enum(["official_website", "search_result"]),
  source_url: z.string().url(),
  excerpt: z.string().min(1),
  confidence: z.number().min(0).max(1),
});

export const CandidateGrowthSignalSchema = z.object({
  company_id: z.string().uuid(),
  signal_type: CompanyGrowthSignalTypeSchema,
  observed_at: z.string().datetime({ offset: true }),
  confidence: z.number().min(0).max(1),
  status: z.literal("candidate"),
  evidence_id: z.string().uuid(),
  summary: z.string().trim().min(1).max(600),
  valid_until: z.string().datetime({ offset: true }).nullable(),
});
export type CandidateGrowthSignal = z.infer<typeof CandidateGrowthSignalSchema>;

const ExcerptSchema = z.object({
  pageTitle: z.string().nullable().optional(),
  metaDescription: z.string().nullable().optional(),
  readableTextExcerpt: z.string().optional(),
  title: z.string().optional(),
  snippet: z.string().optional(),
}).passthrough();

function evidenceText(evidence: z.infer<typeof EvidenceInput>): string | null {
  try {
    const parsed = ExcerptSchema.safeParse(JSON.parse(evidence.excerpt));
    if (!parsed.success) return null;
    return [parsed.data.readableTextExcerpt, parsed.data.pageTitle, parsed.data.metaDescription, parsed.data.title, parsed.data.snippet]
      .filter((value): value is string => typeof value === "string").join("\n");
  } catch { return null; }
}

function trustedEvidence(evidence: z.infer<typeof EvidenceInput>, identity: CompanyResearchIdentity): boolean {
  if (evidence.confidence < ECOM_D2C_V1.growthSignals.minimumConfidence || !evidence.source_url) return false;
  let url: URL;
  try { url = new URL(evidence.source_url); } catch { return false; }
  if (url.protocol !== "https:" && url.protocol !== "http:") return false;
  if (evidence.source_type === "search_result" && !isTrustedResearchHost(url.hostname, getConfiguredTrustedResearchDomains())) return false;
  if (evidence.source_type === "official_website") {
    const companyHost = identity.domain ?? identity.website;
    if (!companyHost) return false;
    try {
      const host = new URL(companyHost.includes("://") ? companyHost : `https://${companyHost}`).hostname.replace(/^www\./, "").toLowerCase();
      if (url.hostname.replace(/^www\./, "").toLowerCase() !== host) return false;
    } catch { return false; }
  }
  const text = evidenceText(evidence);
  return !!text && evidenceMatchesCompanyIdentity(text, identity, evidence.source_url);
}

function explicitEventDate(sentence: string, now: Date): string | null {
  const monthIndex = (name: string) => ["january", "february", "march", "april", "may", "june", "july", "august", "september", "october", "november", "december"].indexOf(name.toLowerCase());
  let year: number; let month = 0; let day = 1;
  const iso = sentence.match(/(?<!\d)(20\d{2})-(0[1-9]|1[0-2])-([0-2]\d|3[01])(?!\d)/);
  const longDay = sentence.match(/(January|February|March|April|May|June|July|August|September|October|November|December)\s+([0-3]?\d)(?:,)?\s+(20\d{2})/i);
  const monthYear = sentence.match(/(January|February|March|April|May|June|July|August|September|October|November|December)\s+(20\d{2})/i);
  const yearOnly = sentence.match(/(?<!\d)(20\d{2})(?!\d)/);
  if (iso) { year = Number(iso[1]); month = Number(iso[2]) - 1; day = Number(iso[3]); }
  else if (longDay) { month = monthIndex(longDay[1]); day = Number(longDay[2]); year = Number(longDay[3]); }
  else if (monthYear) { month = monthIndex(monthYear[1]); year = Number(monthYear[2]); }
  else if (yearOnly) year = Number(yearOnly[1]);
  else return null;
  const date = new Date(Date.UTC(year, month, day));
  if (date.getUTCFullYear() !== year || date.getUTCMonth() !== month || date.getUTCDate() !== day) return null;
  if (date.getTime() > now.getTime()) return null;
  return date.toISOString();
}

function eventType(sentence: string): CandidateGrowthSignal["signal_type"] | null {
  if (/\b(?:raised|secured|closed)\b.{0,100}\b(?:funding|series\s+[a-f]|investment|capital)\b/i.test(sentence)) return "recent_funding";
  if (/\b(?:hiring|hired|recruited|job opening|open role)\b/i.test(sentence)
    && /\b(?:growth|e-?commerce|digital|marketing|product|cro|retention|acquisition)\b/i.test(sentence)) return "relevant_hiring";
  if (/\b(?:expanded|expansion|launched|entered)\b.{0,100}\b(?:market|country|region|internationally|in\s+[A-Z][a-z]+)/i.test(sentence)) return "market_expansion";
  if (/\b(?:revenue|sales|gmv|gross merchandise|traffic)\b.{0,100}\b(?:grew|growth|increased|up|declined|decreased|down)\b|\b(?:grew|growth|increased|up|declined|decreased|down)\b.{0,100}\b(?:revenue|sales|gmv|gross merchandise|traffic)\b/i.test(sentence)
    && /\d+(?:\.\d+)?\s*%/i.test(sentence)) {
    return /\b(?:declined|decreased|down|contraction)\b/i.test(sentence) ? "verified_contraction" : "verified_growth";
  }
  return null;
}

/** Extracts only explicit, date-bearing growth claims from eligible source evidence. */
export function extractCandidateGrowthSignals(
  row: unknown,
  identity: CompanyResearchIdentity,
  now = new Date(),
): CandidateGrowthSignal[] {
  const parsed = EvidenceInput.safeParse(row);
  if (!parsed.success || !trustedEvidence(parsed.data, identity)) return [];
  const text = evidenceText(parsed.data);
  if (!text) return [];
  const output = new Map<string, CandidateGrowthSignal>();
  for (const sentence of text.split(/(?<=[.!?])\s+|\n+/).map((part) => part.trim()).filter(Boolean)) {
    const signalType = eventType(sentence);
    const eventDate = explicitEventDate(sentence, now);
    if (!signalType || !eventDate) continue;
    const candidate = CandidateGrowthSignalSchema.safeParse({
      company_id: parsed.data.company_id,
      signal_type: signalType,
      observed_at: eventDate,
      confidence: parsed.data.confidence,
      status: "candidate",
      evidence_id: parsed.data.id,
      summary: sentence.slice(0, 600),
      valid_until: null,
    });
    if (candidate.success) output.set(`${signalType}:${eventDate}:${sentence.toLowerCase()}`, candidate.data);
  }
  return [...output.values()];
}
