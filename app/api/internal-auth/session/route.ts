import { NextResponse } from "next/server";
import { requireInternalUser } from "@/lib/auth/internal-authorization";

export const dynamic = "force-dynamic";

export async function GET() {
  const result = await requireInternalUser();
  if (!result.authorized) {
    return NextResponse.json({ error: result.reason }, { status: result.status });
  }
  return NextResponse.json({ user: { id: result.user.id, email: result.user.email } });
}
