"use client";
import { useEffect, useState } from "react";
import Link from "next/link";
import { fetchAPI } from "../../lib/api";
import { type ConditionalPlan, numberText } from "../../lib/swing-research";

export function SwingPlanContext({ planId, revision, symbol, price }: { planId: string; revision: string; symbol: string; price: number | null }) {
  const [data, setData] = useState<{ plan: ConditionalPlan; latest: ConditionalPlan } | null>(null);
  const [error, setError] = useState("");
  useEffect(() => {
    let cancelled = false;
    setData(null); setError("");
    fetchAPI<{ plan: ConditionalPlan; latest: ConditionalPlan }>(`/api/scanner/research/plans/${encodeURIComponent(planId)}?revision=${encodeURIComponent(revision)}`)
      .then(result => { if (!cancelled) setData(result); })
      .catch(e => { if (!cancelled) setError(e instanceof Error ? e.message : "Plan unavailable"); });
    return () => { cancelled = true; };
  }, [planId, revision]);
  const plan = data?.plan;
  const today = new Date().toLocaleDateString("en-CA", { timeZone: "Asia/Kolkata" });
  let status = "Loading saved plan; confirmation is not verified";
  if (error) status = error;
  else if (plan && data) {
    if (plan.symbol !== symbol) status = "Plan symbol does not match this cockpit";
    else if (data.latest.revision !== plan.revision) status = "A newer plan revision exists; this revision is historical";
    else if (plan.state !== "planned") status = `Plan is ${plan.state}; no active entry confirmation`;
    else if (plan.expiry < today) status = "Plan expired; no active entry confirmation";
    else if (price == null || price <= 0) status = "Live price unavailable; trigger and invalidation unknown";
    else if ((plan.direction === "BULL" && price <= plan.stop) || (plan.direction === "BEAR" && price >= plan.stop)) status = "Saved structural invalidation reached; tape cannot override the stop";
    else if ((plan.direction === "BULL" && price >= plan.trigger) || (plan.direction === "BEAR" && price <= plan.trigger)) status = "Trigger condition observed in quote; freshness, liquidity, gaps and events still require verification. This is not a fill.";
    else status = "Waiting for saved conditional trigger";
  }
  return <section className="rounded-xl border border-card-border bg-card p-5" aria-label="Preserved swing plan context">
    <h2 className="text-lg font-semibold text-text-heading">Swing plan · revision {revision}</h2>
    <p role="status" className="mt-2 text-sm text-warning">{status}</p>
    {plan && <><p className="mt-2 text-sm text-text-heading">{plan.symbol} · {plan.direction} · Trigger {numberText(plan.trigger)} · Original invalidation {numberText(plan.stop)} · Expires {plan.expiry}.</p><p className="mt-2 text-sm text-muted">{plan.exit_policy} {plan.event_risk}. Source session {plan.session}. Intraday evidence below does not revise these saved levels. Planning only; alert and fill states are unchanged.</p></>}
    <Link href="/swing" className="mt-3 inline-block text-sm text-accent underline">Return to saved swing research & plans</Link>
  </section>;
}
