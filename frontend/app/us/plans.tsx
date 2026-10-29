"use client";

import { useEffect, useRef, useState, type FormEvent, type RefObject } from "react";
import dynamic from "next/dynamic";
import { useTheme } from "../lib/theme";
import PlanHistory from "./plan-history";
import PlanExport from "./plan-export";
import type { ResearchSetup } from "../lib/swing-research";
import { listUSPlans, loadUSPlan, saveUSPlan, previewUSPlanSizing, type USSizing, type USPlan } from "../lib/us-plans";
import { usd, type USPackage } from "../lib/us-research";

type Review = Awaited<ReturnType<typeof loadUSPlan>>;
const input = "workspace-input w-full";
const Chart = dynamic(() => import("../components/charts/CandlestickChart").then(module => module.CandlestickChart), { ssr: false });

export default function USPlans({ data, setup }: { data: USPackage | null; setup: ResearchSetup | undefined }) {
  const { theme } = useTheme();
  const [plans, setPlans] = useState<USPlan[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [editing, setEditing] = useState<Review | null>(null);
  const [opening, setOpening] = useState(false);
  const [savedMessage, setSavedMessage] = useState("");
  const [draftSource, setDraftSource] = useState<{ data: USPackage; setup: ResearchSetup } | null>(null);
  const [draftGeneration, setDraftGeneration] = useState(0);
  const request = useRef(0);
  const reviewRequest = useRef(0);
  const replacementGuard = useRef<(() => boolean) | null>(null);
  function mayReplaceEditor() {
    if (!replacementGuard.current || replacementGuard.current()) return true;
    setError("Plan replacement cancelled. Keep editing, or wait for the current save to finish");
    return false;
  }
  useEffect(() => {
    void refresh();
    return () => { request.current++; reviewRequest.current++; };
  }, []);
  async function refresh() {
    const version = ++request.current;
    setLoading(true);
    setError("");
    try {
      const result = await listUSPlans();
      if (version === request.current) setPlans(result.plans);
    } catch (cause) {
      if (version === request.current) setError(cause instanceof Error ? cause.message : "Plans could not be loaded");
    } finally {
      if (version === request.current) setLoading(false);
    }
  }
  async function review(plan: USPlan) {
    const version = ++reviewRequest.current;
    setOpening(true);
    setError("");
    setSavedMessage("");
    try {
      const result = await loadUSPlan(plan);
      if (version === reviewRequest.current && mayReplaceEditor()) setEditing(result);
    } catch (cause) {
      if (version === reviewRequest.current) setError(cause instanceof Error ? cause.message : "Original plan evidence is unavailable");
    } finally {
      if (version === reviewRequest.current) setOpening(false);
    }
  }
  const source = editing?.data || draftSource?.data || data;
  const thesis = editing?.setup || draftSource?.setup || setup;
  function preserveDraftSource() {
    if (!editing && source && thesis) setDraftSource({ data: source, setup: thesis });
  }
  function startSelectedPlan() {
    if (!mayReplaceEditor()) return;
    reviewRequest.current++;
    setEditing(null);
    setDraftSource(null);
    setDraftGeneration(previous => previous + 1);
    setSavedMessage("");
  }
  function saved(plan: USPlan) {
    if (!source || !thesis) return;
    request.current++;
    setLoading(false);
    setError("");
    setPlans(previous => [plan, ...previous.filter(row => row.id !== plan.id)]);
    setEditing({ plan, data: source, setup: thesis });
    setSavedMessage(`Saved ${plan.symbol} revision ${plan.revision} to the US plan service.`);
  }
  return (
    <section className="us-panel mt-6 space-y-5 p-5" id="us-plans" aria-labelledby="us-plans-title">
      <div className="us-panel-title"><div><span className="us-eyebrow">PRIVATE RESEARCH RECORDS</span><h2 id="us-plans-title">Your US plans</h2></div><button className="workspace-button" type="button" disabled={loading || opening} onClick={() => void refresh()}>Reload saved plans</button></div>
      <p className="text-sm text-text-secondary">Saved through your authenticated account. Hosting durability is still under validation. Browser shortlist notes remain separate and are never imported automatically.</p>
      <PlanExport />
      {loading && <p role="status">Loading saved plans…</p>}
      {error && <p role="alert">{error}. Existing edits have not been replaced. Reload the list, then explicitly reopen a revision to discard edits and use its saved values.</p>}
      {savedMessage && <p role="status">{savedMessage}</p>}
      {!loading && !error && !plans.length && <p>No plans saved in this account yet.</p>}
      <ul className="space-y-3">{plans.map(plan => <li key={plan.id} className="rounded-lg border border-card-border p-3">
        <strong>{plan.symbol} · {plan.direction} · revision {plan.revision}</strong>
        <p className="text-sm text-text-secondary">{plan.state} · Trigger {usd(plan.trigger)} · Stop {usd(plan.stop)} · {plan.quantity} whole shares · Expires {plan.expiry} (ET)</p>
        <p className="text-xs text-text-secondary">Source session {plan.session} · {plan.event_risk} · No fill inferred</p>
        <button className="workspace-button mt-2" type="button" disabled={opening} onClick={() => void review(plan)}>Open saved evidence / revise {plan.symbol}</button>
      </li>)}</ul>
      {opening && <p role="status">Checking original research and saved revision…</p>}
      {draftSource && !editing && <p role="status" className="text-sm">Your unsaved {draftSource.setup.symbol} plan stays bound to research from {draftSource.data.session} while you browse other setups.</p>}
      {(editing || draftSource) && <button className="workspace-button" type="button" disabled={opening} onClick={startSelectedPlan}>Start a new plan for the selected setup</button>}
      {editing && <div className="text-sm"><p>Editing saved {editing.plan.symbol} revision {editing.plan.revision} from {editing.data.session}. This stays bound to its original setup when you browse other stocks.</p></div>}
      {editing && <PlanHistory key={`${editing.plan.id}:${editing.plan.revision}`} plan={editing.plan} />}
      {editing && <details><summary>Original saved research · {editing.setup.symbol} · {editing.data.session}</summary>
        <p className="my-2 text-sm">{editing.setup.strategy} · {editing.data.benchmark} benchmark · {editing.data.feed.toUpperCase()} · Original snapshot {editing.plan.source_snapshot_id}</p>
        <Chart appearance={theme} data={editing.data.source_bars[editing.plan.symbol] || []} symbol={editing.plan.symbol} height={280} priceLevels={[{ price: editing.plan.trigger, title: "Saved trigger", color: "#3b82f6" }, { price: editing.plan.stop, title: "Saved stop", color: "#ef4444" }]} />
        <p className="text-sm">{editing.setup.notes}</p><p className="text-xs text-text-secondary">Historical source evidence; no later prices or fill outcomes are inferred.</p>
      </details>}
      {source && thesis && source.state === "final" ? <USPlanEditor key={`${editing?.plan.id || source.id}:${thesis.setup_version}:${editing?.plan.revision || 0}:${draftGeneration}`} data={source} setup={thesis} existing={editing?.plan || null} onSaved={saved} replacementGuard={replacementGuard} onDraftStarted={preserveDraftSource} /> : <p>Select a detected setup in a final US research package to create a plan. Partial research cannot back a saved plan.</p>}
    </section>
  );
}

// Adapted from the imported swing PlanEditor; US identity, currency and event policy are explicit.
export function USPlanEditor({ data, setup, existing, onSaved, replacementGuard, onDraftStarted }: { data: USPackage; setup: ResearchSetup; existing: USPlan | null; onSaved: (plan: USPlan) => void; replacementGuard?: RefObject<(() => boolean) | null>; onDraftStarted?: () => void }) {
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [sizing, setSizing] = useState<USSizing | null>(null);
  const [previewing, setPreviewing] = useState(false);
  const [sizingError, setSizingError] = useState("");
  const previewVersion = useRef(0);
  const pending = useRef(false);
  const dirty = useRef(false);
  const planId = useRef(existing?.id || "");
  const active = useRef(true);
  useEffect(() => {
    active.current = true;
    return () => { active.current = false; previewVersion.current++; };
  }, []);
  useEffect(() => {
    if (typeof window === "undefined") return;
    const beforeLeave = (event: BeforeUnloadEvent) => {
      if (!dirty.current && !pending.current) return;
      event.preventDefault();
      event.returnValue = "";
    };
    window.addEventListener("beforeunload", beforeLeave);
    return () => window.removeEventListener("beforeunload", beforeLeave);
  }, []);
  useEffect(() => {
    if (!replacementGuard) return;
    // Read current refs at replacement time, including edits made during evidence loading.
    const allow = () => !pending.current && (!dirty.current || window.confirm("Discard unsaved plan edits and replace this editor?"));
    replacementGuard.current = allow;
    return () => { if (replacementGuard.current === allow) replacementGuard.current = null; };
  }, [replacementGuard]);
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (pending.current) return;
    onDraftStarted?.();
    pending.current = true;
    setSaving(true);
    setError("");
    try {
      // Retain identity after an ambiguous timeout; do not create duplicate plans on retry.
      if (!planId.current) planId.current = crypto.randomUUID();
      const result = await saveUSPlan(planId.current, data, setup, existing, new FormData(event.currentTarget));
      if (active.current) { dirty.current = false; onSaved(result.plan); }
    } catch (cause) {
      if (active.current) setError(cause instanceof Error ? cause.message : "Plan save was not confirmed");
    } finally {
      pending.current = false;
      if (active.current) setSaving(false);
    }
  }
  async function preview(form: HTMLFormElement | null) {
    if (!form) return;
    const version = ++previewVersion.current;
    setPreviewing(true);setSizingError("");setSizing(null);
    try {
      const result = await previewUSPlanSizing(setup.signal, new FormData(form));
      if (active.current && version === previewVersion.current) setSizing(result.sizing);
    } catch {
      if (active.current && version === previewVersion.current) setSizingError("Sizing could not be confirmed. Check inputs and retry; no plan was saved by this preview.");
    } finally {
      if (active.current && version === previewVersion.current) setPreviewing(false);
    }
  }
  return <form onChange={() => { onDraftStarted?.(); dirty.current = true; previewVersion.current++; setSizing(null); setSizingError(""); setPreviewing(false); }} onSubmit={submit} aria-label="US conditional plan" className="space-y-4 border-t border-card-border pt-5">
    <p className="text-xs text-text-secondary">Unsaved edits stay with this research while you browse. Save before leaving this page; drafts are held only in this open editor.</p>
    <h3>{existing ? `Revise ${setup.symbol} plan · revision ${existing.revision}` : `Create ${setup.symbol} conditional plan`}</h3>
    <p className="text-xs text-text-secondary">Source session {data.session} · {setup.signal} · USD · Package {data.id.slice(0, 12)} · Setup {setup.setup_version.slice(0, 12)}</p>
    <fieldset disabled={saving} className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3"><legend className="sr-only">Plan parameters in US dollars</legend>
      {[
        { name: "trigger", label: "Conditional trigger (USD)", value: existing?.trigger ?? setup.entry_price, min: 0.0001, max: 1000000 },
        { name: "stop", label: "Structural stop (USD)", value: existing?.stop ?? setup.stop_loss, min: 0.0001, max: 1000000 },
        { name: "capital", label: "Planning capital (USD)", value: existing?.capital, min: 1, max: 1000000000000 },
        { name: "risk_pct", label: "Stop risk (% of capital)", value: existing?.risk_pct, min: 0.0001, max: 5 },
        { name: "allocation_cap_pct", label: "Allocation cap (%)", value: existing?.allocation_cap_pct, min: 0.0001, max: 100 },
      ].map(field => <label key={field.name} className="text-sm">{field.label}<input className={input} required name={field.name} type="number" step="any" min={field.min} max={field.max} defaultValue={field.value} /></label>)}
      <label className="text-sm">Expiry date (New York)<input className={input} required type="date" name="expiry" min={data.session} defaultValue={existing?.expiry} /></label>
      <label className="text-sm">Planning state<select className={input} name="state" defaultValue={existing?.state || "draft"}>{["draft", "planned", "cancelled", "invalidated", "expired"].map(state => <option key={state}>{state}</option>)}</select></label>
      <label className="text-sm sm:col-span-2">Conditional exit policy<textarea className={input} required name="exit_policy" minLength={5} maxLength={1000} defaultValue={existing?.exit_policy} /></label>
      <label className="text-sm sm:col-span-2">Private plan notes<textarea className={input} name="notes" maxLength={10000} defaultValue={existing?.notes} /></label>
    </fieldset>
    <button type="button" className="workspace-button" disabled={saving || previewing} onClick={event => void preview(event.currentTarget.form)}>{previewing ? "Checking sizing…" : "Preview USD sizing"}</button>
    {sizingError && <p role="alert">{sizingError}</p>}
    {sizing && <div role="status" className="text-sm">
      <p>{sizing.quantity} whole shares · Planning notional {usd(sizing.planning_notional_usd)} · Stop-distance risk {usd(sizing.stop_risk_usd)}</p>
      <p>Risk budget {usd(sizing.risk_budget_usd)} · Allocation cap {usd(sizing.allocation_budget_usd)} · Stop distance per share {usd(sizing.risk_per_share_usd)}</p>
      {sizing.state === "zero_capacity" && <p>No whole shares fit these limits. This sizing has zero capacity.</p>}
      <p>Hypothetical sizing only. Saving recalculates these values; gaps, fees, liquidity and short borrow are not modeled.</p>
    </div>}
    <p className="text-xs text-text-secondary">Earnings and catalysts unknown. Gaps, liquidity, fees and short-sale constraints unverified. Saving does not arm alerts or place orders.</p>
    {error && <p role="alert">Save not confirmed: {error}. Your draft remains here. For conflicts or timeouts, reload the saved-plan list and reopen its latest revision before retrying; reopening replaces unsaved edits.</p>}
    <button className="workspace-button workspace-button-primary" disabled={saving || data.state !== "final"} type="submit">{saving ? "Saving…" : "Save private plan revision"}</button>
  </form>;
}
