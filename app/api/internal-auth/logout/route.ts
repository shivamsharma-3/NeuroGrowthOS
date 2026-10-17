import { NextResponse } from "next/server";
import { isSameOriginRequest } from "@/lib/auth/internal-authorization";
import { createSupabaseSessionClient } from "@/lib/supabase/server";

export async function POST(request: Request) {
  if (!isSameOriginRequest(request)) {
    return NextResponse.json({ error: "Invalid request origin." }, { status: 403 });
  }

  try {
    const supabase = await createSupabaseSessionClient();
    const { error } = await supabase.auth.signOut({ scope: "local" });
    if (error) return NextResponse.json({ error: "Could not sign out." }, { status: 503 });
    return NextResponse.json({ signedOut: true });
  } catch {
    return NextResponse.json({ error: "Could not sign out." }, { status: 503 });
  }
}
