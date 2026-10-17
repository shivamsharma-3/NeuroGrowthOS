import { NextResponse } from "next/server";
import { authorizeInternalEmail } from "@/lib/auth/email-allowlist";
import { createSupabaseSessionClient } from "@/lib/supabase/server";

export async function GET(request: Request) {
  const url = new URL(request.url);
  const code = url.searchParams.get("code");
  if (!code) return NextResponse.redirect(new URL("/login?error=sign_in", url.origin));

  try {
    const supabase = await createSupabaseSessionClient();
    const { error: exchangeError } = await supabase.auth.exchangeCodeForSession(code);
    if (exchangeError) return NextResponse.redirect(new URL("/login?error=sign_in", url.origin));

    const { data, error } = await supabase.auth.getUser();
    const verifiedEmail = !error && data.user?.email_confirmed_at ? data.user.email : null;
    const decision = authorizeInternalEmail(verifiedEmail);
    if (!decision.authorized) {
      await supabase.auth.signOut({ scope: "local" });
      return NextResponse.redirect(new URL("/login?error=not_authorized", url.origin));
    }

    return NextResponse.redirect(new URL("/prospects", url.origin));
  } catch {
    return NextResponse.redirect(new URL("/login?error=sign_in", url.origin));
  }
}
