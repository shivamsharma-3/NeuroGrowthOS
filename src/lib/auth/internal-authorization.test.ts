import { afterEach, describe, expect, it, vi } from "vitest";

const { mockCreateSessionClient } = vi.hoisted(() => ({ mockCreateSessionClient: vi.fn() }));
vi.mock("@/lib/supabase/server", () => ({ createSupabaseSessionClient: mockCreateSessionClient }));

import { authorizeInternalEmail, parseInternalEmailAllowlist } from "@/lib/auth/email-allowlist";
import { isSameOriginRequest, requireInternalUser } from "@/lib/auth/internal-authorization";

afterEach(() => {
  vi.clearAllMocks();
  delete process.env.GROWTHOS_INTERNAL_EMAILS;
});

describe("internal email authorization", () => {
  it("rejects an unauthenticated user", () => {
    expect(authorizeInternalEmail(null, "growth@example.com")).toEqual({
      authorized: false,
      status: 401,
      reason: "unauthenticated",
    });
  });

  it("rejects an authenticated user outside the allow-list", () => {
    expect(authorizeInternalEmail("other@example.com", "growth@example.com")).toEqual({
      authorized: false,
      status: 403,
      reason: "not_allowlisted",
    });
  });

  it("accepts an allow-listed user case-insensitively", () => {
    expect(authorizeInternalEmail(" Growth@Example.com ", "growth@example.com")).toEqual({
      authorized: true,
    });
  });

  it("parses comma-separated allow-list entries and fails closed when empty", () => {
    expect([...parseInternalEmailAllowlist("one@example.com, TWO@example.com ")]).toEqual([
      "one@example.com",
      "two@example.com",
    ]);
    expect(authorizeInternalEmail("one@example.com", " ")).toEqual({
      authorized: false,
      status: 503,
      reason: "allowlist_not_configured",
    });
  });
});

describe("same-origin mutation protection", () => {
  it("accepts only an exact serialized origin", () => {
    const sameOrigin = new Request("https://app.example.com/api/prospects", {
      method: "POST",
      headers: { origin: "https://app.example.com" },
    });
    const crossOrigin = new Request("https://app.example.com/api/prospects", {
      method: "POST",
      headers: { origin: "https://attacker.example" },
    });
    const missingOrigin = new Request("https://app.example.com/api/prospects", { method: "POST" });

    expect(isSameOriginRequest(sameOrigin)).toBe(true);
    expect(isSameOriginRequest(crossOrigin)).toBe(false);
    expect(isSameOriginRequest(missingOrigin)).toBe(false);
  });
});

describe("request-scoped internal authorization", () => {
  it("fails closed before session access when the allowlist is missing", async () => {
    process.env.GROWTHOS_INTERNAL_EMAILS = "";

    await expect(requireInternalUser()).resolves.toEqual({
      authorized: false,
      status: 503,
      reason: "allowlist_not_configured",
    });
    expect(mockCreateSessionClient).not.toHaveBeenCalled();
  });

  it("returns a safe unavailable result when session initialization fails", async () => {
    process.env.GROWTHOS_INTERNAL_EMAILS = "user@example.com";
    mockCreateSessionClient.mockRejectedValue(new Error("private configuration detail"));

    await expect(requireInternalUser()).resolves.toEqual({
      authorized: false,
      status: 503,
      reason: "authentication_unavailable",
    });
  });

  it("accepts a confirmed allowlisted session", async () => {
    process.env.GROWTHOS_INTERNAL_EMAILS = "user@example.com";
    const user = { id: "user-id", email: "user@example.com", email_confirmed_at: "2026-10-17T00:00:00Z" };
    mockCreateSessionClient.mockResolvedValue({ auth: { getUser: vi.fn().mockResolvedValue({ data: { user }, error: null }) } });

    await expect(requireInternalUser()).resolves.toEqual({ authorized: true, user });
  });
});
