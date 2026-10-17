import { NextResponse } from "next/server";
import { scoreIcp } from "@/lib/icp/scorer";
import { buildScoreFactorRecords, formatIcpReason } from "@/lib/icp/persistence";
import { createSupabaseAdminClient, safeDatabaseErrorCode } from "@/lib/supabase/admin";
import { isSameOriginRequest, requireInternalUser } from "@/lib/auth/internal-authorization";
import { adaptAcceptedGrowthSignals, adaptAcceptedResearchFacts, attachIcpGrowthSignalProvenance, attachIcpResearchProvenance } from "@/lib/icp/research-adapter";
import type { IcpCompanyInput } from "@/types/icp";

export const dynamic = "force-dynamic";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

// ─── POST /api/prospects/:id/score ────────────────────────────────────────────
// Run the deterministic scorer, persist a new score run + six factor rows
// atomically via the persist_icp_score_run RPC, then update the prospect
// projection columns. Returns the scorer result and score_run_id.
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
  if (!UUID_RE.test(id)) {
    return NextResponse.json({ error: "A valid prospect ID is required." }, { status: 400 });
  }

  try {
    const supabase = createSupabaseAdminClient();

    // 1. Load company data
    const { data: row, error: loadError } = await supabase
      .from("prospects")
      .select("id, company_id, company:companies(industry, platform, country, employee_count, estimated_revenue, revenue_amount, revenue_currency, revenue_period, revenue_source, revenue_observed_at)")
      .eq("id", id)
      .single();
    if (loadError) {
      throw new Error(loadError.message || "Failed to load company data.");
    }

    const company = row.company as unknown as {
      industry: string | null;
      platform: string | null;
      country: string | null;
      employee_count: number | null;
      estimated_revenue: number | null;
      revenue_amount: number | null;
      revenue_currency: string | null;
      revenue_period: IcpCompanyInput["revenue"]["period"];
      revenue_source: string | null;
      revenue_observed_at: string | null;
    };

    // 2. Run deterministic scorer
    const canonicalInput: IcpCompanyInput = {
      revenue: {
        amount: company.revenue_amount,
        currency: company.revenue_currency,
        period: company.revenue_period,
        source: company.revenue_source,
        observedAt: company.revenue_observed_at,
        legacyEstimatedRevenue: company.estimated_revenue,
      },
      industry: company.industry,
      platform: company.platform,
      country: company.country,
      employeeCount: company.employee_count,
      growthSignals: null,
    };

    const { data: acceptedFacts, error: factsError } = await supabase
      .from("company_facts")
      .select("*")
      .eq("company_id", row.company_id)
      .eq("status", "accepted");
    if (factsError) throw new Error("Failed to load accepted research facts.");

    const evidenceIds = [...new Set((acceptedFacts ?? [])
      .map((fact) => fact.source_evidence_id)
      .filter((evidenceId): evidenceId is string => typeof evidenceId === "string"))];
    let evidenceRows: unknown[] = [];
    if (evidenceIds.length > 0) {
      const { data, error } = await supabase
        .from("company_evidence")
        .select("*")
        .eq("company_id", row.company_id)
        .in("id", evidenceIds);
      if (error) throw new Error("Failed to load research fact evidence.");
      evidenceRows = data ?? [];
    }

    const asOf = new Date();
    const adapted = adaptAcceptedResearchFacts(canonicalInput, acceptedFacts ?? [], evidenceRows, asOf, row.company_id);
    const { data: growthSignals, error: signalsError } = await supabase.from("company_growth_signals")
      .select("*").eq("company_id", row.company_id);
    if (signalsError) throw new Error("Failed to load research growth signals.");
    const growthEvidenceIds = [...new Set((growthSignals ?? [])
      .map((signal) => signal.evidence_id)
      .filter((evidenceId): evidenceId is string => typeof evidenceId === "string"))];
    let growthEvidence: unknown[] = [];
    if (growthEvidenceIds.length > 0) {
      const { data, error } = await supabase.from("company_evidence").select("*")
        .eq("company_id", row.company_id).in("id", growthEvidenceIds);
      if (error) throw new Error("Failed to load growth signal evidence.");
      growthEvidence = data ?? [];
    }
    const { data: latestResearch, error: researchError } = await supabase.from("company_research_runs")
      .select("completed_at").eq("company_id", row.company_id).eq("status", "completed")
      .order("completed_at", { ascending: false }).limit(1).maybeSingle();
    if (researchError) throw new Error("Failed to load research completion date.");
    const growthAdapted = adaptAcceptedGrowthSignals(
      adapted.input, growthSignals ?? [], growthEvidence, latestResearch?.completed_at ?? null, asOf, row.company_id,
    );
    const score = scoreIcp(growthAdapted.input, asOf);
    const withFactProvenance = attachIcpResearchProvenance(score, adapted.provenance);
    const result = attachIcpGrowthSignalProvenance(withFactProvenance, growthAdapted.provenance);

    // 3. Build factor rows and icpReason projection
    const factors = buildScoreFactorRecords("", result).map(({ factor_key, score, max_score, status, reason }) => ({
      factor_key,
      score,
      max_score,
      status,
      reason,
    }));
    const icpReason = formatIcpReason(result);

    // 4. Persist atomically via RPC (creates run + 6 factors + updates prospect)
    const { data: runId, error: rpcError } = await supabase.rpc("persist_icp_score_run", {
      p_prospect_id: id,
      p_version:     result.scoreVersion,
      p_total_score: result.totalScore,
      p_priority:    result.priority,
      p_coverage:    result.coverage.percent,
      p_status:      result.scoringStatus,
      p_scored_at:   result.scoredAt,
      p_icp_reason:  icpReason,
      p_factors:     factors,
    });
    if (rpcError) {
      throw new Error(rpcError.message || "Failed to persist score run.");
    }

    return NextResponse.json({ result, score_run_id: runId as string });
  } catch (error) {
    console.error("Failed to score prospect", { code: safeDatabaseErrorCode(error) });
    return NextResponse.json(
      { error: "Could not score this prospect." },
      { status: 503 },
    );
  }
}

// ─── GET /api/prospects/:id/score ─────────────────────────────────────────────
// Return the current score run with all six factor rows.
export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const access = await requireInternalUser();
  if (!access.authorized) {
    return NextResponse.json({ error: access.reason }, { status: access.status });
  }

  const { id } = await params;
  if (!UUID_RE.test(id)) {
    return NextResponse.json({ error: "A valid prospect ID is required." }, { status: 400 });
  }

  try {
    const supabase = createSupabaseAdminClient();

    // 1. Resolve current_score_run_id from prospect
    const { data: prospect, error: pErr } = await supabase
      .from("prospects")
      .select("current_score_run_id, icp_scoring_status")
      .eq("id", id)
      .single();
    if (pErr) {
      throw new Error(pErr.message || "Failed to fetch prospect score pointer.");
    }

    if (!prospect?.current_score_run_id) {
      return NextResponse.json({ error: "This prospect has not been scored yet." }, { status: 404 });
    }

    // 2. Fetch score run
    const { data: run, error: rErr } = await supabase
      .from("prospect_score_runs")
      .select("id, prospect_id, score_version, total_score, priority, coverage, scoring_status, scored_at, created_at")
      .eq("id", prospect.current_score_run_id)
      .single();
    if (rErr) {
      throw new Error(rErr.message || "Failed to fetch score run.");
    }

    // 3. Fetch all 6 factor rows
    const { data: factors, error: fErr } = await supabase
      .from("prospect_score_factors")
      .select("id, score_run_id, factor_key, score, max_score, status, reason, created_at")
      .eq("score_run_id", run.id)
      .order("created_at", { ascending: true });
    if (fErr) {
      throw new Error(fErr.message || "Failed to fetch score factors.");
    }

    return NextResponse.json({
      score_run_id:      run.id,
      score_version:     run.score_version,
      total_score:       run.total_score,
      priority:          run.priority,
      coverage:          run.coverage,
      scoring_status:    run.scoring_status,
      scored_at:         run.scored_at,
      factors:           factors ?? [],
      current_score_run: run,
    });
  } catch (error) {
    console.error("Failed to load current score", { code: safeDatabaseErrorCode(error) });
    return NextResponse.json(
      { error: "Could not load score." },
      { status: 503 },
    );
  }
}
