"use client";
import { useEffect, useState } from "react";
import Link from "next/link";
import { fetchAPI } from "../../lib/api";
import { type ResearchResponse } from "../../lib/swing-research";
import { PageHeader } from "../layout/PageHeader";
import { SwingMarketSummary } from "./SwingMarketSummary";

export default function BreadthThrustContent() {
  const [universe, setUniverse] = useState("nifty500");
  const [data, setData] = useState<ResearchResponse | null>(null);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);
  useEffect(() => {
    let cancelled = false;
    setLoading(true); setError(""); setData(null);
    fetchAPI<ResearchResponse>(`/api/analysis/breadth-thrust?universe=${universe}`)
      .then(result => { if (!cancelled) setData(result); })
      .catch(e => { if (!cancelled) setError(e instanceof Error ? e.message : "Historical breadth unavailable"); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [universe]);
  return <div className="space-y-5">
    <PageHeader eyebrow="Completed sessions" title="Market breadth" description="Actual stock-level EMA participation, multi-session returns and trailing extremes. Unknown history stays unknown." />
    <label className="block text-sm text-muted">Universe <select className="ml-2 rounded-lg border border-card-border bg-card p-2" value={universe} onChange={e => setUniverse(e.target.value)}>
      {["nifty50", "nifty100", "nifty200", "nifty500", "smallcap", "microcap"].map(name => <option key={name}>{name}</option>)}
    </select></label>
    {loading && <p role="status" className="text-muted">Loading completed-session breadth…</p>}
    {error && <p role="alert" className="text-loss">{error}</p>}
    {data?.package && <SwingMarketSummary data={data.package} />}
    {!loading && !data?.package && <p className="rounded-xl border border-card-border bg-card p-6 text-muted">No verified saved research package for this universe. No proxy readings or sample history are displayed.</p>}
    <Link href="/swing" className="inline-block text-accent underline">Open swing research to refresh history, inspect stocks and plan</Link>
  </div>;
}
