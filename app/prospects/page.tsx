"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { usePathname, useRouter } from "next/navigation";
import { Activity, ArrowDownUp, BarChart3, BriefcaseBusiness, Building2, ChevronLeft, ChevronRight, CircleHelp, LayoutDashboard, ListFilter, Menu, Plus, Search, Send, Settings2, Sparkles, Upload, Users, X } from "lucide-react";
import { CsvImport } from "@/components/prospects/csv-import";
import { ProspectFilters } from "@/components/prospects/prospect-filters";
import { ProspectForm } from "@/components/prospects/prospect-form";
import { ProspectsTable } from "@/components/prospects/prospects-table";
import { ScoreDetailsModal } from "@/components/prospects/score-details-modal";
import { requestProspectResearch, type ProspectResearchResult } from "@/lib/prospects/research-action";
import type { Prospect, ProspectInput } from "@/types/prospects";

const PAGE_SIZE = 10;
class ProspectApiError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
    this.name = "ProspectApiError";
  }
}

async function fetchProspectList(): Promise<Prospect[]> {
  const response = await fetch("/api/prospects", { cache: "no-store" });
  const payload = await response.json().catch(() => null) as { prospects?: Prospect[]; error?: string } | null;
  if (!response.ok) throw new ProspectApiError(response.status, payload?.error || "Could not load prospects.");
  return payload?.prospects ?? [];
}

const navigation = [
  { label: "Overview", href: "/dashboard", icon: LayoutDashboard },
  { label: "Prospects", href: "/prospects", icon: Building2 },
  { label: "Research", href: "/research", icon: Search },
  { label: "Audits", href: "/audits", icon: ListFilter },
  { label: "Outreach", href: "/campaigns", icon: Send },
  { label: "Pipeline", href: "/pipeline", icon: BriefcaseBusiness },
  { label: "Analytics", href: "/analytics", icon: BarChart3 },
];

export default function ProspectsPage() {
  const pathname = usePathname();
  const router = useRouter();
  const [prospects, setProspects] = useState<Prospect[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [search, setSearch] = useState("");
  const [status, setStatus] = useState("");
  const [industry, setIndustry] = useState("");
  const [score, setScore] = useState("");
  const [page, setPage] = useState(1);
  const [showForm, setShowForm] = useState(false);
  const [showImport, setShowImport] = useState(false);
  const [selectedProspect, setSelectedProspect] = useState<Prospect | null>(null);
  const [toast, setToast] = useState<string | null>(null);
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [scoringId, setScoringId] = useState<string | null>(null);
  const [researchingId, setResearchingId] = useState<string | null>(null);
  const [researchResults, setResearchResults] = useState<Record<string, ProspectResearchResult>>({});

  const loadProspects = useCallback(async () => {
    try {
      setProspects(await fetchProspectList());
    } catch (loadError) {
      if (loadError instanceof ProspectApiError && loadError.status === 401) {
        router.replace("/login");
        return;
      }
      setError(loadError instanceof Error ? loadError.message : "Could not load prospects.");
    } finally { setLoading(false); }
  }, [router]);

  useEffect(() => {
    let active = true;
    void fetchProspectList()
      .then((items) => { if (active) setProspects(items); })
      .catch((loadError: unknown) => {
        if (!active) return;
        if (loadError instanceof ProspectApiError && loadError.status === 401) {
          router.replace("/login");
          return;
        }
        setError(loadError instanceof Error ? loadError.message : "Could not load prospects.");
      })
      .finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [router]);
  useEffect(() => { if (!toast) return; const timeout = window.setTimeout(() => setToast(null), 4500); return () => window.clearTimeout(timeout); }, [toast]);

  const industries = useMemo(() => [...new Set(prospects.map((item) => item.company.industry).filter((value): value is string => Boolean(value)))].sort(), [prospects]);
  const filtered = useMemo(() => {
    const query = search.trim().toLowerCase();
    return prospects.filter((item) => {
      const matchesQuery = !query || [item.company.name, item.company.domain, item.company.website, item.company.industry, item.contact?.first_name, item.contact?.last_name, item.contact?.email].some((value) => value?.toLowerCase().includes(query));
      const matchesStatus = !status || item.status === status;
      const matchesIndustry = !industry || item.company.industry === industry;
      const matchesScore = !score || (score === "insufficient" ? item.icp_scoring_status === "insufficient_data" : score === "high" ? item.icp_score !== null && item.icp_score >= 80 : score === "medium" ? item.icp_score !== null && item.icp_score >= 60 && item.icp_score < 80 : score === "low" ? item.icp_score !== null && item.icp_score < 60 : score === "scored" ? item.icp_score !== null : item.icp_score !== null && item.icp_score >= Number(score));
      return matchesQuery && matchesStatus && matchesIndustry && matchesScore;
    });
  }, [prospects, search, status, industry, score]);

  const totalPages = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE));
  const currentPage = Math.min(page, totalPages);
  const visibleProspects = filtered.slice((currentPage - 1) * PAGE_SIZE, currentPage * PAGE_SIZE);
  const retryProspects = () => { setLoading(true); setError(null); void loadProspects(); };

  async function createProspect(input: ProspectInput) {
    const response = await fetch("/api/prospects", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(input) });
    const payload = await response.json();
    if (!response.ok) throw new Error(payload.error || "Could not save this prospect.");
    setShowForm(false); setToast("Prospect added successfully."); setLoading(true); setError(null); await loadProspects();
  }

  async function importProspects(rows: { line: number; input: ProspectInput }[]) {
    const response = await fetch("/api/prospects/import", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(rows) });
    const payload = await response.json();
    if (!response.ok) throw new Error(payload.error || "Could not import this CSV.");
    setLoading(true); setError(null); await loadProspects();
    return payload as { imported: number; duplicates: number; errors: { row: number; error: string }[] };
  }

  async function scoreProspect(id: string) {
    setScoringId(id);
    try {
      const response = await fetch(`/api/prospects/${id}/score`, { method: "POST" });
      const payload = await response.json();
      if (!response.ok) throw new Error(payload.error || "Could not score this prospect.");
      setToast(payload.result.totalScore === null ? `Score saved · insufficient data (${payload.result.coverage.percent}% coverage).` : `ICP score saved · ${Math.round(payload.result.totalScore)}/100 (${payload.result.priority}).`);
      setError(null); await loadProspects();
    } catch (scoreError) {
      setToast(scoreError instanceof Error ? scoreError.message : "Could not score this prospect.");
    } finally { setScoringId(null); }
  }

  async function researchProspect(id: string) {
    setResearchingId(id);
    try {
      const result = await requestProspectResearch(id);
      setResearchResults((current) => ({ ...current, [id]: result }));
      setToast(`Research ${result.status} · run ${result.researchRunId}`);
    } catch (researchError) {
      setToast(researchError instanceof Error ? researchError.message : "Research could not be completed. Try again.");
    } finally {
      setResearchingId(null);
    }
  }

  const scored = prospects.filter((item) => item.icp_score !== null).length;
  return (
    <div className="app-shell">
      {sidebarOpen && <button className="mobile-scrim" type="button" aria-label="Close navigation" onClick={() => setSidebarOpen(false)} />}
      <aside className={`sidebar ${sidebarOpen ? "sidebar-open" : ""}`}>
        <div className="brand-lockup"><div className="brand-mark"><Sparkles size={17} strokeWidth={2.2} /></div><span>growth<span className="brand-highlight">os</span></span><span className="brand-ai">AI</span><button className="icon-button mobile-sidebar-close" type="button" aria-label="Close menu" onClick={() => setSidebarOpen(false)}><X size={17} /></button></div>
        <div className="workspace-label">WORKSPACE <span>GROWTH TEAM</span></div>
        <nav className="main-nav" aria-label="Main navigation">{navigation.map(({ label, href, icon: Icon }) => pathname === href ? <a key={href} href={href} onClick={() => setSidebarOpen(false)} className="nav-link nav-active" aria-current="page"><Icon size={17} strokeWidth={1.8} /><span>{label}</span><span className="nav-count">{prospects.length}</span></a> : <button key={href} type="button" className="nav-link nav-disabled" disabled title="Coming in a future phase"><Icon size={17} strokeWidth={1.8} /><span>{label}</span><span className="nav-soon">Soon</span></button>)}</nav>
        <div className="sidebar-bottom"><div className="sidebar-tip"><div><Sparkles size={15} /><span>Growth intelligence</span></div><p>Find your next growth opportunity with a sharper view of every account.</p><span className="tip-coming-soon">Audit workflows are coming soon <ChevronRight size={13} /></span></div><button type="button" className="nav-link nav-disabled settings-link" disabled title="Coming in a future phase"><Settings2 size={17} /><span>Settings</span><span className="nav-soon">Soon</span></button><div className="profile-row"><div className="profile-avatar">GT</div><div className="profile-info"><strong>Growth team</strong><span>Workspace member</span></div><button type="button" className="icon-button profile-menu" aria-label="Profile options"><Menu size={17} /></button></div></div>
      </aside>

      <main className="main-area">
        <header className="topbar"><button type="button" className="icon-button mobile-menu" aria-label="Open navigation" onClick={() => setSidebarOpen(true)}><Menu size={19} /></button><div className="breadcrumbs"><span>Workspace</span><span className="crumb-slash">/</span><strong>Prospects</strong></div><div className="topbar-actions"><span className="sync-indicator"><i />Live data</span><button type="button" className="icon-button help-button" aria-label="Help"><CircleHelp size={17} /></button><div className="top-avatar">SG</div></div></header>
        <div className="content-wrap">
          <div className="page-heading"><div><div className="heading-kicker"><span className="kicker-line" />GROWTH INTELLIGENCE</div><h1>Prospects</h1><p>Discover, organize, and qualify the companies you want to grow.</p></div><div className="heading-actions"><button type="button" className="button button-secondary" onClick={() => setShowImport(true)}><Upload size={15} />Import CSV</button><button type="button" className="button button-primary" onClick={() => setShowForm(true)}><Plus size={16} />Add prospect</button></div></div>

          <section className="overview-strip" aria-label="Prospect summary"><div className="overview-item"><span className="overview-icon"><Building2 size={16} /></span><div><strong>{loading ? "—" : prospects.length.toLocaleString()}</strong><span>Total prospects</span></div></div><div className="overview-divider" /><div className="overview-item"><span className="overview-icon teal"><Users size={16} /></span><div><strong>{loading ? "—" : prospects.filter((item) => item.contact_id).length.toLocaleString()}</strong><span>With contacts</span></div></div><div className="overview-divider" /><div className="overview-item"><span className="overview-icon violet"><ArrowDownUp size={16} /></span><div><strong>{loading ? "—" : scored.toLocaleString()}</strong><span>ICP scored</span></div></div><div className="overview-side-note"><Activity size={14} /><span>Deterministic profile · ecom-d2c-v1.0.0</span></div></section>

          <div className="section-title-row"><div><h2>All prospects</h2><p>Manage your target companies and key contacts.</p></div><button type="button" className="view-settings" aria-label="Table display options"><Settings2 size={15} /></button></div>
          <ProspectFilters search={search} onSearchChange={(value) => { setPage(1); setSearch(value); }} status={status} onStatusChange={(value) => { setPage(1); setStatus(value); }} industry={industry} onIndustryChange={(value) => { setPage(1); setIndustry(value); }} score={score} onScoreChange={(value) => { setPage(1); setScore(value); }} industries={industries} resultCount={filtered.length} />
          <ProspectsTable prospects={visibleProspects} loading={loading} error={error} onRetry={retryProspects} onAdd={() => setShowForm(true)} scoringId={scoringId} onScore={(id) => void scoreProspect(id)} onInspectScore={(p) => setSelectedProspect(p)} researchingId={researchingId} researchResults={researchResults} onResearch={(id) => void researchProspect(id)} />
          {!loading && !error && filtered.length > 0 && <div className="pagination"><span>Showing <strong>{(currentPage - 1) * PAGE_SIZE + 1}–{Math.min(currentPage * PAGE_SIZE, filtered.length)}</strong> of <strong>{filtered.length}</strong></span><div className="pagination-controls"><button type="button" aria-label="Previous page" disabled={currentPage <= 1} onClick={() => setPage((value) => Math.max(1, value - 1))}><ChevronLeft size={15} /></button><span>Page <strong>{currentPage}</strong> of <strong>{totalPages}</strong></span><button type="button" aria-label="Next page" disabled={currentPage >= totalPages} onClick={() => setPage((value) => Math.min(totalPages, value + 1))}><ChevronRight size={15} /></button></div></div>}
          <footer className="page-footer"><span>GrowthOS AI <span>·</span> Prospect intelligence</span><span>Built for growth teams <Sparkles size={12} /></span></footer>
        </div>
      </main>
      {showForm && <ProspectForm onClose={() => setShowForm(false)} onSubmit={createProspect} />}
      {showImport && <CsvImport onClose={() => setShowImport(false)} onImport={importProspects} />}
      {selectedProspect && <ScoreDetailsModal prospect={selectedProspect} onClose={() => setSelectedProspect(null)} onScore={scoreProspect} scoringId={scoringId} />}
      {toast && <div className="toast-message" role="status"><span><Plus size={14} /></span>{toast}<button type="button" className="icon-button" aria-label="Dismiss notification" onClick={() => setToast(null)}><X size={14} /></button></div>}
    </div>
  );
}
