import { NextResponse } from "next/server";
import { z } from "zod";
import { authorizeInternalEmail } from "@/lib/auth/email-allowlist";
import { isSameOriginRequest } from "@/lib/auth/internal-authorization";
import { createSupabaseSessionClient } from "@/lib/supabase/server";

const LoginRequestSchema = z.object({ email: z.string().trim().email().max(254) });
const GENERIC_RESPONSE = { message: "If this email is authorized, a verification code will arrive shortly." };

export async function POST(request: Request) {
  if (!isSameOriginRequest(request)) {
    return NextResponse.json({ error: "Invalid request origin." }, { status: 403 });
  }

  const parsed = LoginRequestSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: "Enter a valid email address." }, { status: 400 });

  const email = parsed.data.email.toLowerCase();
  const decision = authorizeInternalEmail(email);
  if (!decision.authorized && decision.reason === "allowlist_not_configured") {
    return NextResponse.json({ error: "Internal sign-in is not configured." }, { status: 503 });
  }

  // Keep responses indistinguishable for allowed and non-allowed email addresses.
  if (!decision.authorized) return NextResponse.json(GENERIC_RESPONSE, { status: 202 });

  try {
    const supabase = await createSupabaseSessionClient();
    const { error } = await supabase.auth.signInWithOtp({
      email,
      options: { shouldCreateUser: true },
    });

    if (error) {
      console.error("[internal-auth] signInWithOtp failed", { code: error.code ?? "unknown" });
      // Do not reveal whether an address is allow-listed or present in Auth.
      return NextResponse.json(GENERIC_RESPONSE, { status: 202 });
    }
    return NextResponse.json(GENERIC_RESPONSE, { status: 202 });
  } catch {
    return NextResponse.json({ error: "Internal sign-in is unavailable." }, { status: 503 });
  }
}
