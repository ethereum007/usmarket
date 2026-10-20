"use client";

import { useCallback, useEffect, useMemo, useState, type FormEvent } from "react";
import Link from "next/link";
import dynamic from "next/dynamic";
import { fetchAPI, postAPI } from "../lib/api";
import { type ConditionalPlan, type ResearchPackage, type ResearchResponse, type ResearchSetup, numberText, weeklyBars } from "../lib/swing-research";
import { PageHeader } from "../components/layout/PageHeader";
import { SwingMarketSummary } from "../components/pages/SwingMarketSummary";

const Chart = dynamic(() => import("../components/charts/CandlestickChart").then(m => m.CandlestickChart), { ssr: false });
const ROOT = "/api/scanner/research";
const panel = "rounded-xl border border-card-border bg-card p-5";
const input = "w-full rounded-lg border border-card-border bg-card p-2 text-text-heading";
type Job = { id: string; state: string; completed: number; total: number; error?: string; failures?: Record<string, string>; package_state?: string };

export default function SwingResearchPage() {
  const [universe, setUniverse] = useState("nifty50");
  const [response, setResponse] = useState<ResearchResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [sessions, setSessions] = useState<{ id: string; session: string }[]>([]);
  const [error, setError] = useState("");
  const [job, setJob] = useState<Job | null>(null);
  const [group, setGroup] = useState("");
  const [selectedVersion, setSelectedVersion] = useState("");
  const [timeframe, setTimeframe] = useState("daily");
  const [plans, setPlans] = useState<ConditionalPlan[]>([]);
  const [planError, setPlanError] = useState("");
  const [editing, setEditing] = useState<ConditionalPlan | null>(null);
  const [shortlist, setShortlist] = useState<string[]>([]);
  const [onlyShortlist, setOnlyShortlist] = useState(false);
  const data = response?.package;

  useEffect(() => {
    try {
      const saved: unknown = JSON.parse(localStorage.getItem("alpha:swing-shortlist:v1") || "[]");
      if (Array.isArray(saved)) setShortlist(saved.filter((id): id is string => typeof id === "string"));
    } catch { /* A corrupt browser shortlist does not block server research. */ }
  }, []);

  const load = useCallback(async (selectedUniverse: string) => {
    setLoading(true); setError("");
    try {
      const [result, history] = await Promise.all([
        fetchAPI<ResearchResponse>(`${ROOT}/package?universe=${selectedUniverse}`),
        fetchAPI<{ sessions: { id: string; session: string }[] }>(`${ROOT}/history?universe=${selectedUniverse}`),
      ]);
      setResponse(result); setSessions(history.sessions);
    }
    catch (e) { setResponse(null); setError(e instanceof Error ? e.message : "Research unavailable"); }
    finally { setLoading(false); }
  }, []);

  useEffect(() => { void load(universe); setGroup(""); setSelectedVersion(""); setEditing(null); }, [universe, load]);
  const loadPlans = useCallback(async () => {
    try { const result = await fetchAPI<{ plans: ConditionalPlan[] }>(`${ROOT}/plans`); setPlans(result.plans); setPlanError(""); }
    catch (e) { setPlanError(e instanceof Error ? e.message : "Sign in to load private plans"); }
  }, []);
  useEffect(() => { void loadPlans(); }, [loadPlans]);

  const running = !!job && ["queued", "running"].includes(job.state);
  useEffect(() => {
    if (!job || !running) return;
    let cancelled = false;
    const timer = window.setInterval(async () => {
      try {
        const result = await fetchAPI<{ job: Job }>(`${ROOT}/jobs/${job.id}`);
        if (cancelled) return;
        setJob(result.job);
      } catch (e) { if (!cancelled) setError(e instanceof Error ? e.message : "Refresh status unavailable"); }
    }, 3000);
    return () => { cancelled = true; window.clearInterval(timer); };
  }, [job, running]);

  const candidates = useMemo(() => {
    const members = data?.groups.find(item => item.name === group)?.members;
    return (data?.setups || []).filter(setup => (!members || members.includes(setup.symbol)) && (!onlyShortlist || shortlist.includes(setup.setup_id)));
  }, [data, group, onlyShortlist, shortlist]);
  const selected = candidates.find(item => item.setup_version === selectedVersion) || candidates[0];
  const bars = selected ? data?.source_bars[selected.symbol] || [] : [];
  const displayedBars = timeframe === "weekly" ? weeklyBars(bars) : bars;

  async function refresh() {
    setError("");
    try { const result = await postAPI<{ job: Job }>(`${ROOT}/refresh`, { universe }); setJob(result.job); }
    catch (e) { setError(e instanceof Error ? e.message : "Could not start research refresh"); }
  }

  function toggleShortlist(setup: ResearchSetup) {
    const next = shortlist.includes(setup.setup_id) ? shortlist.filter(id => id !== setup.setup_id) : [...shortlist, setup.setup_id];
    setShortlist(next);
    try { localStorage.setItem("alpha:swing-shortlist:v1", JSON.stringify(next)); }
    catch { setError("Browser storage unavailable. Plans can still be saved to your account."); }
  }

  async function editPlan(plan: ConditionalPlan) {
    setLoading(true);
    try {
      const result = await fetchAPI<{ package: ResearchPackage }>(`${ROOT}/packages/${plan.package_id}`);
      setResponse({ success: true, package: result.package, has_final: result.package.state === "final" });
      setGroup(""); setOnlyShortlist(false); setSelectedVersion(plan.setup_version); setEditing(plan);
    } catch (e) { setPlanError(e instanceof Error ? e.message : "Original plan research unavailable"); }
    finally { setLoading(false); }
  }

  function exportShortlist() {
    const symbols = [...new Set((data?.setups || []).filter(s => shortlist.includes(s.setup_id)).map(s => `NSE:${s.symbol}`))];
    const blob = new Blob([symbols.join(",")], { type: "text/plain" });
    const url = URL.createObjectURL(blob); const link = document.createElement("a");
    link.href = url; link.download = `swing-${data?.session || "shortlist"}.txt`; link.click(); URL.revokeObjectURL(url);
  }

  return <div className="mx-auto max-w-[1600px] space-y-5">
    <PageHeader eyebrow="Prepare · confirm · review" title="Swing research" description="Completed-session research and conditional plans. Existing intraday tools remain the confirmation layer." />
    <div className="flex flex-wrap items-center gap-3">
      <label className="text-sm text-muted">Refresh universe <select aria-label="Refresh universe" className={input} value={universe} disabled={running || loading} onChange={e => setUniverse(e.target.value)}>
        {["nifty50", "nifty100", "nifty200", "nifty500", "smallcap", "microcap"].map(name => <option key={name}>{name}</option>)}
      </select></label>
      <button className="workspace-button" disabled={running || loading} onClick={refresh}>{running ? "Refreshing history…" : "Refresh completed-session research"}</button>
      {job?.state === "completed" && <button className="workspace-button" disabled={loading} onClick={() => { setEditing(null); setSelectedVersion(""); void load(universe); }}>Load refreshed research</button>}
      {sessions.length > 0 && <label className="text-sm text-muted">Saved session <select aria-label="Saved research session" className={input} value={data?.id || ""} disabled={loading} onChange={async event => {
        const id = event.target.value; if (!id) return;
        setLoading(true); setError("");
        try { const result = await fetchAPI<{ package: ResearchPackage }>(`${ROOT}/packages/${id}`); setResponse({ success: true, package: result.package, has_final: true }); setSelectedVersion(""); setEditing(null); }
        catch (e) { setError(e instanceof Error ? e.message : "Saved session unavailable"); }
        finally { setLoading(false); }
      }}><option value="" disabled>Select a published session</option>{sessions.map(item => <option key={item.id} value={item.id}>{item.session}</option>)}</select></label>}
      <Link className="text-sm text-accent underline" href="/trade-ideas?tab=swing">Existing Swing Spectrum</Link>
      <Link className="text-sm text-accent underline" href="/rrg">Relative rotation</Link>
    </div>
    {error && <p role="alert" className="rounded-lg bg-loss-bg p-4 text-loss">{error}</p>}
    {job && <p role="status" className="text-sm text-muted">Refresh {job.state}: {job.completed}/{job.total} instruments processed. {job.error || ""} {job.package_state === "partial" ? "Coverage is partial; last final research remains selected when available." : ""}</p>}
    {loading && <p role="status" className="text-sm text-muted">Loading saved research…</p>}
    {!loading && !data && <div className={panel}><h2 className="text-lg font-semibold text-text-heading">No saved research package</h2><p className="mt-2 text-sm text-muted">Refresh requires an available historical provider. Once published, saved research and charts remain available without a broker session. No sample prices or inferred breadth are shown.</p></div>}
    {data && <>
      <SwingMarketSummary data={data} />
      {response?.last_attempt?.state === "partial" && response.last_attempt.id !== data.id && <div className="text-sm text-muted">The latest refresh is partial. <button className="text-accent underline" onClick={() => { setResponse({ ...response, package: response.last_attempt! }); setSelectedVersion(""); }}>Inspect partial coverage</button></div>}
      <section className={panel} aria-label="Sector leadership context">
        <h2 className="text-lg font-semibold text-text-heading">Leadership context · sectors</h2>
        <p className="my-2 text-sm text-muted">Industry taxonomy and participation history are unavailable. Sector membership is the current configured map; {data.unclassified_symbols.length}/{data.symbols.length} symbols are unclassified. RS below is mean 20-session excess return, not a percentile or RRG verdict.</p>
        <div className="overflow-x-auto"><table className="w-full text-left text-sm"><thead><tr className="border-b border-card-border text-muted"><th scope="col" className="p-2">Sector</th><th scope="col">20 EMA participation</th><th scope="col">20-session excess return</th><th scope="col">Setup names</th></tr></thead><tbody>
          {data.groups.map(item => <tr key={item.name} className="border-b border-card-border"><th scope="row" className="p-2"><button aria-pressed={group === item.name} className="text-accent underline" onClick={() => { setGroup(group === item.name ? "" : item.name); setSelectedVersion(""); setEditing(null); }}>{item.name}</button></th><td>{numberText(item.breadth.gauges[1]?.value)}% · {item.breadth.gauges[1]?.eligible}/{item.members.length} eligible</td><td>{item.mean_excess_return20 == null ? "Unknown" : `${numberText(item.mean_excess_return20)} pp`} · N {item.rs20_eligible}</td><td>{item.setup_symbols.length}</td></tr>)}
        </tbody></table></div>
      </section>
      <section className="grid gap-5 xl:grid-cols-[340px_minmax(0,1fr)]" aria-label="Swing research terminal">
        <div className={panel}>
          <h2 className="text-lg font-semibold text-text-heading">Research playlist</h2>
          <div className="my-3 flex flex-wrap gap-3 text-sm"><label className="text-muted"><input type="checkbox" checked={onlyShortlist} onChange={e => setOnlyShortlist(e.target.checked)} /> Shortlist only</label><button onClick={exportShortlist} className="text-accent underline">Export symbols</button>{group && <button className="text-accent underline" onClick={() => setGroup("")}>Clear {group}</button>}</div>
          <p className="mb-3 text-xs text-muted">{candidates.length} theses. Different entries and stops stay separate. Strength is an uncalibrated engine score.</p>
          <div className="max-h-[650px] space-y-2 overflow-y-auto">
            {candidates.map(item => <button key={item.setup_version} aria-pressed={selected?.setup_version === item.setup_version} className={`w-full rounded-lg border p-3 text-left ${selected?.setup_version === item.setup_version ? "border-accent" : "border-card-border"}`} onClick={() => { setSelectedVersion(item.setup_version); setEditing(null); }}><strong className="text-text-heading">{item.symbol} · {item.signal}</strong><span className="block text-xs text-muted">{item.strategy} · {item.lifecycle_state} · strength {item.strength}</span></button>)}
            {!candidates.length && <p className="text-sm text-muted">No eligible setup in this saved package and filter. Coverage gaps are listed separately.</p>}
          </div>
        </div>
        <div className="space-y-5">
          {selected && <>
            <div className={panel}>
              <div className="flex flex-wrap justify-between gap-3"><h2 className="text-xl font-semibold text-text-heading">{selected.symbol} · {selected.strategy}</h2><button className="workspace-button" onClick={() => toggleShortlist(selected)}>{shortlist.includes(selected.setup_id) ? "Remove from shortlist" : "Add to shortlist"}</button></div>
              <div className="my-3 flex gap-3"><label className="text-sm text-muted">Chart <select aria-label="Chart timeframe" className={input} value={timeframe} onChange={e => setTimeframe(e.target.value)}><option value="daily">Daily</option><option value="weekly">Weekly · observed bars</option></select></label></div>
              <Chart data={displayedBars} symbol={selected.symbol} height={380} priceLevels={[
                { price: selected.entry_price, title: "Engine entry", color: "#3b82f6" },
                { price: selected.stop_loss, title: "Engine stop", color: "#ef4444" },
              ].filter(level => level.price > 0)} />
              <p className="mt-3 text-sm text-text-heading">Entry {numberText(selected.entry_price)} · Stop {numberText(selected.stop_loss)} · Policy objective {numberText(selected.target)}. Structural room: unknown.</p>
              <p className="mt-2 text-sm text-muted">{selected.notes} {selected.target_policy}. Weekly view aggregates observed sessions; the last week may be incomplete.</p>
              <ul className="mt-3 list-disc space-y-1 pl-5 text-sm text-muted">{[...selected.reasons, ...selected.research_warnings].map((reason, index) => <li key={`${index}-${reason}`}>{reason}</li>)}</ul>
              <details className="mt-3 text-xs text-muted"><summary>Source identity and bars</summary><p className="break-all">Package {data.id} · setup {selected.setup_id} · version {selected.setup_version}</p><p>{bars.length} completed bars, {bars[0]?.date} to {bars.at(-1)?.date}. Latest close {numberText(bars.at(-1)?.close)}. RS 20 {numberText(selected.benchmark_rs_20)} pp; RS 60 {numberText(selected.benchmark_rs_60)} pp.</p></details>
            </div>
            <PlanEditor key={`${selected.setup_version}-${editing?.revision || 0}`} data={data} setup={selected} existing={editing?.setup_version === selected.setup_version ? editing : null} onSaved={plan => { setEditing(plan); void loadPlans(); }} />
          </>}
        </div>
      </section>
      {data.missing_symbols.length > 0 && <details className={panel}><summary className="text-text-heading">Missing selected-session bars · {data.missing_symbols.length}</summary><p className="mt-2 text-sm text-muted">{data.missing_symbols.join(", ")}</p></details>}
    </>}
    <section className={panel} aria-label="Private conditional plan review"><h2 className="text-lg font-semibold text-text-heading">Your plans & review</h2>
      {planError && <p role="alert" className="mt-2 text-sm text-loss">{planError}</p>}
      {!plans.length && <p className="mt-2 text-sm text-muted">No saved plans in this account. Plans are research records; triggered and filled outcomes are not inferred.</p>}
      <div className="mt-3 space-y-3">{plans.map(plan => <div key={plan.id} className="rounded-lg border border-card-border p-3"><div className="flex flex-wrap justify-between gap-3"><strong className="text-text-heading">{plan.symbol} · {plan.direction} · revision {plan.revision}</strong><button className="text-sm text-accent underline" onClick={() => editPlan(plan)}>Review original research / revise</button></div><p className="mt-1 text-sm text-muted">{plan.state} · Trigger {numberText(plan.trigger)} · Stop {numberText(plan.stop)} · {plan.quantity} shares under stop/allocation caps · Expires {plan.expiry}. Alert {plan.alert_state}. {plan.event_risk}.</p><Link className="mt-2 inline-block text-sm text-accent underline" href={`/radar-trade?symbol=${encodeURIComponent(plan.symbol)}&plan=${plan.id}&revision=${plan.revision}`}>Inspect intraday confirmation with plan context</Link></div>)}</div>
      <Link className="mt-4 inline-block text-sm text-accent underline" href="/trade-ideas?tab=performance">Existing outcome review · discovery statistics are separate from fills</Link>
    </section>
  </div>;
}

function PlanEditor({ data, setup, existing, onSaved }: { data: ResearchPackage; setup: ResearchSetup; existing: ConditionalPlan | null; onSaved: (plan: ConditionalPlan) => void }) {
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); setSaving(true); setError("");
    const values = new FormData(event.currentTarget);
    try {
      const result = await postAPI<{ plan: ConditionalPlan }>(`${ROOT}/plans/${existing?.id || crypto.randomUUID()}`, {
        expected_revision: existing?.revision || 0, package_id: data.id, setup_version: setup.setup_version,
        trigger: Number(values.get("trigger")), stop: Number(values.get("stop")), expiry: values.get("expiry"),
        capital: Number(values.get("capital")), risk_pct: Number(values.get("risk_pct")), allocation_cap_pct: Number(values.get("allocation_cap_pct")),
        notes: values.get("notes"), exit_policy: values.get("exit_policy"), state: values.get("state"), earnings_state: values.get("earnings_state"),
      });
      onSaved(result.plan);
    } catch (e) { setError(e instanceof Error ? e.message : "Plan save failed"); }
    finally { setSaving(false); }
  }
  return <form className={panel} onSubmit={submit}>
    <h2 className="text-lg font-semibold text-text-heading">{existing ? `Revise conditional plan · v${existing.revision}` : "Create conditional plan"}</h2>
    <p className="my-2 text-sm text-muted">Private, versioned research. Stop risk and allocation cap limit size. Liquidity caps, portfolio concentration, overnight gap stress and event verification remain required before execution. Alerts are not armed by saving.</p>
    <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
      {([{ name: "trigger", label: "Conditional trigger", value: existing?.trigger ?? setup.entry_price, min: 0.01, max: undefined },
        { name: "stop", label: "Structural invalidation", value: existing?.stop ?? setup.stop_loss, min: 0.01, max: undefined },
        { name: "capital", label: "Planning capital ₹", value: existing?.capital, min: 1, max: undefined },
        { name: "risk_pct", label: "Risk % of capital", value: existing?.risk_pct, min: 0.01, max: 5 },
        { name: "allocation_cap_pct", label: "Allocation cap %", value: existing?.allocation_cap_pct, min: 0.01, max: 100 },
      ]).map(field => <label key={field.name} className="text-sm text-muted">{field.label}<input required type="number" step="any" name={field.name} min={field.min} max={field.max} defaultValue={field.value} className={input} /></label>)}
      <label className="text-sm text-muted">Expiry session/date<input required type="date" name="expiry" defaultValue={existing?.expiry} min={data.session} className={input} /></label>
      <label className="text-sm text-muted">Plan state<select aria-label="Plan state" name="state" defaultValue={existing?.state || "draft"} className={input}>{["draft", "planned", "cancelled", "invalidated", "expired"].map(state => <option key={state}>{state}</option>)}</select></label>
      <label className="text-sm text-muted">Earnings research<select aria-label="Earnings research" name="earnings_state" defaultValue={existing?.earnings_state || "unknown"} className={input}><option value="unknown">Unknown</option><option value="checked_no_event">Personally checked: no nearby event</option><option value="event_nearby">Event nearby</option></select></label>
    </div>
    <label className="mt-3 block text-sm text-muted">Conditional exit policy<textarea aria-label="Conditional exit policy" name="exit_policy" required minLength={5} maxLength={1000} defaultValue={existing?.exit_policy} className={input} /></label>
    <label className="mt-3 block text-sm text-muted">Private thesis / research notes<textarea aria-label="Private thesis / research notes" name="notes" maxLength={10000} defaultValue={existing?.notes} className={input} /></label>
    {error && <p role="alert" className="my-3 text-sm text-loss">{error}</p>}
    <button disabled={saving} className="workspace-button mt-3">{saving ? "Saving…" : "Save plan revision"}</button>
  </form>;
}
