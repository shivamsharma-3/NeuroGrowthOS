import type { User } from "@supabase/supabase-js";
import { authorizeInternalEmail, type InternalAccessDecision } from "@/lib/auth/email-allowlist";
import { createSupabaseSessionClient } from "@/lib/supabase/server";

export type { InternalAccessDecision } from "@/lib/auth/email-allowlist";

export type InternalUserResult =
  | { authorized: true; user: User }
  | Exclude<InternalAccessDecision, { authorized: true }>;

/** Reject cookie-authenticated mutations that were initiated by another origin. */
export function isSameOriginRequest(request: Request): boolean {
  const origin = request.headers.get("origin");
  if (!origin) return false;
  try {
    return origin === new URL(request.url).origin;
  } catch {
    return false;
  }
}

/** Call from future protected server routes before any privileged data access. */
export async function requireInternalUser(): Promise<InternalUserResult> {
  const configuration = authorizeInternalEmail(null);
  if (!configuration.authorized && configuration.reason === "allowlist_not_configured") return configuration;

  try {
    const supabase = await createSupabaseSessionClient();
    const { data, error } = await supabase.auth.getUser();
    const verifiedEmail = !error && data.user?.email_confirmed_at ? data.user.email : null;
    const decision = authorizeInternalEmail(verifiedEmail);

    if (!decision.authorized) return decision;
    return { authorized: true, user: data.user! };
  } catch {
    return { authorized: false, status: 503, reason: "authentication_unavailable" };
  }
}
