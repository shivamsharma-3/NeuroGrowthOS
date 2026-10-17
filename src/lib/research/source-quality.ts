import "server-only";

export interface CompanyResearchIdentity {
  name: string;
  domain: string | null;
  website?: string | null;
  linkedin_url?: string | null;
}

export function parseTrustedResearchDomains(value: string | undefined): string[] {
  return [...new Set((value ?? "").split(",").map((item) => item.trim().toLowerCase().replace(/^\.+|\.+$/g, ""))
    .filter((item) => item.length > 0 && /^[a-z0-9.-]+$/.test(item) && !item.includes("..")))];
}

export function getConfiguredTrustedResearchDomains(): string[] {
  return parseTrustedResearchDomains(process.env.GROWTHOS_TRUSTED_RESEARCH_DOMAINS);
}

export function isTrustedResearchHost(host: string, trustedDomains: string[]): boolean {
  const normalizedHost = host.toLowerCase().replace(/^www\./, "").replace(/\.$/, "");
  return trustedDomains.some((domain) => {
    const normalizedDomain = domain.toLowerCase().replace(/^www\./, "").replace(/\.$/, "");
    return normalizedHost === normalizedDomain || normalizedHost.endsWith(`.${normalizedDomain}`);
  });
}

/** Keeps source attribution useful without persisting URL credentials or query/fragment data. */
export function safeResearchSourceLocation(value: string): { sourceUrl: string | null; sourceDomain: string | null } {
  try {
    const url = new URL(value);
    if (!(url.protocol === "http:" || url.protocol === "https:") || url.username || url.password) {
      return { sourceUrl: null, sourceDomain: null };
    }
    url.hash = "";
    url.search = "";
    const sourceDomain = url.hostname.toLowerCase().replace(/\.$/, "").slice(0, 253) || null;
    let pathname = url.pathname;
    try { pathname = decodeURIComponent(pathname); } catch { /* retain encoded pathname for safety check */ }
    if (/(?:^|\/)(?:bearer|authorization|api[_-]?key|secret|token)(?:\/|=|:|$)/i.test(pathname)
      || /\/sk-[a-z0-9]{8,}/i.test(pathname)) {
      return { sourceUrl: null, sourceDomain };
    }
    const sourceUrl = `${url.protocol}//${url.host}${url.pathname}`.slice(0, 2_048);
    return { sourceUrl, sourceDomain };
  } catch { return { sourceUrl: null, sourceDomain: null }; }
}

function normalizedWords(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}

function normalizedHost(value: string | null | undefined): string | null {
  if (!value) return null;
  try {
    const url = new URL(value.includes("://") ? value : `https://${value}`);
    return url.hostname.toLowerCase().replace(/^www\./, "").replace(/\.$/, "");
  } catch { return null; }
}

function normalizedPageUrl(value: string | null | undefined): string | null {
  if (!value) return null;
  try {
    const url = new URL(value);
    if (!(url.protocol === "https:" || url.protocol === "http:") || url.username || url.password) return null;
    url.hash = "";
    url.search = "";
    url.hostname = url.hostname.toLowerCase().replace(/^www\./, "").replace(/\.$/, "");
    url.pathname = url.pathname.replace(/\/{2,}/g, "/").replace(/\/$/, "") || "/";
    return url.toString();
  } catch { return null; }
}

function hasExactPhrase(text: string, phrase: string): boolean {
  const normalizedText = ` ${normalizedWords(text)} `;
  const normalizedPhrase = normalizedWords(phrase);
  return normalizedPhrase.length >= 3 && normalizedText.includes(` ${normalizedPhrase} `);
}

function hasCanonicalDomainMention(text: string, identity: CompanyResearchIdentity): boolean {
  const domain = normalizedHost(identity.domain ?? identity.website);
  if (!domain) return false;
  // Match whole hostnames before comparing them. Turning dots into spaces lets
  // bombas.com.evil.example masquerade as a mention of bombas.com.
  const hostnames = text.match(/\b[a-z0-9-]+(?:\.[a-z0-9-]+)+\b/gi) ?? [];
  return hostnames.some((candidate) => {
    const host = candidate.toLowerCase().replace(/\.$/, "");
    return host === domain || host.endsWith(`.${domain}`);
  });
}

function hasCompositeSingleTokenName(text: string, identityName: string): boolean {
  if (normalizedWords(identityName).split(" ").filter(Boolean).length !== 1) return false;
  const name = identityName.trim().replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const legalSuffixes = new Set([
    "llc", "inc", "incorporated", "corp", "corporation", "company", "co", "ltd", "limited", "plc", "gmbh",
    "news", "jobs", "careers", "profile", "official", "linkedin", "updates", "blog", "shopify", "certified",
    "series", "funding", "revenue", "sales", "hiring", "expansion", "market", "growth", "raised", "expanded",
    "industry", "headquarters", "employees", "description",
  ]);
  const pattern = new RegExp(`\\b${name}\\s+([A-Z][A-Za-z&'-]*)\\b`, "g");
  return [...text.matchAll(pattern)].some((match) => !legalSuffixes.has((match[1] ?? "").toLowerCase()));
}

/**
 * Matches evidence to a company using canonical source identity where possible.
 * For single-token company names, the name alone is ambiguous: require an exact
 * canonical domain/profile URL or an exact company-name URL path plus the name
 * in the source text. This prevents a shared brand token from matching namesakes.
 */
export function evidenceMatchesCompanyIdentity(
  text: string,
  identity: CompanyResearchIdentity,
  sourceUrl?: string | null,
): boolean {
  if (hasCompositeSingleTokenName(text, identity.name)) return false;
  const exactNameMatch = hasExactPhrase(text, identity.name);
  const domainMention = hasCanonicalDomainMention(text, identity);
  const companyHost = normalizedHost(identity.domain ?? identity.website);
  const sourcePage = normalizedPageUrl(sourceUrl);
  const sourceHost = normalizedHost(sourceUrl);
  if (companyHost && sourceHost
    && (sourceHost === companyHost || sourceHost.endsWith(`.${companyHost}`))
    && (exactNameMatch || domainMention)) return true;

  const officialProfile = normalizedPageUrl(identity.linkedin_url);
  if (sourcePage && officialProfile && sourcePage === officialProfile && (exactNameMatch || domainMention)) return true;

  if (!exactNameMatch) return false;

  const nameTokenCount = normalizedWords(identity.name).split(" ").filter(Boolean).length;
  if (nameTokenCount > 1) return true;

  if (domainMention) return true;
  if (!sourceUrl) return false;
  try {
    const source = new URL(sourceUrl);
    const normalizedName = normalizedWords(identity.name);
    const exactNameSlug = source.pathname.split("/").filter(Boolean).some((segment) => normalizedWords(segment) === normalizedName);
    return exactNameSlug;
  } catch { return false; }
}
