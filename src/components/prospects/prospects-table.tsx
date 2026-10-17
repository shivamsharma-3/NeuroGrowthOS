"use client";

import { ArrowDown, ArrowUpDown, Building2, Globe2, LoaderCircle, Mail, Search, Sparkles } from "lucide-react";
import type { Prospect, ProspectStatus } from "@/types/prospects";
import type { ProspectResearchResult } from "@/lib/prospects/research-action";

interface Props {
  prospects: Prospect[];
  loading: boolean;
  error: string | null;
  onRetry: () => void;
  onAdd: () => void;
  scoringId: string | null;
  onScore: (id: string) => void;
  onInspectScore?: (prospect: Prospect) => void;
  researchingId: string | null;
  researchResults: Record<string, ProspectResearchResult>;
  onResearch: (id: string) => void;
}

const labels: Record<ProspectStatus, string> = {
  new: "New",
  researching: "Researching",
  qualified: "Qualified",
  contacted: "Contacted",
  in_progress: "In progress",
  converted: "Converted",
  disqualified: "Disqualified",
};

function hostLabel(value: string | null) {
  if (!value) return "—";
  try {
    return new URL(value.startsWith("http") ? value : `https://${value}`).hostname.replace(/^www\./, "");
  } catch {
    return value;
  }
}

export function ProspectsTable({
  prospects,
  loading,
  error,
  onRetry,
  onAdd,
  scoringId,
  onScore,
  onInspectScore,
  researchingId,
  researchResults,
  onResearch,
}: Props) {
  return (
    <div className="table-card">
      <div className="table-scroll">
        <table className="prospects-table">
          <thead>
            <tr>
              <th>
                <button className="sort-button" type="button">
                  Company <ArrowDown size={13} />
                </button>
              </th>
              <th>Website</th>
              <th>Industry</th>
              <th>Revenue</th>
              <th>Platform</th>
              <th>
                <button className="sort-button" type="button">
                  ICP score <ArrowUpDown size={13} />
                </button>
              </th>
              <th>Status</th>
              <th>
                <button className="sort-button" type="button">
                  Updated <ArrowDown size={13} />
                </button>
              </th>
            </tr>
          </thead>
          <tbody>
            {loading &&
              Array.from({ length: 6 }, (_, index) => (
                <tr key={`skeleton-${index}`} className="skeleton-row">
                  <td><span className="skeleton-line wide" /></td>
                  <td><span className="skeleton-line" /></td>
                  <td><span className="skeleton-line" /></td>
                  <td><span className="skeleton-line short" /></td>
                  <td><span className="skeleton-line short" /></td>
                  <td><span className="skeleton-pill" /></td>
                  <td><span className="skeleton-pill" /></td>
                  <td><span className="skeleton-line short" /></td>
                </tr>
              ))}
            {!loading && error && (
              <tr>
                <td colSpan={8}>
                  <div className="table-message error-state">
                    <div className="state-icon danger"><Building2 size={19} /></div>
                    <h3>Couldn’t load prospects</h3>
                    <p>{error}</p>
                    <button className="button button-secondary button-small" onClick={onRetry} type="button">
                      Try again
                    </button>
                  </div>
                </td>
              </tr>
            )}
            {!loading && !error && prospects.length === 0 && (
              <tr>
                <td colSpan={8}>
                  <div className="table-message">
                    <div className="state-icon"><Building2 size={19} /></div>
                    <h3>No prospects yet</h3>
                    <p>Add a company manually or import a CSV to start building your pipeline.</p>
                    <button className="button button-primary button-small" onClick={onAdd} type="button">
                      Add your first prospect
                    </button>
                  </div>
                </td>
              </tr>
            )}
            {!loading &&
              !error &&
              prospects.map((prospect) => (
                <tr key={prospect.id}>
                  <td>
                    <div className="company-cell">
                      <div className="company-avatar">{prospect.company.name.slice(0, 1).toUpperCase()}</div>
                      <div className="company-meta">
                        <span className="company-name">{prospect.company.name}</span>
                        <span>
                          {prospect.contact
                            ? [prospect.contact.first_name, prospect.contact.last_name].filter(Boolean).join(" ") ||
                              prospect.contact.email
                            : "No contact added"}
                        </span>
                        <button
                          className="score-action research-action"
                          type="button"
                          onClick={() => onResearch(prospect.id)}
                          disabled={researchingId !== null}
                          title="Run authenticated company research"
                        >
                          {researchingId === prospect.id ? <LoaderCircle size={13} className="spin" /> : <Search size={13} />}
                          {researchingId === prospect.id ? "Researching…" : "Research"}
                        </button>
                        {researchResults[prospect.id] && (
                          <span
                            className={`research-run-status research-status-${researchResults[prospect.id].status}`}
                            title={`Research run ${researchResults[prospect.id].researchRunId}`}
                            aria-live="polite"
                          >
                            {researchResults[prospect.id].status} · {researchResults[prospect.id].researchRunId}
                          </span>
                        )}
                        <button
                          className="score-action score-action-mobile"
                          type="button"
                          onClick={() => onScore(prospect.id)}
                          disabled={scoringId !== null}
                          title="Calculate deterministic ICP score"
                        >
                          {scoringId === prospect.id ? <LoaderCircle size={13} className="spin" /> : <Sparkles size={13} />}
                          {prospect.icp_scoring_status === "unscored" ? "Score" : "Re-score"}
                        </button>
                      </div>
                    </div>
                  </td>
                  <td>
                    {prospect.company.website ? (
                      <a
                        className="website-link"
                        href={prospect.company.website.startsWith("http") ? prospect.company.website : `https://${prospect.company.website}`}
                        target="_blank"
                        rel="noreferrer"
                      >
                        <Globe2 size={13} />
                        {hostLabel(prospect.company.website)}
                      </a>
                    ) : (
                      <span className="muted">—</span>
                    )}
                  </td>
                  <td>{prospect.company.industry ?? <span className="muted">—</span>}</td>
                  <td className="numeric-cell">
                    {prospect.company.revenue_amount !== null && prospect.company.revenue_currency
                      ? `${new Intl.NumberFormat("en", {
                          style: "currency",
                          currency: prospect.company.revenue_currency,
                          notation: prospect.company.revenue_amount >= 1_000_000 ? "compact" : "standard",
                          maximumFractionDigits: 0,
                        }).format(prospect.company.revenue_amount)} / ${prospect.company.revenue_period ?? "period unknown"}`
                      : prospect.company.estimated_revenue !== null
                      ? `${prospect.company.estimated_revenue.toLocaleString()} (currency/period unknown)*`
                      : "—"}
                  </td>
                  <td>{prospect.company.platform ?? <span className="muted">—</span>}</td>
                  <td>
                    <div className="score-cell">
                      {prospect.icp_score === null ? (
                        <button
                          type="button"
                          className="score-clickable score-empty"
                          onClick={() => onInspectScore?.(prospect)}
                          title="Click to inspect ICP score breakdown and history"
                        >
                          {prospect.icp_scoring_status === "insufficient_data"
                            ? `Insufficient data · ${prospect.icp_coverage ?? 0}%`
                            : "Not scored"}
                        </button>
                      ) : (
                        <button
                          type="button"
                          className="score-clickable score-button-wrap"
                          onClick={() => onInspectScore?.(prospect)}
                          title="Click to inspect ICP score breakdown and history"
                        >
                          <span
                            className={`score-value ${
                              prospect.icp_score >= 80 ? "score-high" : prospect.icp_score >= 60 ? "score-mid" : "score-low"
                            }`}
                          >
                            {Math.round(prospect.icp_score)}
                            <span>/100</span>
                            <small>{prospect.icp_coverage}% coverage</small>
                          </span>
                        </button>
                      )}
                      <button
                        className="score-action"
                        type="button"
                        onClick={() => onScore(prospect.id)}
                        disabled={scoringId !== null}
                        title="Calculate deterministic ICP score"
                      >
                        {scoringId === prospect.id ? <LoaderCircle size={13} className="spin" /> : <Sparkles size={13} />}
                        {prospect.icp_scoring_status === "unscored" ? "Score" : "Re-score"}
                      </button>
                    </div>
                  </td>
                  <td>
                    <span className={`status-badge status-${prospect.status}`}>
                      <i />
                      {labels[prospect.status]}
                    </span>
                  </td>
                  <td>
                    <time className="updated-time" dateTime={prospect.updated_at}>
                      {new Intl.DateTimeFormat("en", { month: "short", day: "numeric", year: "numeric" }).format(
                        new Date(prospect.updated_at),
                      )}
                    </time>
                  </td>
                </tr>
              ))}
          </tbody>
        </table>
      </div>
      {!loading && !error && prospects.length > 0 && (
        <footer className="table-footer">
          <span>
            Showing <strong>{prospects.length}</strong> prospects{" "}
            <span className="muted">· * legacy revenue has unknown currency/period and is excluded from scoring</span>
          </span>
          <span className="table-footer-hint">
            <Mail size={13} />
            Contact details are private to your team
          </span>
        </footer>
      )}
    </div>
  );
}
