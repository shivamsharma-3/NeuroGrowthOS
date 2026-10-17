import { beforeEach, describe, expect, it, vi } from "vitest";

const { mockRequireInternalUser, mockSameOrigin, mockCreateSupabaseAdminClient, mockProcessResearchRun } = vi.hoisted(() => ({
  mockRequireInternalUser: vi.fn(),
  mockSameOrigin: vi.fn(() => true),
  mockCreateSupabaseAdminClient: vi.fn(),
  mockProcessResearchRun: vi.fn(),
}));

vi.mock("@/lib/auth/internal-authorization", () => ({
  requireInternalUser: mockRequireInternalUser,
  isSameOriginRequest: mockSameOrigin,
}));
vi.mock("@/lib/supabase/admin", () => ({
  createSupabaseAdminClient: mockCreateSupabaseAdminClient,
}));
vi.mock("@/lib/research/worker", () => ({ processResearchRun: mockProcessResearchRun }));

import { POST } from "./route";

const prospectId = "99a276e3-a216-4ae2-ab96-d98f57ee4c1b";
const companyId = "af2b7bb2-21cc-46f2-97c3-b83bfdc990a2";
const userId = "d613b3bc-b747-48c8-b881-47552253483d";

function makeBuilder(result: unknown) {
  const builder = {
    select: vi.fn(),
    eq: vi.fn(),
    maybeSingle: vi.fn(),
    insert: vi.fn(),
    single: vi.fn(),
  };
  builder.select.mockReturnValue(builder);
  builder.eq.mockReturnValue(builder);
  builder.insert.mockReturnValue(builder);
  builder.maybeSingle.mockResolvedValue(result);
  builder.single.mockResolvedValue(result);
  return builder;
}

interface QueryResult<T> {
  data: T | null;
  error: unknown | null;
}

function setupAdmin(options: {
  prospect?: QueryResult<{ id: string; company_id: string }>;
  company?: QueryResult<{ id: string }>;
  run?: QueryResult<{ id: string; status: string }>;
  finalRun?: QueryResult<{ id: string; company_id: string; status: string }>;
} = {}) {
  const prospect = options.prospect ?? { data: { id: prospectId, company_id: companyId }, error: null };
  const company = options.company ?? { data: { id: companyId }, error: null };
  const run = options.run ?? { data: { id: "a12ef940-92c0-42a5-a1a2-96c33c391900", status: "queued" }, error: null };
  const finalRun = options.finalRun ?? {
    data: { id: "a12ef940-92c0-42a5-a1a2-96c33c391900", company_id: companyId, status: "failed" },
    error: null,
  };
  const prospects = makeBuilder(prospect);
  const companies = makeBuilder(company);
  const runs = makeBuilder(run);
  const finalRuns = makeBuilder(finalRun);
  let researchRunLookups = 0;
  const supabase = {
    from: vi.fn((table: string) => {
      if (table === "prospects") return prospects;
      if (table === "companies") return companies;
      if (table === "company_research_runs") {
        researchRunLookups += 1;
        return researchRunLookups === 1 ? runs : finalRuns;
      }
      throw new Error(`Unexpected table ${table}`);
    }),
  };
  mockCreateSupabaseAdminClient.mockReturnValue(supabase);
  return { supabase, prospects, companies, runs, finalRuns };
}

function request(id: string) {
  return new Request(`http://localhost/api/prospects/${id}/research`, {
    method: "POST",
    headers: { origin: "http://localhost" },
  });
}

function context(id: string) {
  return { params: Promise.resolve({ id }) };
}

describe("POST /api/prospects/[id]/research", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockSameOrigin.mockReturnValue(true);
  });

  it("rejects a cross-origin mutation before using the admin client", async () => {
    mockRequireInternalUser.mockResolvedValue({ authorized: true, user: { id: userId } });
    mockSameOrigin.mockReturnValue(false);

    const response = await POST(request(prospectId), context(prospectId));

    expect(response.status).toBe(403);
    expect(mockCreateSupabaseAdminClient).not.toHaveBeenCalled();
    expect(mockProcessResearchRun).not.toHaveBeenCalled();
  });

  it("rejects an unauthenticated request with 401 before using the admin client", async () => {
    mockRequireInternalUser.mockResolvedValue({ authorized: false, status: 401, reason: "unauthenticated" });

    const response = await POST(request(prospectId), context(prospectId));

    expect(response.status).toBe(401);
    expect(mockCreateSupabaseAdminClient).not.toHaveBeenCalled();
    expect(mockProcessResearchRun).not.toHaveBeenCalled();
  });

  it("rejects an authenticated email outside the internal allow-list with 403", async () => {
    mockRequireInternalUser.mockResolvedValue({ authorized: false, status: 403, reason: "not_allowlisted" });

    const response = await POST(request(prospectId), context(prospectId));

    expect(response.status).toBe(403);
    expect(mockCreateSupabaseAdminClient).not.toHaveBeenCalled();
  });

  it("creates a queued research run for an authorized prospect", async () => {
    mockRequireInternalUser.mockResolvedValue({ authorized: true, user: { id: userId } });
    const { prospects, companies, runs } = setupAdmin();
    mockProcessResearchRun.mockResolvedValue({
      researchRunId: "a12ef940-92c0-42a5-a1a2-96c33c391900",
      status: "completed",
      result: {},
      alreadyCompleted: false,
    });

    const response = await POST(request(prospectId), context(prospectId));
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body).toEqual({ researchRunId: "a12ef940-92c0-42a5-a1a2-96c33c391900", status: "completed" });
    expect(prospects.eq).toHaveBeenCalledWith("id", prospectId);
    expect(companies.eq).toHaveBeenCalledWith("id", companyId);
    expect(runs.insert).toHaveBeenCalledWith({ company_id: companyId, status: "queued", created_by: userId });
    expect(mockProcessResearchRun).toHaveBeenCalledWith("a12ef940-92c0-42a5-a1a2-96c33c391900");
  });

  it("returns the failed status without exposing worker errors", async () => {
    mockRequireInternalUser.mockResolvedValue({ authorized: true, user: { id: userId } });
    const { finalRuns } = setupAdmin({
      finalRun: {
        data: { id: "a12ef940-92c0-42a5-a1a2-96c33c391900", company_id: companyId, status: "failed" },
        error: null,
      },
    });
    mockProcessResearchRun.mockRejectedValue(new Error("sensitive database details"));

    const response = await POST(request(prospectId), context(prospectId));
    const body = await response.text();

    expect(response.status).toBe(500);
    expect(JSON.parse(body)).toEqual({ researchRunId: "a12ef940-92c0-42a5-a1a2-96c33c391900", status: "failed" });
    expect(body).not.toContain("sensitive database details");
    expect(finalRuns.maybeSingle).toHaveBeenCalledOnce();
  });

  it("returns 404 for a malformed prospect ID", async () => {
    mockRequireInternalUser.mockResolvedValue({ authorized: true, user: { id: userId } });

    const response = await POST(request("not-a-uuid"), context("not-a-uuid"));

    expect(response.status).toBe(404);
    expect(mockCreateSupabaseAdminClient).not.toHaveBeenCalled();
    expect(mockProcessResearchRun).not.toHaveBeenCalled();
  });

  it("returns 404 when the prospect does not exist", async () => {
    mockRequireInternalUser.mockResolvedValue({ authorized: true, user: { id: userId } });
    const { companies, runs } = setupAdmin({ prospect: { data: null, error: null } });

    const response = await POST(request(prospectId), context(prospectId));

    expect(response.status).toBe(404);
    expect(companies.maybeSingle).not.toHaveBeenCalled();
    expect(runs.insert).not.toHaveBeenCalled();
  });

  it("returns 404 when the prospect's company is missing", async () => {
    mockRequireInternalUser.mockResolvedValue({ authorized: true, user: { id: userId } });
    const { runs } = setupAdmin({ company: { data: null, error: null } });

    const response = await POST(request(prospectId), context(prospectId));

    expect(response.status).toBe(404);
    expect(runs.insert).not.toHaveBeenCalled();
  });
});
