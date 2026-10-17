import { NextResponse } from "next/server";
import { z } from "zod";
import { authorizeInternalEmail } from "@/lib/auth/email-allowlist";
import { isSameOriginRequest } from "@/lib/auth/internal-authorization";
import { createSupabaseSessionClient } from "@/lib/supabase/server";

const VerifyRequestSchema = z.object({
  email: z.string().trim().email().max(254),
  token: z.string().trim().regex(/^\d{4,12}$/, "Enter the verification code from your email."),
});

function invalidCodeResponse() {
  return NextResponse.json({ error: "The verification code is invalid or expired." }, { status: 401 });
}

export async function POST(request: Request) {
  if (!isSameOriginRequest(request)) {
    return NextResponse.json({ error: "Invalid request origin." }, { status: 403 });
  }

  const parsed = VerifyRequestSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ error: "Enter a valid email address and verification code." }, { status: 400 });
  }

  const email = parsed.data.email.toLowerCase();
  const decision = authorizeInternalEmail(email);
  if (!decision.authorized) {
    if (decision.reason === "allowlist_not_configured") {
      return NextResponse.json({ error: "Internal sign-in is not configured." }, { status: 503 });
    }
    return invalidCodeResponse();
  }

  try {
    const supabase = await createSupabaseSessionClient();
    const { data, error } = await supabase.auth.verifyOtp({
      email,
      token: parsed.data.token,
      type: "email",
    });

    if (error || !data.user?.email_confirmed_at || !authorizeInternalEmail(data.user.email).authorized) {
      if (data.user) await supabase.auth.signOut({ scope: "local" });
      return invalidCodeResponse();
    }

    return NextResponse.json({ message: "Signed in successfully." });
  } catch {
    return NextResponse.json({ error: "Internal sign-in is unavailable." }, { status: 503 });
  }
}
