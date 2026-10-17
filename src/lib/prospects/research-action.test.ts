import { describe, expect, it, vi } from "vitest";
import { requestProspectResearch, ProspectResearchActionError } from "./research-action";

const prospectId = "d76481b4-715e-44f8-9cd7-bdc432aa1613";
const runId = "a12ef940-92c0-42a5-a1a2-96c33c391900";

describe("requestProspectResearch", () => {
  it("posts to the existing prospect research endpoint and returns its run status", async () => {
    const fetchImpl = vi.fn(async () => Response.json({ researchRunId: runId, status: "completed" }));

    await expect(requestProspectResearch(prospectId, fetchImpl)).resolves.toEqual({ researchRunId: runId, status: "completed" });
    expect(fetchImpl).toHaveBeenCalledWith(`/api/prospects/${prospectId}/research`, { method: "POST" });
  });

  it("returns a failed run result safely when the endpoint reports worker failure", async () => {
    const fetchImpl = vi.fn(async () => Response.json({ researchRunId: runId, status: "failed" }, { status: 500 }));
    await expect(requestProspectResearch(prospectId, fetchImpl)).resolves.toEqual({ researchRunId: runId, status: "failed" });
  });

  it.each([
    [401, "Your session expired. Sign in again to run research."],
    [403, "Your account is not authorized to run company research."],
    [404, "This prospect or its company could not be found."],
    [503, "Research could not be completed. Try again."],
  ])("maps HTTP %s to a safe user message", async (status, message) => {
    const fetchImpl = vi.fn(async () => Response.json({ error: "sensitive server detail" }, { status }));
    await expect(requestProspectResearch(prospectId, fetchImpl)).rejects.toMatchObject({
      name: "ProspectResearchActionError",
      status,
      message,
    } satisfies Partial<ProspectResearchActionError>);
  });

  it("uses a safe network error and rejects malformed success responses", async () => {
    await expect(requestProspectResearch(prospectId, vi.fn(async () => { throw new Error("private detail"); })))
      .rejects.toMatchObject({ message: "Could not reach the research service. Try again." });
    await expect(requestProspectResearch(prospectId, vi.fn(async () => Response.json({ unexpected: true }))))
      .rejects.toMatchObject({ message: "Research could not be completed. Try again." });
  });
});
