import { NextResponse } from "next/server";
import { z } from "zod";
import { isSameOriginRequest, requireInternalUser } from "@/lib/auth/internal-authorization";
import { createSupabaseAdminClient } from "@/lib/supabase/admin";
import { processResearchRun } from "@/lib/research/worker";

const ProspectIdSchema = z.string().uuid();

export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const access = await requireInternalUser();
  if (!access.authorized) {
    return NextResponse.json({ error: access.reason }, { status: access.status });
  }
  if (!isSameOriginRequest(request)) {
    return NextResponse.json({ error: "Invalid request origin." }, { status: 403 });
  }

  const { id } = await params;
  if (!ProspectIdSchema.safeParse(id).success) {
    return NextResponse.json({ error: "Prospect not found." }, { status: 404 });
  }

  try {
    const supabase = createSupabaseAdminClient();
    const { data: prospect, error: prospectError } = await supabase
      .from("prospects")
      .select("id, company_id")
      .eq("id", id)
      .maybeSingle();

    if (prospectError) throw prospectError;
    if (!prospect) return NextResponse.json({ error: "Prospect not found." }, { status: 404 });

    const { data: company, error: companyError } = await supabase
      .from("companies")
      .select("id")
      .eq("id", prospect.company_id)
      .maybeSingle();

    if (companyError) throw companyError;
    if (!company) return NextResponse.json({ error: "Prospect company not found." }, { status: 404 });

    const { data: researchRun, error: researchRunError } = await supabase
      .from("company_research_runs")
      .insert({
        company_id: company.id,
        status: "queued",
        created_by: access.user.id,
      })
      .select("id, status")
      .single();

    if (researchRunError) throw researchRunError;

    try {
      const result = await processResearchRun(researchRun.id);
      return NextResponse.json({ researchRunId: result.researchRunId, status: result.status });
    } catch {
      const { data: finalRun, error: finalRunError } = await supabase
        .from("company_research_runs")
        .select("id, company_id, status")
        .eq("id", researchRun.id)
        .eq("company_id", company.id)
        .maybeSingle();

      if (finalRunError || !finalRun) {
        return NextResponse.json(
          { error: "Research processing could not be completed.", researchRunId: researchRun.id },
          { status: 503 },
        );
      }

      return NextResponse.json(
        { researchRunId: finalRun.id, status: finalRun.status },
        { status: finalRun.status === "failed" ? 500 : 503 },
      );
    }
  } catch {
    return NextResponse.json({ error: "Could not create a research run." }, { status: 503 });
  }
}
