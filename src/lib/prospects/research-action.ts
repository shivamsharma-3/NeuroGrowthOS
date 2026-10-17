export type ProspectResearchStatus = "queued" | "running" | "completed" | "failed";

export interface ProspectResearchResult {
  researchRunId: string;
  status: ProspectResearchStatus;
}

export class ProspectResearchActionError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
    this.name = "ProspectResearchActionError";
  }
}

function parseResult(value: unknown): ProspectResearchResult | null {
  if (!value || typeof value !== "object") return null;
  const candidate = value as Record<string, unknown>;
  if (typeof candidate.researchRunId !== "string"
    || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(candidate.researchRunId)
    || !["queued", "running", "completed", "failed"].includes(String(candidate.status))) return null;
  return { researchRunId: candidate.researchRunId, status: candidate.status as ProspectResearchStatus };
}

/** Calls the existing authenticated research endpoint and keeps server errors out of the UI. */
export async function requestProspectResearch(
  prospectId: string,
  fetchImpl: typeof fetch = fetch,
): Promise<ProspectResearchResult> {
  let response: Response;
  try {
    response = await fetchImpl(`/api/prospects/${encodeURIComponent(prospectId)}/research`, { method: "POST" });
  } catch {
    throw new ProspectResearchActionError(0, "Could not reach the research service. Try again.");
  }

  let payload: unknown = null;
  try { payload = await response.json(); } catch { /* invalid/empty response gets the safe generic message below */ }

  const result = parseResult(payload);
  if (result) return result;
  if (response.status === 401) throw new ProspectResearchActionError(401, "Your session expired. Sign in again to run research.");
  if (response.status === 403) throw new ProspectResearchActionError(403, "Your account is not authorized to run company research.");
  if (response.status === 404) throw new ProspectResearchActionError(404, "This prospect or its company could not be found.");
  throw new ProspectResearchActionError(response.status, "Research could not be completed. Try again.");
}
