import { NextResponse } from "next/server";
import { isSameOriginRequest, requireInternalUser } from "@/lib/auth/internal-authorization";
import { createSupabaseAdminClient, safeDatabaseErrorCode } from "@/lib/supabase/admin";
import { normalizeProspectInput, prospectInputSchema } from "@/lib/prospects/validation";
import type { ProspectInput } from "@/types/prospects";

interface ImportEntry {
  line: number;
  input: ProspectInput;
}

export async function POST(request: Request) {
  const access = await requireInternalUser();
  if (!access.authorized) {
    return NextResponse.json({ error: access.reason }, { status: access.status });
  }
  if (!isSameOriginRequest(request)) {
    return NextResponse.json({ error: "Invalid request origin." }, { status: 403 });
  }

  const body: unknown = await request.json().catch(() => null);
  if (!Array.isArray(body) || body.length === 0 || body.length > 500) {
    return NextResponse.json({ error: "Import between 1 and 500 valid rows at a time." }, { status: 400 });
  }

  const valid: ImportEntry[] = [];
  const invalid: { row: number; error: string }[] = [];
  body.forEach((entry, index) => {
    const wrapped = typeof entry === "object" && entry !== null && "input" in entry ? entry as { line?: unknown; input: unknown } : { line: index + 2, input: entry };
    const line = typeof wrapped.line === "number" && Number.isInteger(wrapped.line) ? wrapped.line : index + 2;
    const parsed = prospectInputSchema.safeParse(wrapped.input);
    if (parsed.success) valid.push({ line, input: parsed.data });
    else invalid.push({ row: line, error: "Row data is invalid." });
  });

  let imported = 0;
  let duplicates = 0;
  const errors = [...invalid];
  const supabase = createSupabaseAdminClient();

  for (const entry of valid) {
    try {
      const normalized = normalizeProspectInput(entry.input);
      if (normalized.company.revenue_amount !== null) {
        normalized.company.revenue_source ||= "csv_import";
        normalized.company.revenue_observed_at ||= new Date().toISOString();
      }
      const payload = { ...normalized, source: "csv_import", skip_existing: true };
      const { data, error } = await supabase.rpc("create_prospect_bundle", { payload });
      if (error) throw error;
      const result = data as { duplicate?: boolean };
      if (result.duplicate) duplicates += 1;
      else imported += 1;
    } catch (error) {
      console.error("Failed to import CSV row", { row: entry.line, code: safeDatabaseErrorCode(error) });
      errors.push({ row: entry.line, error: "Import failed." });
    }
  }

  return NextResponse.json({ imported, duplicates, errors });
}
