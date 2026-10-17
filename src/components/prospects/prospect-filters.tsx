"use client";

import { Search, SlidersHorizontal, X } from "lucide-react";
import { PROSPECT_STATUSES, type ProspectStatus } from "@/types/prospects";

interface Props {
  search: string;
  onSearchChange: (value: string) => void;
  status: string;
  onStatusChange: (value: string) => void;
  industry: string;
  onIndustryChange: (value: string) => void;
  score: string;
  onScoreChange: (value: string) => void;
  industries: string[];
  resultCount: number;
}

const statusLabels: Record<ProspectStatus, string> = {
  new: "New", researching: "Researching", qualified: "Qualified", contacted: "Contacted",
  in_progress: "In progress", converted: "Converted", disqualified: "Disqualified",
};

export function ProspectFilters(props: Props) {
  const active = props.search || props.status || props.industry || props.score;
  const clear = () => {
    props.onSearchChange(""); props.onStatusChange(""); props.onIndustryChange(""); props.onScoreChange("");
  };

  return (
    <section className="filters-card" aria-label="Prospect filters">
      <label className="search-field">
        <Search size={16} aria-hidden="true" />
        <span className="sr-only">Search prospects</span>
        <input value={props.search} onChange={(event) => props.onSearchChange(event.target.value)} placeholder="Search companies, contacts, or domains" />
        {props.search && <button type="button" className="icon-button clear-search" onClick={() => props.onSearchChange("")} aria-label="Clear search"><X size={14} /></button>}
      </label>
      <div className="filter-divider" />
      <span className="filter-caption"><SlidersHorizontal size={14} /> Filters</span>
      <label className="sr-only" htmlFor="status-filter">Filter by status</label>
      <select id="status-filter" value={props.status} onChange={(event) => props.onStatusChange(event.target.value)}>
        <option value="">All statuses</option>
        {PROSPECT_STATUSES.map((item) => <option key={item} value={item}>{statusLabels[item]}</option>)}
      </select>
      <label className="sr-only" htmlFor="industry-filter">Filter by industry</label>
      <select id="industry-filter" value={props.industry} onChange={(event) => props.onIndustryChange(event.target.value)}>
        <option value="">All industries</option>
        {props.industries.map((item) => <option key={item} value={item}>{item}</option>)}
      </select>
      <label className="sr-only" htmlFor="score-filter">Filter by ICP score</label>
      <select id="score-filter" value={props.score} onChange={(event) => props.onScoreChange(event.target.value)}>
        <option value="">Any ICP score</option>
        <option value="scored">Scored only</option>
        <option value="high">High priority · 80+</option>
        <option value="medium">Medium priority · 60–79</option>
        <option value="low">Low priority · under 60</option>
        <option value="insufficient">Insufficient data</option>
      </select>
      <span className="result-count">{props.resultCount} results</span>
      {active && <button type="button" className="text-button clear-filters" onClick={clear}>Clear filters</button>}
    </section>
  );
}
