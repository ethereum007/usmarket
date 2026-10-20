"use client";
import { useEffect, useState } from "react";
import { fetchAPI } from "../lib/api";
import { sourceLink } from "../latest-updates/model";

type Filing = { id: string; form: string; accepted_at: string; source_url: string; amendment: boolean; results_item_reported: boolean };
type Evidence = { symbol: string; cik: string; state: string; observed_at: string; filings: Filing[]; omitted_records: number; scope: string };

export default function USFilings({ symbol }: { symbol: string }) {
  const [evidence, setEvidence] = useState<Evidence | null>(null);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const [retry, setRetry] = useState(0);
  useEffect(() => {
    let active = true;
    setEvidence(null);
    setError("");
    if (!symbol) return;
    setLoading(true);
    fetchAPI<{ evidence: Evidence }>(`/api/us/filings?symbol=${encodeURIComponent(symbol)}`)
      .then(result => { if (active) setEvidence(result.evidence); })
      .catch(cause => { if (active) setError(cause instanceof Error ? cause.message : "SEC evidence unavailable"); })
      .finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [symbol, retry]);
  if (!symbol) return null;
  return <section className="us-notes" aria-label={`SEC filing evidence for ${symbol}`}>
    <h3>SEC filing evidence · {symbol}</h3>
    <p>Upcoming earnings date and BMO/AMC timing remain unknown. A filing date is not an earnings-event date.</p>
    {loading && <p role="status">Loading issuer filings…</p>}
    {error && <p role="alert">{error}. This does not mean there are no events.</p>}
    <button type="button" className="workspace-button" disabled={loading} onClick={() => setRetry(value => value + 1)}>Reload filing evidence</button>
    {evidence?.symbol === symbol && <>
      <p>{evidence.scope} · CIK {evidence.cik} · Retrieved {evidence.observed_at}</p>
      {evidence.omitted_records > 0 && <p role="status">Partial evidence: {evidence.omitted_records} malformed or duplicate records omitted.</p>}
      {!evidence.filings.length && <p>No supported recent filings returned. Older history and forthcoming events were not searched.</p>}
      <ul>{evidence.filings.map(filing => {
        const href = sourceLink(filing.source_url, ["sec.gov"]);
        return <li key={filing.id} className="my-2">
          {href ? <a href={href} target="_blank" rel="noopener noreferrer">{filing.form} · {new Date(filing.accepted_at).toLocaleString("en-US", { timeZone: "America/New_York" })} ET</a> : <span>Original source unavailable</span>}
          {filing.amendment && <span> · Amendment; read alongside the original</span>}
          {filing.results_item_reported && <span> · Results item reported; verify the document</span>}
        </li>;
      })}</ul>
    </>}
  </section>;
}
