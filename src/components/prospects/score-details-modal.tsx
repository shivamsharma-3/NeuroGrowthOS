"use client";

import { useEffect, useState } from "react";
import {
  AlertCircle,
  Clock,
  Globe2,
  History,
  Layers,
  LoaderCircle,
  Percent,
  Sparkles,
  X,
} from "lucide-react";
import type { Prospect } from "@/types/prospects";
import type { CurrentScoreResponse, ScoreFactor, ScoreHistoryItem } from "@/types/score-history";

interface Props {
  prospect: Prospect;
  onClose: () => void;
  onScore: (id: string) => Promise<void> | void;
  scoringId: string | null;
}

const FACTOR_TITLES: Record<string, string> = {
  revenue: "Revenue fit",
  industry: "Industry fit",
  platform: "Platform fit",
  geography: "Geography",
  company_size: "Company size",
  growth_signal: "Growth signals",
};

const FACTOR_ORDER = [
  "revenue",
  "industry",
  "platform",
  "geography",
  "company_size",
  "growth_signal",
];

export function ScoreDetailsModal({ prospect, onClose, onScore, scoringId }: Props) {
  const [scoreData, setScoreData] = useState<CurrentScoreResponse | null>(null);
  const [history, setHistory] = useState<ScoreHistoryItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [refreshIndex, setRefreshIndex] = useState(0);

  useEffect(() => {
    let active = true;

    Promise.all([
      fetch(`/api/prospects/${prospect.id}/score`, { cache: "no-store" }),
      fetch(`/api/prospects/${prospect.id}/score/history`, { cache: "no-store" }),
    ])
      .then(async ([resScore, resHistory]) => {
        if (!active) return;
        if (resScore.ok) {
          const data = (await resScore.json()) as CurrentScoreResponse;
          if (active) setScoreData(data);
        } else if (resScore.status === 404) {
          if (active) setScoreData(null);
        } else {
          const data = (await resScore.json().catch(() => ({}))) as { error?: string };
          throw new Error(data.error || "Could not load score details.");
        }

        if (resHistory.ok) {
          const hData = (await resHistory.json()) as { history?: ScoreHistoryItem[] };
          if (active) setHistory(hData.history ?? []);
        }
      })
      .catch((err: unknown) => {
        if (active) setError(err instanceof Error ? err.message : "Failed to load score data.");
      })
      .finally(() => {
        if (active) setLoading(false);
      });

    return () => {
      active = false;
    };
  }, [prospect.id, refreshIndex]);

  const handleScoreAndReload = async () => {
    setLoading(true);
    setError(null);
    await onScore(prospect.id);
    setRefreshIndex((prev) => prev + 1);
  };

  const isScoring = scoringId === prospect.id;

  // Sort factors according to FACTOR_ORDER
  const sortedFactors: ScoreFactor[] = scoreData?.factors
    ? [...scoreData.factors].sort((a, b) => {
        const idxA = FACTOR_ORDER.indexOf(a.factor_key);
        const idxB = FACTOR_ORDER.indexOf(b.factor_key);
        return (idxA >= 0 ? idxA : 99) - (idxB >= 0 ? idxB : 99);
      })
    : [];

  return (
    <div className="modal-backdrop" onClick={onClose} role="dialog" aria-modal="true">
      <div className="modal-card score-modal-card" onClick={(e) => e.stopPropagation()}>
        {/* Header */}
        <header className="modal-header">
          <div>
            <span className="eyebrow">ICP INTELLIGENCE · BREAKDOWN & HISTORY</span>
            <h2>{prospect.company.name}</h2>
            <p>
              {prospect.company.website ? (
                <span className="modal-website">
                  <Globe2 size={12} />
                  {prospect.company.website.replace(/^https?:\/\//, "")}
                </span>
              ) : (
                "Company account qualification breakdown"
              )}
            </p>
          </div>
          <button
            type="button"
            className="icon-button modal-close"
            aria-label="Close modal"
            onClick={onClose}
          >
            <X size={17} />
          </button>
        </header>

        {/* Body */}
        <div className="score-modal-body">
          {loading && (
            <div className="score-modal-loading">
              <LoaderCircle size={24} className="spin" />
              <span>Loading score intelligence...</span>
            </div>
          )}

          {!loading && error && (
            <div className="inline-alert">
              <AlertCircle size={15} />
              <span>{error}</span>
            </div>
          )}

          {!loading && !error && !scoreData && (
            <div className="score-empty-state">
              <div className="state-icon">
                <Sparkles size={20} />
              </div>
              <h3>Prospect has not been scored yet</h3>
              <p>
                Run the deterministic ICP scorer to evaluate revenue fit, industry,
                platform, geography, company size, and growth signals.
              </p>
              <button
                type="button"
                className="button button-primary"
                onClick={handleScoreAndReload}
                disabled={isScoring}
              >
                {isScoring ? <LoaderCircle size={14} className="spin" /> : <Sparkles size={14} />}
                Run ICP Score
              </button>
            </div>
          )}

          {!loading && !error && scoreData && (
            <>
              {/* Overall Summary Card */}
              <div className="score-summary-banner">
                <div className="summary-score-badge">
                  {scoreData.total_score !== null ? (
                    <div className="score-number-wrap">
                      <span className="score-number">{Math.round(scoreData.total_score)}</span>
                      <span className="score-out-of">/ 100</span>
                    </div>
                  ) : (
                    <span className="score-insufficient-badge">Insufficient data</span>
                  )}
                  <span className={`priority-pill priority-${scoreData.priority}`}>
                    {scoreData.priority.replace("_", " ")} priority
                  </span>
                </div>

                <div className="summary-meta-grid">
                  <div className="summary-meta-item">
                    <span className="summary-label">
                      <Percent size={12} /> Coverage
                    </span>
                    <strong>{scoreData.coverage}% evidence</strong>
                  </div>
                  <div className="summary-meta-item">
                    <span className="summary-label">
                      <Layers size={12} /> Scorer Version
                    </span>
                    <code>{scoreData.score_version}</code>
                  </div>
                  <div className="summary-meta-item">
                    <span className="summary-label">
                      <Clock size={12} /> Scored At
                    </span>
                    <span>
                      {new Intl.DateTimeFormat("en", {
                        month: "short",
                        day: "numeric",
                        year: "numeric",
                        hour: "2-digit",
                        minute: "2-digit",
                      }).format(new Date(scoreData.scored_at))}
                    </span>
                  </div>
                </div>
              </div>

              {/* Six Factors Grid */}
              <div className="score-section-heading">
                <h3>ICP Factor Breakdown</h3>
                <span>Six deterministic evaluation criteria</span>
              </div>

              <div className="factors-grid">
                {sortedFactors.map((factor) => {
                  const title = FACTOR_TITLES[factor.factor_key] ?? factor.factor_key;
                  return (
                    <div key={factor.id || factor.factor_key} className={`factor-card status-${factor.status}`}>
                      <div className="factor-header">
                        <div className="factor-name-row">
                          <span className="factor-title">{title}</span>
                          <span className={`factor-status-pill status-${factor.status}`}>
                            {factor.status}
                          </span>
                        </div>
                        <div className="factor-score-pill">
                          {factor.score !== null ? (
                            <strong>
                              {factor.score}
                              <span>/{factor.max_score}</span>
                            </strong>
                          ) : (
                            <span className="muted">—/{factor.max_score}</span>
                          )}
                        </div>
                      </div>
                      <p className="factor-reason">{factor.reason}</p>
                    </div>
                  );
                })}
              </div>

              {/* Score History Section */}
              <div className="score-section-heading score-history-heading">
                <h3>
                  <History size={14} /> Score History
                </h3>
                <span>{history.length} scoring run{history.length === 1 ? "" : "s"} recorded</span>
              </div>

              {history.length === 0 ? (
                <p className="muted history-empty">No previous scoring history recorded.</p>
              ) : (
                <div className="history-table-wrap">
                  <table className="history-table">
                    <thead>
                      <tr>
                        <th>Scored At</th>
                        <th>Score</th>
                        <th>Priority</th>
                        <th>Coverage</th>
                        <th>Version</th>
                      </tr>
                    </thead>
                    <tbody>
                      {history.map((item, index) => (
                        <tr key={item.run_id} className={index === 0 ? "history-current-row" : ""}>
                          <td>
                            {new Intl.DateTimeFormat("en", {
                              month: "short",
                              day: "numeric",
                              year: "numeric",
                              hour: "2-digit",
                              minute: "2-digit",
                            }).format(new Date(item.scored_at))}
                            {index === 0 && <span className="history-current-tag">current</span>}
                          </td>
                          <td>
                            <strong>
                              {item.total_score !== null ? `${Math.round(item.total_score)}/100` : "Insufficient data"}
                            </strong>
                          </td>
                          <td>
                            <span className={`priority-pill small priority-${item.priority}`}>
                              {item.priority.replace("_", " ")}
                            </span>
                          </td>
                          <td>{item.coverage}%</td>
                          <td>
                            <code>{item.score_version}</code>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </>
          )}
        </div>

        {/* Footer */}
        <footer className="modal-footer">
          <span>
            Run ID: {scoreData?.score_run_id ? <code>{scoreData.score_run_id.slice(0, 8)}...</code> : "None"}
          </span>
          <div className="modal-footer-actions">
            <button
              type="button"
              className="button button-secondary button-small"
              onClick={onClose}
            >
              Close
            </button>
            <button
              type="button"
              className="button button-primary button-small"
              onClick={handleScoreAndReload}
              disabled={isScoring}
              title="Recalculate deterministic score and record a new run"
            >
              {isScoring ? <LoaderCircle size={13} className="spin" /> : <Sparkles size={13} />}
              {scoreData ? "Re-score Prospect" : "Score Prospect"}
            </button>
          </div>
        </footer>
      </div>
    </div>
  );
}
