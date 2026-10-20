"use client";
import { useEffect, useState } from "react";
import { fetchAPI } from "../lib/api";

type Job = { id: string; state: string; updated_at?: string; package_id?: string; error?: string };

export default function RefreshHistory({ onOpen, revision }: { onOpen: (id: string) => void; revision: string }) {
  const [jobs, setJobs] = useState<Job[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [retry, setRetry] = useState(0);
  useEffect(() => {
    let active = true;
    setLoading(true);
    setError("");
    fetchAPI<{ jobs: Job[] }>("/api/us/research/jobs")
      .then(result => { if (active) setJobs(result.jobs); })
      .catch(() => { if (active) setError("Refresh history is unavailable. Saved research may still be available."); })
      .finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [retry, revision]);
  return <section className="us-notes" aria-label="Your refresh history">
    <h3>Your recent refreshes</h3>
    <p>Latest 20 recorded jobs for this account. Status is not a worker heartbeat; after an outage, check saved research before retrying.</p>
    <button type="button" className="workspace-button" disabled={loading} onClick={() => setRetry(value => value + 1)}>Reload refresh history</button>
    {loading && <p role="status">Loading refresh history…</p>}
    {error && <p role="alert">{error}</p>}
    {!loading && !error && jobs.length === 0 && <p>No recorded refresh jobs for this account.</p>}
    {!error && <ul>{jobs.map(job => <li key={job.id} className="my-2">
      <span>Last recorded: {job.state} · Job {job.id}</span>
      {job.updated_at && <span> · {new Date(job.updated_at).toLocaleString("en-US", { timeZone: "America/New_York" })} ET</span>}
      {job.error && <span> · {job.error}</span>}
      {job.state === "completed" && /^[a-f0-9]{64}$/.test(job.package_id || "") && <button type="button" className="workspace-button" onClick={() => onOpen(job.package_id!)}>Open saved research</button>}
    </li>)}</ul>}
  </section>;
}
