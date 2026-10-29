"use client";
import { useEffect, useRef, useState } from "react";
import { fetchAPI, postAPI } from "../lib/api";

import { validateRefreshHistory, type RefreshJob as Job } from "../lib/us-refresh-status";

export default function RefreshHistory({ onOpen, revision }: { onOpen: (id: string) => void; revision: string }) {
  const [jobs, setJobs] = useState<Job[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [retry, setRetry] = useState(0);
  const [canInterrupt, setCanInterrupt] = useState(false);
  const [pending, setPending] = useState("");
  const [confirm, setConfirm] = useState("");
  const lifecycle = useRef({ generation: 0, active: true, busy: false });
  useEffect(() => {
    const current = lifecycle.current;
    current.generation += 1;
    current.active = true;
    let active = true;
    setLoading(true);
    setError("");
    fetchAPI<{ jobs: Job[]; interruption_available?: boolean }>("/api/us/research/jobs")
      .then(result => { if (active) { setJobs(validateRefreshHistory(result.jobs)); setCanInterrupt(result.interruption_available === true); } })
      .catch(() => { if (active) setError("Refresh history is unavailable. Saved research may still be available."); })
      .finally(() => { if (active) setLoading(false); });
    return () => { active = false; current.active = false; };
  }, [retry, revision]);
  async function interrupt(id: string) {
    const current = lifecycle.current;
    if (current.busy || !current.active) return;
    current.busy = true;
    const generation = current.generation;
    setPending(id);
    setError("");
    try {
      const result = await postAPI<{ job: Job }>(`/api/us/research/jobs/${encodeURIComponent(id)}/interrupt`, {});
      if (result.job?.id !== id || !["interrupted", "completed", "failed"].includes(result.job.state)) throw new Error("Unconfirmed interruption");
      const [observation] = validateRefreshHistory([result.job]);
      if (current.active && generation === current.generation) {
        setJobs(rows => rows.map(row => row.id === id ? observation : row));
        setConfirm("");
      }
    } catch {
      if (current.active && generation === current.generation) setError("Interruption was not confirmed. Reload history and check saved research before retrying.");
    } finally {
      current.busy = false;
      if (current.active) setPending("");
    }
  }
  return <section className="us-notes" aria-label="Your refresh history">
    <h3>Your recent refreshes</h3>
    <p>Latest 20 recorded jobs for this account. Status is not a worker heartbeat; after an outage, check saved research before retrying.</p>
    <button type="button" className="workspace-button" disabled={loading || !!pending} onClick={() => setRetry(value => value + 1)}>Reload refresh history</button>
    {loading && <p role="status">Loading refresh history…</p>}
    {error && <p role="alert">{error}</p>}
    {!loading && !error && jobs.length === 0 && <p>No recorded refresh jobs for this account.</p>}
    {!error && <ul>{jobs.map(job => <li key={job.id} className="my-2">
      <span>Last recorded: {job.state} · Job {job.id}</span>
      {job.updated_at && <span> · {new Date(job.updated_at).toLocaleString("en-US", { timeZone: "America/New_York" })} ET</span>}
      {canInterrupt && ["queued", "running"].includes(job.state) && (confirm === job.id ? <span>
        <span> Completion will remain unknown. Check saved research before starting another refresh.</span>
        <button type="button" className="workspace-button" disabled={!!pending} onClick={() => interrupt(job.id)}>{pending === job.id ? "Interrupting…" : "Confirm interruption"}</button>
        <button type="button" className="workspace-button" disabled={!!pending} onClick={() => setConfirm("")}>Keep refresh</button>
      </span> : <button type="button" className="workspace-button" disabled={!!pending} onClick={() => setConfirm(job.id)}>Interrupt refresh</button>)}
      {job.error && <span> · {job.error}</span>}
      {job.state === "completed" && /^[a-f0-9]{64}$/.test(job.package_id || "") && <button type="button" className="workspace-button" onClick={() => onOpen(job.package_id!)}>Open saved research</button>}
    </li>)}</ul>}
  </section>;
}
