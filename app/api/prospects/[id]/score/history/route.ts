import { NextResponse } from "next/server";
import { requireInternalUser } from "@/lib/auth/internal-authorization";
import { createSupabaseAdminClient, safeDatabaseErrorCode } from "@/lib/supabase/admin";
import type { ScoreHistoryItem } from "@/types/score-history";

export const dynamic = "force-dynamic";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

// ─── GET /api/prospects/:id/score/history ────────────────────────────────────
// Return scoring runs for a prospect in newest-first order.
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

    const { data: runs, error } = await supabase
      .from("prospect_score_runs")
      .select("id, score_version, total_score, priority, coverage, scoring_status, scored_at")
      .eq("prospect_id", id)
      .order("scored_at", { ascending: false });

    if (error) {
      throw new Error(error.message || "Failed to load score history from database.");
    }

    const history: ScoreHistoryItem[] = (runs ?? []).map((run) => ({
      run_id:         run.id,
      score_version:  run.score_version,
      total_score:    run.total_score,
      priority:       run.priority,
      coverage:       run.coverage,
      scoring_status: run.scoring_status,
      scored_at:      run.scored_at,
    }));

    return NextResponse.json({ history });
  } catch (error) {
    console.error("Failed to load score history", { code: safeDatabaseErrorCode(error) });
    return NextResponse.json(
      { error: "Could not load score history." },
      { status: 503 },
    );
  }
}
