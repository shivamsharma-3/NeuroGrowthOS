import { z } from "zod";
import type { ProspectInput } from "@/types/prospects";

const optionalText = z.string().trim().max(500).nullable();
const optionalUrl = z.union([z.string().trim().url().max(500), z.literal("")]).nullable();
const optionalWebsite = optionalText.refine((value) => {
  if (!value) return true;
  try {
    const parsed = new URL(value.includes("://") ? value : `https://${value}`);
    return (parsed.protocol === "https:" || parsed.protocol === "http:") && parsed.hostname.includes(".");
  } catch {
    return false;
  }
}, "Enter a valid website.");

export const prospectInputSchema = z.object({
  company: z.object({
    name: z.string().trim().min(1, "Company name is required.").max(200),
    website: optionalWebsite,
    domain: z.string().trim().max(255).nullable(),
    industry: optionalText,
    country: optionalText,
    estimated_revenue: z.number().finite().nonnegative().nullable(),
    revenue_amount: z.number().finite().nonnegative().nullable().default(null),
    revenue_currency: z.string().trim().regex(/^[A-Za-z]{3}$/).nullable().default(null),
    revenue_period: z.enum(["annual", "quarterly", "monthly", "lifetime", "unknown"]).nullable().default(null),
    revenue_source: optionalText.default(null),
    revenue_observed_at: z.string().datetime().nullable().default(null),
    employee_count: z.number().int().nonnegative().nullable(),
    platform: optionalText,
    linkedin_url: optionalUrl,
  }).superRefine((company, ctx) => {
    if (company.revenue_amount !== null && (!company.revenue_currency || !company.revenue_period)) {
      ctx.addIssue({ code: "custom", path: ["revenue_currency"], message: "Amount, currency, and reporting period are all required for scored revenue." });
    }
  }),
  contact: z.object({
    first_name: optionalText,
    last_name: optionalText,
    email: z.union([z.string().trim().email().max(320), z.literal("")]).nullable(),
    job_title: optionalText,
    linkedin_url: optionalUrl,
  }).nullable(),
  status: z.enum(["new", "researching", "qualified", "contacted", "in_progress", "converted", "disqualified"]).optional(),
  source: z.string().trim().min(1).max(100).optional(),
}) satisfies z.ZodType<ProspectInput>;

export function normalizeDomain(website: string | null, suppliedDomain?: string | null) {
  const candidate = suppliedDomain?.trim() || website?.trim();
  if (!candidate) return null;

  try {
    const parsed = new URL(candidate.includes("://") ? candidate : `https://${candidate}`);
    return parsed.hostname.toLowerCase().replace(/^www\./, "");
  } catch {
    return null;
  }
}

export function normalizeProspectInput(input: ProspectInput): ProspectInput {
  const websiteValue = input.company.website?.trim() || null;
  const website = websiteValue && !websiteValue.includes("://") ? `https://${websiteValue}` : websiteValue;
  const contact = input.contact;
  const hasContact = contact && Object.values(contact).some((value: string | null) => Boolean(value?.trim()));
  return {
    ...input,
    company: {
      ...input.company,
      website,
      revenue_currency: input.company.revenue_currency?.toUpperCase() ?? null,
      domain: normalizeDomain(website, input.company.domain),
      industry: input.company.industry?.trim() || null,
      country: input.company.country?.trim() || null,
      platform: input.company.platform?.trim() || null,
      linkedin_url: input.company.linkedin_url?.trim() || null,
    },
    contact: hasContact
      ? {
          ...contact,
          first_name: contact.first_name?.trim() || null,
          last_name: contact.last_name?.trim() || null,
          email: contact.email?.trim().toLowerCase() || null,
          job_title: contact.job_title?.trim() || null,
          linkedin_url: contact.linkedin_url?.trim() || null,
        }
      : null,
  };
}
