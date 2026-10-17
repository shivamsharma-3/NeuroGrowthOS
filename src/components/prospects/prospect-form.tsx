"use client";

import { useState, type FormEvent } from "react";
import { LoaderCircle, X } from "lucide-react";
import type { ProspectInput } from "@/types/prospects";

interface Props { onClose: () => void; onSubmit: (input: ProspectInput) => Promise<void>; }

function clean(value: FormDataEntryValue | null) { return typeof value === "string" && value.trim() ? value.trim() : null; }
function numberValue(value: FormDataEntryValue | null) {
  if (typeof value !== "string" || !value.trim()) return null;
  const number = Number(value.replace(/[$,]/g, ""));
  return Number.isFinite(number) && number >= 0 ? number : NaN;
}

export function ProspectForm({ onClose, onSubmit }: Props) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); setError(null);
    const data = new FormData(event.currentTarget);
    const revenue = numberValue(data.get("estimated_revenue"));
    const revenueAmount = numberValue(data.get("revenue_amount"));
    const employees = numberValue(data.get("employee_count"));
    if (Number.isNaN(revenue) || Number.isNaN(revenueAmount) || Number.isNaN(employees) || (employees !== null && !Number.isInteger(employees))) {
      setError("Enter a valid non-negative amount and whole employee count."); return;
    }
    const input: ProspectInput = {
      company: {
        name: String(data.get("company_name") ?? "").trim(),
        website: clean(data.get("website")), domain: null,
        industry: clean(data.get("industry")), country: clean(data.get("country")),
        revenue_amount: revenueAmount, revenue_currency: clean(data.get("revenue_currency"))?.toUpperCase() ?? null,
        revenue_period: (clean(data.get("revenue_period")) as ProspectInput["company"]["revenue_period"]) ?? null,
        revenue_source: "manual", revenue_observed_at: null,
        estimated_revenue: revenue, employee_count: employees,
        platform: clean(data.get("platform")), linkedin_url: clean(data.get("linkedin_url")),
      },
      contact: {
        first_name: clean(data.get("first_name")), last_name: clean(data.get("last_name")),
        email: clean(data.get("email")), job_title: clean(data.get("job_title")),
        linkedin_url: clean(data.get("contact_linkedin_url")),
      },
      source: "manual",
    };
    setBusy(true);
    try { await onSubmit(input); }
    catch (submitError) { setError(submitError instanceof Error ? submitError.message : "Could not save this prospect."); }
    finally { setBusy(false); }
  }

  return (
    <div className="modal-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget && !busy) onClose(); }}>
      <section role="dialog" aria-modal="true" aria-labelledby="prospect-form-title" className="modal-card form-modal">
        <header className="modal-header"><div><span className="eyebrow">PROSPECT DATABASE</span><h2 id="prospect-form-title">Add prospect</h2><p>Add a company and an optional point of contact.</p></div><button className="icon-button modal-close" type="button" onClick={onClose} aria-label="Close dialog" disabled={busy}><X size={18} /></button></header>
        <form onSubmit={submit}>
          <div className="form-scroll"><div className="form-section"><div className="form-section-heading"><span className="step-number">01</span><div><h3>Company</h3><p>Company details help your team qualify the account.</p></div></div>
            <div className="form-grid"><label className="field full"><span>Company name <b>*</b></span><input name="company_name" required maxLength={200} placeholder="e.g. Acme Commerce" autoFocus /></label>
              <label className="field"><span>Website</span><input name="website" type="text" placeholder="https://acme.com" /></label><label className="field"><span>Industry</span><input name="industry" placeholder="e.g. E-commerce" /></label>
              <label className="field"><span>Country</span><input name="country" placeholder="e.g. United States" /></label><label className="field"><span>Legacy estimated revenue</span><input name="estimated_revenue" type="number" min="0" step="1000" placeholder="Not used for scoring" /></label>
              <label className="field"><span>Revenue amount</span><input name="revenue_amount" type="number" min="0" step="1000" placeholder="2500000" /></label><label className="field"><span>Currency</span><select name="revenue_currency" defaultValue=""><option value="">Select currency</option>{["USD", "EUR", "GBP", "INR", "CAD", "AUD", "JPY", "SGD"].map((currency) => <option key={currency}>{currency}</option>)}</select></label>
              <label className="field"><span>Reporting period</span><select name="revenue_period" defaultValue=""><option value="">Select period</option><option value="annual">Annual</option><option value="quarterly">Quarterly</option><option value="monthly">Monthly</option><option value="lifetime">Lifetime</option><option value="unknown">Unknown</option></select></label>
              <label className="field"><span>Employee count</span><input name="employee_count" type="number" min="0" step="1" placeholder="50" /></label><label className="field"><span>Platform</span><input name="platform" placeholder="e.g. Shopify Plus" /></label>
              <label className="field full"><span>Company LinkedIn URL</span><input name="linkedin_url" type="url" placeholder="https://linkedin.com/company/acme" /></label>
            </div>
          </div>
          <div className="form-section"><div className="form-section-heading"><span className="step-number">02</span><div><h3>Contact <span className="optional-tag">OPTIONAL</span></h3><p>Add a decision-maker to personalize future outreach.</p></div></div>
            <div className="form-grid"><label className="field"><span>First name</span><input name="first_name" placeholder="Jordan" /></label><label className="field"><span>Last name</span><input name="last_name" placeholder="Lee" /></label>
              <label className="field"><span>Work email</span><input name="email" type="email" placeholder="jordan@acme.com" /></label><label className="field"><span>Job title</span><input name="job_title" placeholder="VP of Growth" /></label>
              <label className="field full"><span>Contact LinkedIn URL</span><input name="contact_linkedin_url" type="url" placeholder="https://linkedin.com/in/jordanlee" /></label>
            </div>
          </div>
          </div>
          {error && <div className="inline-alert" role="alert">{error}</div>}
          <footer className="form-footer"><span><b>*</b> Required field</span><div><button type="button" className="button button-secondary" onClick={onClose} disabled={busy}>Cancel</button><button type="submit" className="button button-primary" disabled={busy}>{busy && <LoaderCircle size={15} className="spin" />}{busy ? "Saving…" : "Save prospect"}</button></div></footer>
        </form>
      </section>
    </div>
  );
}
