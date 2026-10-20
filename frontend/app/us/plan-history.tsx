"use client";
import { useEffect, useRef, useState } from "react";
import { loadUSPlanRevision, type USPlan } from "../lib/us-plans";
import { usd } from "../lib/us-research";

export default function PlanHistory({ plan }: { plan: USPlan }) {
  const [record, setRecord] = useState(plan);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const request = useRef(0);
  useEffect(() => () => { request.current++; }, []);
  async function open(revision: number) {
    const version = ++request.current;
    setLoading(true);setError("");
    try {
      const saved = await loadUSPlanRevision(plan, revision);
      if (version === request.current) setRecord(saved);
    } catch {
      if (version === request.current) setError("Saved revision could not be verified. The displayed revision and current draft are unchanged.");
    } finally {
      if (version === request.current) setLoading(false);
    }
  }
  return <section className="space-y-2 rounded-lg border border-card-border p-3" aria-label={`Saved revision history for ${plan.symbol}`}>
    <h3>Review your saved thesis · {plan.symbol}</h3>
    <p>Read-only revision {record.revision} of {plan.revision}. Browsing history does not replace the editor or save a change.</p>
    <div className="flex gap-2">
      <button type="button" className="workspace-button" disabled={loading || record.revision <= 1} onClick={() => void open(record.revision - 1)}>Older revision</button>
      <button type="button" className="workspace-button" disabled={loading || record.revision >= plan.revision} onClick={() => void open(record.revision + 1)}>Newer revision</button>
    </div>
    {loading && <p role="status">Verifying saved revision and original source…</p>}
    {error && <p role="alert">{error}</p>}
    <dl><dt>Saved at</dt><dd>{new Date(record.updated_at).toLocaleString("en-US", { timeZone: "America/New_York" })} ET</dd>
      <dt>State / source session</dt><dd>{record.state} · {record.session}</dd>
      <dt>Trigger / stop</dt><dd>{usd(record.trigger)} / {usd(record.stop)}</dd>
      <dt>Expiry</dt><dd>{record.expiry} (ET)</dd>
      <dt>Thesis notes</dt><dd className="whitespace-pre-wrap">{record.notes || "No notes saved."}</dd>
      <dt>Exit policy</dt><dd className="whitespace-pre-wrap">{record.exit_policy}</dd></dl>
    <p>Original package {record.package_id} · setup {record.setup_version}</p>
    <p>Research revisions only. No trigger, fill, return or strategy outcome is inferred.</p>
  </section>;
}
