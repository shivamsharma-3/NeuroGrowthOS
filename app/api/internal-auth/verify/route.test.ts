import { beforeEach, describe, expect, it, vi } from "vitest";

const { mockVerifyOtp, mockSignOut } = vi.hoisted(() => ({
  mockVerifyOtp: vi.fn(),
  mockSignOut: vi.fn(),
}));

vi.mock("@/lib/supabase/server", () => ({
  createSupabaseSessionClient: vi.fn(async () => ({
    auth: { verifyOtp: mockVerifyOtp, signOut: mockSignOut },
  })),
}));

import { POST } from "./route";

function makeRequest(body: unknown) {
  return new Request("http://localhost:3000/api/internal-auth/verify", {
    method: "POST",
    headers: { origin: "http://localhost:3000", "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

describe("POST /api/internal-auth/verify", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    process.env.GROWTHOS_INTERNAL_EMAILS = "user@example.com";
  });

  it("verifies the email OTP for an allow-listed user", async () => {
    mockVerifyOtp.mockResolvedValue({
      data: { user: { email: "user@example.com", email_confirmed_at: "2026-10-04T00:00:00Z" } },
      error: null,
    });

    const response = await POST(makeRequest({ email: "user@example.com", token: "123456" }));

    expect(response.status).toBe(200);
    expect(mockVerifyOtp).toHaveBeenCalledWith({ email: "user@example.com", token: "123456", type: "email" });
    expect(await response.json()).toEqual({ message: "Signed in successfully." });
  });

  it("rejects invalid codes", async () => {
    mockVerifyOtp.mockResolvedValue({ data: { user: null }, error: new Error("invalid") });

    const response = await POST(makeRequest({ email: "user@example.com", token: "123456" }));

    expect(response.status).toBe(401);
  });

  it("rejects malformed codes before verification", async () => {
    const response = await POST(makeRequest({ email: "user@example.com", token: "12x" }));

    expect(response.status).toBe(400);
    expect(mockVerifyOtp).not.toHaveBeenCalled();
  });

  it("rejects a valid OTP belonging to an email outside the allow-list", async () => {
    mockVerifyOtp.mockResolvedValue({
      data: { user: { email: "other@example.com", email_confirmed_at: "2026-10-04T00:00:00Z" } },
      error: null,
    });

    const response = await POST(makeRequest({ email: "user@example.com", token: "123456" }));

    expect(response.status).toBe(401);
    expect(mockSignOut).toHaveBeenCalledWith({ scope: "local" });
  });
});
