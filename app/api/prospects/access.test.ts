import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { mockRequireInternalUser, mockSameOrigin, mockCreateAdmin } = vi.hoisted(() => ({
  mockRequireInternalUser: vi.fn(),
  mockSameOrigin: vi.fn(() => true),
  mockCreateAdmin: vi.fn(),
}));

vi.mock("@/lib/auth/internal-authorization", () => ({
  requireInternalUser: mockRequireInternalUser,
  isSameOriginRequest: mockSameOrigin,
}));
vi.mock("@/lib/supabase/admin", () => ({
  createSupabaseAdminClient: mockCreateAdmin,
  safeDatabaseErrorCode: vi.fn(() => "test_error"),
}));

import { GET as listProspects, POST as createProspect } from "./route";
import { POST as importProspects } from "./import/route";
import { GET as getCurrentScore, POST as scoreProspect } from "./[id]/score/route";
import { GET as getScoreHistory } from "./[id]/score/history/route";

const prospectId = "99a276e3-a216-4ae2-ab96-d98f57ee4c1b";
const context = { params: Promise.resolve({ id: prospectId }) };
const request = (path: string, method = "GET") => new Request(`https://app.example.com${path}`, {
  method,
  headers: method === "POST" ? { origin: "https://app.example.com", "content-type": "application/json" } : undefined,
  body: method === "POST" ? "{}" : undefined,
});

describe("prospect API access boundary", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockSameOrigin.mockReturnValue(true);
  });

  it("denies every prospect and score endpoint before privileged database access", async () => {
    mockRequireInternalUser.mockResolvedValue({ authorized: false, status: 401, reason: "unauthenticated" });

    const responses = await Promise.all([
      listProspects(),
      createProspect(request("/api/prospects", "POST")),
      importProspects(request("/api/prospects/import", "POST")),
      getCurrentScore(request(`/api/prospects/${prospectId}/score`), context),
      scoreProspect(request(`/api/prospects/${prospectId}/score`, "POST"), context),
      getScoreHistory(request(`/api/prospects/${prospectId}/score/history`), context),
    ]);

    expect(responses.map(({ status }) => status)).toEqual([401, 401, 401, 401, 401, 401]);
    expect(mockCreateAdmin).not.toHaveBeenCalled();
  });

  it("rejects cross-origin prospect, import, and scoring mutations", async () => {
    mockRequireInternalUser.mockResolvedValue({ authorized: true, user: { id: "user-id" } });
    mockSameOrigin.mockReturnValue(false);

    const responses = await Promise.all([
      createProspect(request("/api/prospects", "POST")),
      importProspects(request("/api/prospects/import", "POST")),
      scoreProspect(request(`/api/prospects/${prospectId}/score`, "POST"), context),
    ]);

    expect(responses.map(({ status }) => status)).toEqual([403, 403, 403]);
    expect(mockCreateAdmin).not.toHaveBeenCalled();
  });

  it("uses only the server admin client and generic database failure messages", () => {
    for (const path of [
      "app/api/prospects/route.ts",
      "app/api/prospects/import/route.ts",
      "app/api/prospects/[id]/score/route.ts",
      "app/api/prospects/[id]/score/history/route.ts",
    ]) {
      const source = readFileSync(resolve(process.cwd(), path), "utf8");
      expect(source).toContain("createSupabaseAdminClient");
      expect(source).not.toContain("createSupabaseServerClient");
      expect(source).not.toMatch(/error instanceof Error \? error\.message/);
      expect(source).not.toMatch(/console\.error\([^\n]*,\s*error\s*\)/);
    }
  });
});

describe("internal data migration", () => {
  const migration = readFileSync(
    resolve(process.cwd(), "supabase/migrations/20261017000000_restrict_internal_data_access.sql"),
    "utf8",
  );

  it.each(["companies", "contacts", "prospects", "prospect_score_runs", "prospect_score_factors"])(
    "removes browser grants from %s while preserving service-role access",
    (table) => {
      expect(migration).toMatch(new RegExp(`revoke all on table public\\.${table} from public, anon, authenticated`, "i"));
      expect(migration).toMatch(new RegExp(`grant all on table public\\.${table} to service_role`, "i"));
    },
  );

  it("removes browser execution of both mutation functions", () => {
    expect(migration).toMatch(/revoke execute on function public\.create_prospect_bundle\(jsonb\) from public, anon, authenticated/i);
    expect(migration).toMatch(/revoke execute on function public\.persist_icp_score_run[\s\S]*from public, anon, authenticated/i);
    expect(migration).toMatch(/grant execute on function public\.create_prospect_bundle\(jsonb\) to service_role/i);
    expect(migration).toMatch(/grant execute on function public\.persist_icp_score_run[\s\S]*to service_role/i);
  });

  it("drops every legacy browser policy by its declared name", () => {
    for (const policy of [
      "anon can read companies",
      "anon can read contacts",
      "anon can read prospects",
      "anon can create prospect bundles",
      "anon can create contacts",
      "anon can create prospects",
      "anon can update prospect score",
      "anon can read score runs",
      "anon can insert score runs",
      "anon can read score factors",
      "anon can insert score factors",
    ]) {
      expect(migration).toContain(`drop policy if exists "${policy}"`);
    }
  });
});
