export type InternalAccessDecision =
  | { authorized: true }
  | { authorized: false; status: 401 | 403 | 503; reason: "unauthenticated" | "not_allowlisted" | "allowlist_not_configured" | "authentication_unavailable" };

export function parseInternalEmailAllowlist(value: string | undefined = process.env.GROWTHOS_INTERNAL_EMAILS): Set<string> {
  return new Set(
    (value ?? "")
      .split(",")
      .map((email) => email.trim().toLowerCase())
      .filter(Boolean),
  );
}

export function authorizeInternalEmail(
  email: string | null | undefined,
  allowlistValue: string | undefined = process.env.GROWTHOS_INTERNAL_EMAILS,
): InternalAccessDecision {
  const allowlist = parseInternalEmailAllowlist(allowlistValue);
  if (allowlist.size === 0) {
    return { authorized: false, status: 503, reason: "allowlist_not_configured" };
  }
  if (!email) return { authorized: false, status: 401, reason: "unauthenticated" };
  if (!allowlist.has(email.trim().toLowerCase())) {
    return { authorized: false, status: 403, reason: "not_allowlisted" };
  }
  return { authorized: true };
}
