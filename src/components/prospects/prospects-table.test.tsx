import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { ProspectsTable } from "./prospects-table";
import type { Prospect } from "@/types/prospects";

const prospect: Prospect = {
  id: "d76481b4-715e-44f8-9cd7-bdc432aa1613",
  company_id: "af2b7bb2-21cc-46f2-97c3-b83bfdc990a2",
  contact_id: null,
  icp_score: null,
  icp_reason: null,
  icp_score_version: null,
  icp_scored_at: null,
  icp_coverage: null,
  icp_scoring_status: "unscored",
  status: "new",
  source: "manual",
  created_at: "2026-10-06T10:00:00.000Z",
  updated_at: "2026-10-06T10:00:00.000Z",
  company: {
    id: "af2b7bb2-21cc-46f2-97c3-b83bfdc990a2",
    name: "GrowthOS Live Research Verification",
    website: "https://patagonia.com",
    domain: "patagonia.com",
    industry: null,
    country: null,
    estimated_revenue: null,
    revenue_amount: null,
    revenue_currency: null,
    revenue_period: null,
    revenue_source: null,
    revenue_observed_at: null,
    employee_count: null,
    platform: null,
    linkedin_url: null,
  },
  contact: null,
};

function renderTable(options: { researching?: boolean; result?: { researchRunId: string; status: "completed" } } = {}) {
  return renderToStaticMarkup(<ProspectsTable
    prospects={[prospect]}
    loading={false}
    error={null}
    onRetry={vi.fn()}
    onAdd={vi.fn()}
    scoringId={null}
    onScore={vi.fn()}
    researchingId={options.researching ? prospect.id : null}
    researchResults={options.result ? { [prospect.id]: options.result } : {}}
    onResearch={vi.fn()}
  />);
}

describe("prospect research table action", () => {
  it("renders a Research button and displays the resulting status and run ID", () => {
    const markup = renderTable({ result: { researchRunId: "a12ef940-92c0-42a5-a1a2-96c33c391900", status: "completed" } });
    expect(markup).toContain(">Research</button>");
    expect(markup).toContain("completed · a12ef940-92c0-42a5-a1a2-96c33c391900");
  });

  it("shows a disabled loading button while research is running", () => {
    const markup = renderTable({ researching: true });
    expect(markup).toContain("Researching…");
    expect(markup).toContain("disabled=");
  });
});
