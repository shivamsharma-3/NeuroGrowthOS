"use client";

import Papa from "papaparse";
import { AlertCircle, Check, FileSpreadsheet, LoaderCircle, Upload, X } from "lucide-react";
import { useRef, useState } from "react";
import type { CsvRow, ProspectInput } from "@/types/prospects";

interface Props { onClose: () => void; onImport: (rows: { line: number; input: ProspectInput }[]) => Promise<{ imported: number; duplicates: number; errors: { row: number; error: string }[] }>; }
interface PreviewRow { line: number; input: ProspectInput | null; error?: string; }

function toInput(row: CsvRow): ProspectInput {
  const numeric = (value: string, label: string, integer = false): number | null => {
    if (!value?.trim()) return null;
    const parsed = Number(value.replace(/[$,]/g, ""));
    if (!Number.isFinite(parsed) || parsed < 0 || (integer && !Number.isInteger(parsed))) throw new Error(`${label} must be a non-negative ${integer ? "whole number" : "amount"}.`);
    return parsed;
  };
  const companyName = row.company_name?.trim();
  if (!companyName) throw new Error("Company name is required.");
  const email = row.email?.trim() || null;
  if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new Error("Contact email is invalid.");
  return {
    company: {
      name: companyName, website: row.website?.trim() || null, domain: null,
      industry: row.industry?.trim() || null, country: row.country?.trim() || null,
      revenue_amount: numeric(row.revenue_amount, "Revenue amount"), revenue_currency: row.revenue_currency?.trim().toUpperCase() || null,
      revenue_period: (row.revenue_period?.trim() || null) as ProspectInput["company"]["revenue_period"], revenue_source: row.revenue_source?.trim() || "csv_import",
      revenue_observed_at: row.revenue_observed_at?.trim() || null,
      estimated_revenue: numeric(row.estimated_revenue, "Revenue"), employee_count: numeric(row.employee_count, "Employee count", true),
      platform: row.platform?.trim() || null, linkedin_url: row.linkedin_url?.trim() || null,
    },
    contact: {
      first_name: row.first_name?.trim() || null, last_name: row.last_name?.trim() || null,
      email, job_title: row.job_title?.trim() || null, linkedin_url: row.contact_linkedin_url?.trim() || null,
    },
    source: "csv_import",
  };
}

export function CsvImport({ onClose, onImport }: Props) {
  const fileRef = useRef<HTMLInputElement>(null);
  const [rows, setRows] = useState<PreviewRow[] | null>(null);
  const [fileName, setFileName] = useState("");
  const [busy, setBusy] = useState(false);
  const [report, setReport] = useState<{ imported: number; duplicates: number; errors: { row: number; error: string }[] } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const validRows = rows?.filter((item): item is PreviewRow & { input: ProspectInput } => item.input !== null) ?? [];
  const invalidRows = rows?.filter((item) => item.input === null) ?? [];

  function selectFile(file?: File) {
    if (!file) return;
    setError(null); setReport(null); setRows(null);
    if (!file.name.toLowerCase().endsWith(".csv")) { setError("Choose a .csv file to continue."); return; }
    setFileName(file.name);
    Papa.parse<CsvRow>(file, {
      header: true, skipEmptyLines: "greedy", transformHeader: (header) => header.trim().toLowerCase(),
      complete: (result) => {
        if (result.errors.length) setError(`${result.errors.length} CSV formatting issue${result.errors.length === 1 ? "" : "s"} found. Review the valid rows below.`);
        const previews = result.data.map((row, index): PreviewRow => {
          try { return { line: index + 2, input: toInput(row) }; }
          catch (rowError) { return { line: index + 2, input: null, error: rowError instanceof Error ? rowError.message : "Invalid row." }; }
        });
        setRows(previews);
        if (!result.meta.fields?.some((field) => field.toLowerCase() === "company_name")) setError("The CSV must include a company_name column.");
      },
      error: (parseError) => setError(parseError.message),
    });
  }

  async function importRows() {
    if (!validRows.length) return;
    setBusy(true); setError(null);
    try { setReport(await onImport(validRows.map(({ line, input }) => ({ line, input })))); }
    catch (importError) { setError(importError instanceof Error ? importError.message : "Could not import this file."); }
    finally { setBusy(false); }
  }

  return (
    <div className="modal-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget && !busy) onClose(); }}>
      <section role="dialog" aria-modal="true" aria-labelledby="csv-title" className="modal-card import-modal">
        <header className="modal-header"><div><span className="eyebrow">BULK ADD</span><h2 id="csv-title">Import prospects</h2><p>Upload a CSV, review your data, then import valid rows.</p></div><button className="icon-button modal-close" type="button" onClick={onClose} aria-label="Close dialog" disabled={busy}><X size={18} /></button></header>
        {!report && <div className="import-content">
          <input ref={fileRef} type="file" accept=".csv,text/csv" className="sr-only" onChange={(event) => selectFile(event.target.files?.[0])} />
          <button type="button" className={`upload-zone ${rows ? "has-file" : ""}`} onClick={() => fileRef.current?.click()}>
            {rows ? <FileSpreadsheet size={21} /> : <Upload size={21} />}
            <span className="upload-main">{fileName || "Choose a CSV file"}</span><span className="upload-help">{rows ? "Click to choose a different file" : "CSV format · Up to 500 rows per import"}</span>
          </button>
          <div className="csv-columns"><span>Required column</span><code>company_name</code><span>Supported columns</span><p>website, industry, country, revenue_amount, revenue_currency, revenue_period, employee_count, platform, linkedin_url, first_name, last_name, email, job_title, contact_linkedin_url</p><small>Legacy estimated_revenue is retained for display only; scoring requires explicit revenue currency and period.</small></div>
          {error && <div className="inline-alert" role="alert"><AlertCircle size={15} />{error}</div>}
        {rows && <><div className="preview-heading"><div><h3>Preview</h3><span>{validRows.length} valid · {invalidRows.length} invalid</span></div>{rows.length > 500 ? <span className="invalid-note"><AlertCircle size={14} /> Split files into batches of 500 rows</span> : invalidRows.length > 0 && <span className="invalid-note"><AlertCircle size={14} /> Invalid rows will be skipped</span>}</div>
            <div className="preview-table-wrap"><table className="preview-table"><thead><tr><th>Row</th><th>Company</th><th>Website</th><th>Industry</th><th>Contact email</th><th>Validation</th></tr></thead><tbody>
              {rows.slice(0, 50).map((row) => <tr key={row.line} className={row.error ? "invalid-row" : ""}><td>{row.line}</td><td>{row.input?.company.name ?? "—"}</td><td>{row.input?.company.website ?? "—"}</td><td>{row.input?.company.industry ?? "—"}</td><td>{row.input?.contact?.email ?? "—"}</td><td>{row.error ? <span className="validation-error" title={row.error}><AlertCircle size={13} />{row.error}</span> : <span className="validation-ok"><Check size={13} />Ready</span>}</td></tr>)}
            </tbody></table></div>{rows.length > 50 && <p className="preview-truncated">Showing first 50 of {rows.length} rows.</p>}</>}
        </div>}
        {report && <div className="import-report"><div className="report-icon"><Check size={20} /></div><h3>Import complete</h3><p>Your CSV has been processed.</p><div className="report-stats"><div><strong>{report.imported}</strong><span>Imported</span></div><div><strong>{report.duplicates}</strong><span>Duplicate domains skipped</span></div><div><strong>{invalidRows.length + report.errors.length}</strong><span>Invalid / failed</span></div></div>
          {(invalidRows.length + report.errors.length > 0) && <div className="report-errors"><h4>Rows to review</h4>{[...invalidRows.map((item) => ({ row: item.line, error: item.error ?? "Invalid row" })), ...report.errors].slice(0, 12).map((item, index) => <span key={`${item.row}-${index}`}>Row {item.row}: {item.error}</span>)}</div>}
        </div>}
        <footer className="modal-footer"><span>{rows ? "Duplicates are skipped by company domain." : "A preview is shown before any data is saved."}</span><div>{report ? <button type="button" className="button button-primary" onClick={onClose}>Done</button> : <><button type="button" className="button button-secondary" onClick={onClose} disabled={busy}>Cancel</button><button type="button" className="button button-primary" disabled={!validRows.length || validRows.length > 500 || busy} onClick={importRows}>{busy && <LoaderCircle size={15} className="spin" />}{busy ? "Importing…" : `Import ${validRows.length} row${validRows.length === 1 ? "" : "s"}`}</button></>}</div></footer>
      </section>
    </div>
  );
}
