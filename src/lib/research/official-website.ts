import "server-only";
import { lookup as dnsLookup } from "node:dns/promises";
import { request as httpRequest, Agent as HttpAgent } from "node:http";
import type { IncomingHttpHeaders } from "node:http";
import { isIP, type LookupFunction } from "node:net";
import { request as httpsRequest, Agent as HttpsAgent } from "node:https";
import { createHash } from "node:crypto";

const REQUEST_TIMEOUT_MS = 8_000;
const MAX_RESPONSE_BYTES = 1_000_000;
const MAX_REDIRECTS = 3;
const MAX_TEXT_EXCERPT_CHARS = 2_000;
const MAX_PAGE_FETCHES = 5;
const MAX_AUXILIARY_FETCHES = 2;
const MAX_TOTAL_RESEARCH_MS = 30_000;
const RESEARCH_PATH_PRIORITIES = [
  { path: "/about", priority: 0 },
  { path: "/about-us", priority: 1 },
  { path: "/company", priority: 2 },
  { path: "/contact", priority: 3 },
  { path: "/team", priority: 4 },
  { path: "/careers", priority: 5 },
  { path: "/jobs", priority: 6 },
  { path: "/pricing", priority: 7 },
] as const;

export type OfficialWebsiteErrorCode =
  | "invalid_website_url"
  | "website_target_blocked"
  | "website_dns_failed"
  | "website_timeout"
  | "website_redirect_blocked"
  | "website_http_error"
  | "website_non_html"
  | "website_response_too_large"
  | "website_fetch_failed";

export class OfficialWebsiteResearchError extends Error {
  constructor(readonly code: OfficialWebsiteErrorCode) {
    super(code);
    this.name = "OfficialWebsiteResearchError";
  }
}

export interface OfficialWebsiteCompany {
  id: string;
  website: string | null;
  domain: string | null;
}

export interface ResolvedAddress {
  address: string;
  family: 4 | 6;
}

export interface OfficialWebsiteResponse {
  statusCode: number;
  headers: IncomingHttpHeaders | Record<string, string | string[] | undefined>;
  body: string;
}

export interface OfficialWebsiteEvidence {
  company_id: string;
  research_run_id: string;
  source_type: "official_website";
  source_name: "Official website";
  source_url: string;
  observed_at: string;
  retrieved_at: string;
  excerpt: string;
  content_hash: string;
  confidence: number;
  status: "candidate";
}

export interface OfficialWebsiteDependencies {
  resolveHost(hostname: string): Promise<ResolvedAddress[]>;
  request(url: URL, addresses: ResolvedAddress[], timeoutMs: number, maxBytes: number): Promise<OfficialWebsiteResponse>;
  now(): Date;
  timeoutMs: number;
}

export interface OfficialWebsiteResearch {
  evidence: OfficialWebsiteEvidence[];
  metadata: {
    pageTitle: string | null;
    metaDescription: string | null;
    canonicalUrl: string | null;
    readableTextExcerpt: string;
  };
}

function isInV4Range(address: string, network: string, prefix: number): boolean {
  const toNumber = (value: string) => value.split(".").reduce((result, part) => ((result << 8) | Number(part)) >>> 0, 0);
  const ipNumber = toNumber(address);
  const networkNumber = toNumber(network);
  const mask = prefix === 0 ? 0 : (0xffffffff << (32 - prefix)) >>> 0;
  return (ipNumber & mask) === (networkNumber & mask);
}

function ipv6ToBigInt(address: string): bigint | null {
  let normalized = address.toLowerCase();
  if (normalized.includes(".")) {
    const lastColon = normalized.lastIndexOf(":");
    const ipv4 = normalized.slice(lastColon + 1);
    if (isIP(ipv4) !== 4) return null;
    const parts = ipv4.split(".").map(Number);
    const high = ((parts[0] << 8) | parts[1]).toString(16);
    const low = ((parts[2] << 8) | parts[3]).toString(16);
    normalized = `${normalized.slice(0, lastColon)}:${high}:${low}`;
  }

  const halves = normalized.split("::");
  if (halves.length > 2) return null;
  const left = halves[0] ? halves[0].split(":") : [];
  const right = halves[1] ? halves[1].split(":") : [];
  const missing = 8 - left.length - right.length;
  if ((halves.length === 1 && missing !== 0) || (halves.length === 2 && missing < 1)) return null;
  const groups = [...left, ...Array.from({ length: missing }, () => "0"), ...right];
  if (groups.length !== 8 || groups.some((group) => !/^[0-9a-f]{1,4}$/.test(group))) return null;
    return groups.reduce((value, group) => (value << BigInt(16)) | BigInt(`0x${group}`), BigInt(0));
}

function isInV6Range(address: bigint, network: bigint, prefix: number): boolean {
  const shift = BigInt(128 - prefix);
  return (address >> shift) === (network >> shift);
}

/** Returns true only for ordinary public unicast IP addresses. */
export function isPublicAddress(address: string): boolean {
  const family = isIP(address);
  if (family === 4) {
    const blocked: Array<[string, number]> = [
      ["0.0.0.0", 8], ["10.0.0.0", 8], ["100.64.0.0", 10], ["127.0.0.0", 8],
      ["169.254.0.0", 16], ["172.16.0.0", 12], ["192.0.0.0", 24], ["192.0.2.0", 24],
      ["192.88.99.0", 24], ["192.168.0.0", 16], ["198.18.0.0", 15], ["198.51.100.0", 24],
      ["203.0.113.0", 24], ["224.0.0.0", 4], ["240.0.0.0", 4],
    ];
    return !blocked.some(([network, prefix]) => isInV4Range(address, network, prefix));
  }
  if (family !== 6) return false;

  const value = ipv6ToBigInt(address);
  if (value === null || !isInV6Range(value, BigInt("0x20000000000000000000000000000000"), 3)) return false;
  const blocked: Array<[bigint, number]> = [
    [BigInt("0x20010000000000000000000000000000"), 23], // IETF protocol assignments
    [BigInt("0x20010db8000000000000000000000000"), 32], // Documentation
    [BigInt("0x20020000000000000000000000000000"), 16], // 6to4
  ];
  return !blocked.some(([network, prefix]) => isInV6Range(value, network, prefix));
}

function publicHostName(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/\.$/, "");
  if (isIP(host)) return true;
  if (!host.includes(".") || host.length > 253) return false;
  const reservedSuffixes = [".localhost", ".local", ".internal", ".lan", ".home", ".test", ".invalid", ".example"];
  if (reservedSuffixes.some((suffix) => host === suffix.slice(1) || host.endsWith(suffix))) return false;
  return host.split(".").every((label) => label.length > 0 && label.length <= 63 && /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/.test(label));
}

function parseWebsiteUrl(value: string): URL {
  const input = value.trim();
  if (!input || input.length > 2_048 || input.startsWith("//")) {
    throw new OfficialWebsiteResearchError("invalid_website_url");
  }
  const hasScheme = /^[a-z][a-z0-9+.-]*:/i.test(input);
  let url: URL;
  try {
    url = new URL(hasScheme ? input : `https://${input}`);
  } catch {
    throw new OfficialWebsiteResearchError("invalid_website_url");
  }
  const hostname = url.hostname.replace(/^\[|\]$/g, "");
  if (
    !["http:", "https:"].includes(url.protocol)
    || url.username
    || url.password
    || !publicHostName(hostname)
    || (url.port && url.port !== (url.protocol === "https:" ? "443" : "80"))
  ) {
    throw new OfficialWebsiteResearchError("invalid_website_url");
  }
  if (isIP(hostname) && !isPublicAddress(hostname)) {
    throw new OfficialWebsiteResearchError("website_target_blocked");
  }
  url.hash = "";
  return url;
}

async function resolveHost(hostname: string): Promise<ResolvedAddress[]> {
  const address = hostname.replace(/^\[|\]$/g, "");
  const family = isIP(address);
  if (family === 4 || family === 6) return [{ address, family }];
  const results = await dnsLookup(address, { all: true, verbatim: true });
  return results.map((result) => ({ address: result.address, family: result.family as 4 | 6 }));
}

/** Validates a provider-supplied URL without fetching it, including DNS-based SSRF checks. */
export async function validateSafeResearchUrl(
  value: string,
  resolve: (hostname: string) => Promise<ResolvedAddress[]> = resolveHost,
): Promise<URL> {
  const url = parseWebsiteUrl(value);
  const hostname = url.hostname.replace(/^\[|\]$/g, "");
  let addresses: ResolvedAddress[];
  try {
    addresses = await resolve(hostname);
  } catch {
    throw new OfficialWebsiteResearchError("website_dns_failed");
  }
  if (addresses.length === 0 || addresses.some(({ address }) => !isPublicAddress(address))) {
    throw new OfficialWebsiteResearchError("website_target_blocked");
  }
  return url;
}

function createPinnedLookup(addresses: ResolvedAddress[]): LookupFunction {
  return (_hostname, options, callback) => {
    if (typeof options === "object" && options !== null && options.all) {
      callback(null, addresses);
      return;
    }
    const selected = addresses[0];
    if (!selected) {
      callback(Object.assign(new Error("No validated DNS address."), { code: "ENOTFOUND" }), "", 0);
      return;
    }
    callback(null, selected.address, selected.family);
  };
}

function requestPinned(
  url: URL,
  addresses: ResolvedAddress[],
  timeoutMs: number,
  maxBytes: number,
): Promise<OfficialWebsiteResponse> {
  return new Promise((resolve, reject) => {
    const lookup = createPinnedLookup(addresses);
    const agent = url.protocol === "https:"
      ? new HttpsAgent({ keepAlive: false, lookup })
      : new HttpAgent({ keepAlive: false, lookup });
    const send = url.protocol === "https:" ? httpsRequest : httpRequest;
    const request = send(url, {
      method: "GET",
      agent,
      headers: {
        accept: "text/html,application/xhtml+xml;q=0.9",
        "accept-encoding": "identity",
        "user-agent": "GrowthOS-ResearchBot/1.0 (+official website metadata retrieval)",
      },
    }, (response) => {
      const lengthHeader = response.headers["content-length"];
      const length = typeof lengthHeader === "string" ? Number(lengthHeader) : NaN;
      if (Number.isFinite(length) && length > maxBytes) {
        response.destroy();
        request.destroy(new Error("response_too_large"));
        return;
      }
      const chunks: Buffer[] = [];
      let totalBytes = 0;
      response.on("data", (chunk: Buffer | string) => {
        const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        totalBytes += buffer.byteLength;
        if (totalBytes > maxBytes) {
          response.destroy();
          request.destroy(new Error("response_too_large"));
          return;
        }
        chunks.push(buffer);
      });
      response.on("end", () => resolve({
        statusCode: response.statusCode ?? 0,
        headers: response.headers,
        body: Buffer.concat(chunks).toString("utf8"),
      }));
      response.on("error", reject);
    });

    const timer = setTimeout(() => request.destroy(Object.assign(new Error("timeout"), { code: "ETIMEDOUT" })), timeoutMs);
    request.on("close", () => {
      clearTimeout(timer);
      agent.destroy();
    });
    request.on("error", (error: NodeJS.ErrnoException) => {
      clearTimeout(timer);
      agent.destroy();
      if (error.message === "response_too_large") reject(new OfficialWebsiteResearchError("website_response_too_large"));
      else if (error.code === "ETIMEDOUT") reject(new OfficialWebsiteResearchError("website_timeout"));
      else reject(error);
    });
    request.end();
  });
}

const defaultDependencies: OfficialWebsiteDependencies = {
  resolveHost,
  request: requestPinned,
  now: () => new Date(),
  timeoutMs: REQUEST_TIMEOUT_MS,
};

function raceTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new OfficialWebsiteResearchError("website_timeout")), timeoutMs);
    promise.then(
      (value) => { clearTimeout(timer); resolve(value); },
      (error: unknown) => { clearTimeout(timer); reject(error); },
    );
  });
}

function getHeader(headers: OfficialWebsiteResponse["headers"], name: string): string | null {
  const value = headers[name] ?? headers[name.toLowerCase()];
  return Array.isArray(value) ? value[0] ?? null : value ?? null;
}

function decodeHtmlEntities(value: string): string {
  const named: Record<string, string> = {
    amp: "&", apos: "'", gt: ">", lt: "<", nbsp: " ", quot: '"', copy: "©", reg: "®",
    ndash: "–", mdash: "—", lsquo: "‘", rsquo: "’", ldquo: "“", rdquo: "”", hellip: "…",
  };
  return value.replace(/&(#(?:x[\da-f]+|\d+)|[a-z]+);/gi, (entity, token: string) => {
    if (token[0] === "#") {
      const hex = token[1]?.toLowerCase() === "x";
      const number = Number.parseInt(token.slice(hex ? 2 : 1), hex ? 16 : 10);
      try { return Number.isFinite(number) ? String.fromCodePoint(number) : entity; } catch { return entity; }
    }
    return named[token.toLowerCase()] ?? entity;
  });
}

function textFromHtml(value: string): string {
  return decodeHtmlEntities(value
    .replace(/<!--([\s\S]*?)-->/g, " ")
    .replace(/<(head|title)\b[^>]*>[\s\S]*?<\/\1\s*>/gi, " ")
    .replace(/<(script|style|noscript|svg|template|nav|header|footer|aside)\b[^>]*>[\s\S]*?<\/\1\s*>/gi, " ")
    .replace(/<(br|hr)\b[^>]*>/gi, " ")
    .replace(/<\/(p|div|li|h[1-6]|section|article|main|blockquote|tr)\s*>/gi, " ")
    .replace(/<[^>]*>/g, " ")
    .replace(/\s+/g, " ")
    .trim()).slice(0, MAX_TEXT_EXCERPT_CHARS);
}

function readAttributes(tag: string): Record<string, string> {
  const attributes: Record<string, string> = {};
  const body = tag.replace(/^<[a-z][^\s/>]*/i, "").replace(/\/?\s*>$/, "");
  const attributePattern = /([^\s=/>]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/g;
  for (const match of body.matchAll(attributePattern)) {
    attributes[match[1].toLowerCase()] = decodeHtmlEntities(match[2] ?? match[3] ?? match[4] ?? "");
  }
  return attributes;
}

function extractPageMetadata(html: string, finalUrl: URL) {
  const titleMatch = html.match(/<title\b[^>]*>([\s\S]*?)<\/title\s*>/i);
  const pageTitle = titleMatch ? textFromHtml(titleMatch[1]).slice(0, 300) || null : null;
  let metaDescription: string | null = null;
  for (const tag of html.matchAll(/<meta\b[^>]*>/gi)) {
    const attributes = readAttributes(tag[0]);
    if (attributes.name?.toLowerCase() === "description" && attributes.content) {
      metaDescription = textFromHtml(attributes.content).slice(0, 600) || null;
      break;
    }
  }

  let canonicalUrl: string | null = null;
  for (const tag of html.matchAll(/<link\b[^>]*>/gi)) {
    const attributes = readAttributes(tag[0]);
    if (attributes.rel?.toLowerCase().split(/\s+/).includes("canonical") && attributes.href) {
      try {
        const canonical = new URL(attributes.href, finalUrl);
        if (canonical.origin === finalUrl.origin && !canonical.username && !canonical.password) {
          canonical.hash = "";
          canonicalUrl = canonical.toString().slice(0, 2_048);
        }
      } catch { /* Ignore an invalid canonical link; it is untrusted page metadata. */ }
      break;
    }
  }

  const readableTextExcerpt = textFromHtml(html);
  return { pageTitle, metaDescription, canonicalUrl, readableTextExcerpt };
}

function getStartingWebsite(company: OfficialWebsiteCompany): string {
  const value = company.website?.trim() || company.domain?.trim();
  if (!value) throw new OfficialWebsiteResearchError("invalid_website_url");
  return value;
}

interface FetchedResource {
  body: string;
  finalUrl: URL;
}

interface RequestBudget {
  pageFetches: number;
  auxiliaryFetches: number;
}

function safeSameOriginUrl(value: string, base: URL, origin: string): URL | null {
  try {
    const url = new URL(value, base);
    if (url.origin !== origin || !["http:", "https:"].includes(url.protocol)) return null;
    const validated = parseWebsiteUrl(url.toString());
    if (validated.origin !== origin) return null;
    return validated;
  } catch {
    return null;
  }
}

function normalizedUrlKey(url: URL): string {
  const normalized = new URL(url);
  normalized.hash = "";
  normalized.search = "";
  normalized.pathname = normalized.pathname.replace(/\/{2,}/g, "/").replace(/\/$/, "") || "/";
  return normalized.toString();
}

function pathPriority(url: URL): number | null {
  const path = url.pathname.toLowerCase().replace(/\/{2,}/g, "/").replace(/\/$/, "") || "/";
  if (/\/(cart|checkout|account|search|products?|collections?)(\/|$)/.test(path)) return null;
  const prioritized = RESEARCH_PATH_PRIORITIES.find(({ path: target }) =>
    path === target || path.startsWith(`${target}/`) || path.includes(`${target}/`),
  );
  if (prioritized) return prioritized.priority;
  if (/\/(our-story|story|mission|values|sustainability|faq|frequently-asked-questions)(\/|$)/.test(`${path}/`)) return 8;
  return null;
}

function discoverHomepageLinks(html: string, base: URL, origin: string): URL[] {
  const urls = new Map<string, URL>();
  for (const tag of html.matchAll(/<a\b[^>]*>/gi)) {
    const href = readAttributes(tag[0]).href;
    if (!href) continue;
    const url = safeSameOriginUrl(href, base, origin);
    if (!url || pathPriority(url) === null) continue;
    urls.set(normalizedUrlKey(url), url);
  }
  return [...urls.values()];
}

function discoverSitemapLinks(html: string, base: URL, origin: string): URL[] {
  const urls = new Map<string, URL>();
  for (const tag of html.matchAll(/<(?:link|a)\b[^>]*>/gi)) {
    const attrs = readAttributes(tag[0]);
    const href = attrs.href;
    if (!href) continue;
    const isSitemap = attrs.rel?.toLowerCase().split(/\s+/).includes("sitemap")
      || /sitemap(?:[-\w]*)?\.xml(?:$|[?#])/i.test(href);
    if (!isSitemap) continue;
    const url = safeSameOriginUrl(href, base, origin);
    if (url) urls.set(normalizedUrlKey(url), url);
  }
  return [...urls.values()];
}

function sitemapUrlsFromRobots(robots: string, base: URL, origin: string): URL[] {
  const urls = new Map<string, URL>();
  for (const match of robots.matchAll(/^\s*sitemap\s*:\s*(\S+)\s*$/gim)) {
    const url = safeSameOriginUrl(match[1], base, origin);
    if (url) urls.set(normalizedUrlKey(url), url);
  }
  return [...urls.values()];
}

function parseSitemapLocations(xml: string, base: URL, origin: string): URL[] {
  const urls = new Map<string, URL>();
  for (const match of xml.matchAll(/<loc\b[^>]*>([\s\S]*?)<\/loc\s*>/gi)) {
    const location = decodeHtmlEntities(match[1].trim());
    const url = safeSameOriginUrl(location, base, origin);
    if (url && pathPriority(url) !== null) urls.set(normalizedUrlKey(url), url);
  }
  return [...urls.values()];
}

function pageUsefulness(metadata: ReturnType<typeof extractPageMetadata>): number {
  const content = `${metadata.pageTitle ?? ""} ${metadata.metaDescription ?? ""} ${metadata.readableTextExcerpt}`;
  const normalized = content.toLowerCase();
  if (/hang tight|routing to checkout|automatically refresh|access denied|verify you are human|checking your browser|site maintenance/.test(normalized)) return 0;
  const meaningfulCharacters = content.replace(/[^\p{L}\p{N}]/gu, "").length;
  if (meaningfulCharacters < 100) return 0;
  return Math.min(meaningfulCharacters, 2_000);
}

async function fetchSafeResource(
  initialUrl: URL,
  origin: string,
  dependencies: OfficialWebsiteDependencies,
  deadline: number,
  allowedContentTypes: readonly string[],
): Promise<FetchedResource> {
  let currentUrl = initialUrl;
  for (let redirectCount = 0; redirectCount <= MAX_REDIRECTS; redirectCount += 1) {
    const remainingMs = deadline - Date.now();
    if (remainingMs <= 0) throw new OfficialWebsiteResearchError("website_timeout");
    if (currentUrl.origin !== origin) throw new OfficialWebsiteResearchError("website_redirect_blocked");

    const hostname = currentUrl.hostname.replace(/^\[|\]$/g, "");
    if (!publicHostName(hostname)) throw new OfficialWebsiteResearchError("website_target_blocked");

    let addresses: ResolvedAddress[];
    try {
      addresses = await raceTimeout(dependencies.resolveHost(hostname), remainingMs);
    } catch (error) {
      if (error instanceof OfficialWebsiteResearchError) throw error;
      throw new OfficialWebsiteResearchError("website_dns_failed");
    }
    if (addresses.length === 0 || addresses.some(({ address }) => !isPublicAddress(address))) {
      throw new OfficialWebsiteResearchError("website_target_blocked");
    }

    const timeLeft = deadline - Date.now();
    if (timeLeft <= 0) throw new OfficialWebsiteResearchError("website_timeout");
    let response: OfficialWebsiteResponse;
    try {
      response = await raceTimeout(
        dependencies.request(currentUrl, addresses, Math.min(dependencies.timeoutMs, timeLeft), MAX_RESPONSE_BYTES),
        Math.min(dependencies.timeoutMs, timeLeft),
      );
    } catch (error) {
      if (error instanceof OfficialWebsiteResearchError) throw error;
      throw new OfficialWebsiteResearchError("website_fetch_failed");
    }
    if (response.body.length > MAX_RESPONSE_BYTES) throw new OfficialWebsiteResearchError("website_response_too_large");

    if ([301, 302, 303, 307, 308].includes(response.statusCode)) {
      const location = getHeader(response.headers, "location");
      if (!location || redirectCount === MAX_REDIRECTS) throw new OfficialWebsiteResearchError("website_redirect_blocked");
      const nextUrl = safeSameOriginUrl(location, currentUrl, origin);
      if (!nextUrl || (currentUrl.protocol === "https:" && nextUrl.protocol !== "https:")) {
        throw new OfficialWebsiteResearchError("website_redirect_blocked");
      }
      currentUrl = nextUrl;
      continue;
    }
    if (response.statusCode < 200 || response.statusCode >= 300) throw new OfficialWebsiteResearchError("website_http_error");

    const contentType = getHeader(response.headers, "content-type")?.split(";")[0]?.trim().toLowerCase();
    if (!contentType || !allowedContentTypes.includes(contentType)) throw new OfficialWebsiteResearchError("website_non_html");
    const contentEncoding = getHeader(response.headers, "content-encoding")?.trim().toLowerCase();
    if (contentEncoding && contentEncoding !== "identity") throw new OfficialWebsiteResearchError("website_non_html");
    return { body: response.body, finalUrl: currentUrl };
  }
  throw new OfficialWebsiteResearchError("website_redirect_blocked");
}

function createEvidence(companyId: string, researchRunId: string, pageUrl: URL, metadata: ReturnType<typeof extractPageMetadata>, observedAt: string): OfficialWebsiteEvidence {
  const excerpt = JSON.stringify(metadata);
  return {
    company_id: companyId,
    research_run_id: researchRunId,
    source_type: "official_website",
    source_name: "Official website",
    source_url: pageUrl.toString(),
    observed_at: observedAt,
    retrieved_at: observedAt,
    excerpt,
    content_hash: createHash("sha256").update(`${researchRunId}\n${pageUrl.toString()}\n${excerpt}`).digest("hex"),
    confidence: 0.7,
    status: "candidate",
  };
}

export async function collectOfficialWebsiteEvidence(
  company: OfficialWebsiteCompany,
  researchRunId: string,
  dependencies: OfficialWebsiteDependencies = defaultDependencies,
): Promise<OfficialWebsiteResearch> {
  const startingUrl = parseWebsiteUrl(getStartingWebsite(company));
  const origin = startingUrl.origin;
  const maxDuration = Math.min(MAX_TOTAL_RESEARCH_MS, dependencies.timeoutMs * (MAX_PAGE_FETCHES + MAX_AUXILIARY_FETCHES));
  const deadline = Date.now() + maxDuration;
  const budget: RequestBudget = { pageFetches: 0, auxiliaryFetches: 0 };
  const homepage = await fetchSafeResource(
    startingUrl,
    origin,
    dependencies,
    deadline,
    ["text/html", "application/xhtml+xml"],
  );
  budget.pageFetches += 1;
  const homepageMetadata = extractPageMetadata(homepage.body, homepage.finalUrl);
  const homepageLinks = discoverHomepageLinks(homepage.body, homepage.finalUrl, origin);
  const sitemapCandidates = discoverSitemapLinks(homepage.body, homepage.finalUrl, origin);
  const homepageUsefulness = pageUsefulness(homepageMetadata);

  const candidates = new Map<string, URL>();
  const sitemapLinks = new Map<string, URL>();
  if (homepageUsefulness === 0) {
    for (const url of homepageLinks) candidates.set(normalizedUrlKey(url), url);

    // Robots is a common sitemap index. If it doesn't expose one, try the conventional path.
    if (sitemapCandidates.length === 0 && budget.auxiliaryFetches < MAX_AUXILIARY_FETCHES) {
      budget.auxiliaryFetches += 1;
      const robotsUrl = new URL("/robots.txt", homepage.finalUrl);
      try {
        const robots = await fetchSafeResource(robotsUrl, origin, dependencies, deadline, ["text/plain"]);
        sitemapCandidates.push(...sitemapUrlsFromRobots(robots.body, robots.finalUrl, origin));
      } catch { /* A missing or blocked robots file must not discard homepage discovery. */ }
      if (sitemapCandidates.length === 0) {
        const defaultSitemap = safeSameOriginUrl("/sitemap.xml", homepage.finalUrl, origin);
        if (defaultSitemap) sitemapCandidates.push(defaultSitemap);
      }
    }

    for (const sitemapUrl of sitemapCandidates) {
      if (budget.auxiliaryFetches >= MAX_AUXILIARY_FETCHES) break;
      budget.auxiliaryFetches += 1;
      try {
        const sitemap = await fetchSafeResource(sitemapUrl, origin, dependencies, deadline, ["application/xml", "text/xml"]);
        for (const url of parseSitemapLocations(sitemap.body, sitemap.finalUrl, origin)) {
          sitemapLinks.set(normalizedUrlKey(url), url);
        }
      } catch { /* Sitemap failure is non-fatal; discovered HTML links remain eligible. */ }
    }
    for (const url of sitemapLinks.values()) {
      candidates.set(normalizedUrlKey(url), url);
    }
    const discoveredKeys = new Set(candidates.keys());
    for (const { path } of RESEARCH_PATH_PRIORITIES) {
      const fallback = safeSameOriginUrl(path, homepage.finalUrl, origin);
      if (fallback) candidates.set(normalizedUrlKey(fallback), fallback);
    }
    candidates.delete(normalizedUrlKey(homepage.finalUrl));

    const orderedCandidates = [...candidates.values()].sort((a, b) => {
      const aDiscovered = discoveredKeys.has(normalizedUrlKey(a)) ? 0 : 1;
      const bDiscovered = discoveredKeys.has(normalizedUrlKey(b)) ? 0 : 1;
      return aDiscovered - bDiscovered
        || (pathPriority(a) ?? Number.MAX_SAFE_INTEGER) - (pathPriority(b) ?? Number.MAX_SAFE_INTEGER)
        || a.pathname.localeCompare(b.pathname);
    });

    const pages: Array<{ url: URL; metadata: ReturnType<typeof extractPageMetadata>; usefulness: number }> = [];
    for (const url of orderedCandidates) {
      if (budget.pageFetches >= MAX_PAGE_FETCHES || Date.now() >= deadline) break;
      budget.pageFetches += 1;
      try {
        const fetched = await fetchSafeResource(url, origin, dependencies, deadline, ["text/html", "application/xhtml+xml"]);
        const metadata = extractPageMetadata(fetched.body, fetched.finalUrl);
        const usefulness = pageUsefulness(metadata);
        if (usefulness > 0) pages.push({ url: fetched.finalUrl, metadata, usefulness });
      } catch { /* Unavailable internal pages are skipped; other pages can still provide evidence. */ }
    }

    const evidence = pages
      .sort((a, b) => b.usefulness - a.usefulness || a.url.toString().localeCompare(b.url.toString()))
      .map(({ url, metadata }) => createEvidence(company.id, researchRunId, url, metadata, dependencies.now().toISOString()));
    return { metadata: homepageMetadata, evidence };
  }

  return {
    metadata: homepageMetadata,
    evidence: [createEvidence(company.id, researchRunId, homepage.finalUrl, homepageMetadata, dependencies.now().toISOString())],
  };
}
