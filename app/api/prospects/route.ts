import { NextResponse } from "next/server";
import { isSameOriginRequest, requireInternalUser } from "@/lib/auth/internal-authorization";
import { createSupabaseAdminClient, safeDatabaseErrorCode } from "@/lib/supabase/admin";
import { normalizeProspectInput, prospectInputSchema } from "@/lib/prospects/validation";
import type { Prospect } from "@/types/prospects";

export const dynamic = "force-dynamic";

export async function GET() {
  const access = await requireInternalUser();
  if (!access.authorized) {
    return NextResponse.json({ error: access.reason }, { status: access.status });
  }

  try {
    const supabase = createSupabaseAdminClient();
    const { data, error } = await supabase
      .from("prospects")
      .select("id, company_id, contact_id, icp_score, icp_reason, icp_score_version, icp_scored_at, icp_coverage, icp_scoring_status, status, source, created_at, updated_at, company:companies(id, name, website, domain, industry, country, estimated_revenue, revenue_amount, revenue_currency, revenue_period, revenue_source, revenue_observed_at, employee_count, platform, linkedin_url), contact:contacts(id, first_name, last_name, email, job_title)")
      .order("updated_at", { ascending: false });

    if (error) throw error;
    return NextResponse.json({ prospects: (data ?? []) as unknown as Prospect[] });
  } catch (error) {
    console.error("Failed to load prospects", { code: safeDatabaseErrorCode(error) });
    return NextResponse.json({ error: "Could not load prospects." }, { status: 503 });
  }
}

export async function POST(request: Request) {
  const access = await requireInternalUser();
  if (!access.authorized) {
    return NextResponse.json({ error: access.reason }, { status: access.status });
  }
  if (!isSameOriginRequest(request)) {
    return NextResponse.json({ error: "Invalid request origin." }, { status: 403 });
  }

  const parsed = prospectInputSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ error: "Please check the company and contact details.", details: parsed.error.flatten() }, { status: 400 });
  }

  try {
    const supabase = createSupabaseAdminClient();
    const normalized = normalizeProspectInput(parsed.data);
    if (normalized.company.revenue_amount !== null) {
      normalized.company.revenue_source ||= normalized.source === "csv_import" ? "csv_import" : "manual";
      normalized.company.revenue_observed_at ||= new Date().toISOString();
    }
    const { data, error } = await supabase.rpc("create_prospect_bundle", { payload: normalized });
    if (error) throw error;
    return NextResponse.json({ result: data }, { status: 201 });
  } catch (error) {
    console.error("Failed to create prospect", { code: safeDatabaseErrorCode(error) });
    return NextResponse.json({ error: "Could not create prospect." }, { status: 503 });
  }
}
