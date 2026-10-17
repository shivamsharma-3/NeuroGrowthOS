import "server-only";
import { createClient } from "@supabase/supabase-js";

/** Service-role access is server-only and must follow internal-user authorization. */
export function createSupabaseAdminClient() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

  if (!url || !serviceRoleKey) {
    throw new Error("Server-side Supabase service-role configuration is missing.");
  }

  return createClient(url, serviceRoleKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
}

/** Keep database diagnostics useful without logging messages, details, or payloads. */
export function safeDatabaseErrorCode(error: unknown): string {
  if (!error || typeof error !== "object" || !("code" in error)) return "unknown";
  const code = (error as { code?: unknown }).code;
  return typeof code === "string" && /^[A-Za-z0-9_]{1,64}$/.test(code) ? code : "unknown";
}
