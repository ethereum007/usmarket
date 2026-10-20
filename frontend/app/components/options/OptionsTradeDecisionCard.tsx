"use client";

import { AlertTriangle, CheckCircle2, Clock3, Crosshair, ShieldCheck, XCircle } from "lucide-react";
import { cn } from "../../lib/utils";

type DecisionAction = "TRADE" | "WAIT" | "HOLD" | "EXIT" | string;
type DecisionTone = "profit" | "loss" | "warning" | "neutral";

type TradeDecision = {
  action: DecisionAction;
  bias: "LONG" | "SHORT" | "RANGE" | "NONE" | string;
  quality: "A" | "B" | "C" | "NO_TRADE" | string;
  mode: string;
  confidence: number;
  score?: number;
  summary: string;
  entryTrigger: string;
  invalidation: string;
  targets?: string[];
  timeframe: string;
  reliability?: {
    status: string;
    score: number;
    provider: string;
    fallback?: boolean;
    tradeable?: boolean;
    reasons?: string[];
  };
  checks?: { label: string; ok: boolean; detail: string }[];
  riskNotes?: string[];
  positionPlan?: {
    holdCondition?: string;
    exitCondition?: string;
    note?: string;
  };
};

const actionConfig: Record<string, { label: string; tone: DecisionTone; icon: typeof CheckCircle2 }> = {
  TRADE: { label: "Trade Candidate", tone: "profit", icon: CheckCircle2 },
  WAIT: { label: "Wait", tone: "warning", icon: Clock3 },
  HOLD: { label: "Hold", tone: "neutral", icon: ShieldCheck },
  EXIT: { label: "Exit / Reduce", tone: "loss", icon: XCircle },
};

function toneClasses(tone: DecisionTone) {
  switch (tone) {
    case "profit":
      return "border-card-border bg-profit-bg text-profit";
    case "loss":
      return "border-card-border bg-loss-bg text-loss";
    case "warning":
      return "border-card-border bg-warning/10 text-warning";
    default:
      return "border-card-border bg-page-bg text-muted";
  }
}

function biasTone(bias: string): DecisionTone {
  if (bias === "LONG") return "profit";
  if (bias === "SHORT") return "loss";
  if (bias === "RANGE") return "warning";
  return "neutral";
}

function actionTone(action: string): DecisionTone {
  return actionConfig[action]?.tone || "neutral";
}

function formatMode(mode: string) {
  return String(mode || "NO_VIEW").replace(/_/g, " ");
}

function reliabilityTone(status?: string): DecisionTone {
  if (status === "LIVE") return "profit";
  if (status === "STALE" || status === "CACHED" || status === "CLOSED") return "warning";
  return "neutral";
}

export function OptionsTradeDecisionCard({ decision, name }: { decision?: TradeDecision | null; name?: string }) {
  if (!decision) return null;

  const action = actionConfig[decision.action] || { label: decision.action || "Decision", tone: "neutral" as DecisionTone, icon: Crosshair };
  const ActionIcon = action.icon;
  const confidence = Math.max(0, Math.min(100, decision.confidence || 0));
  const reliability = decision.reliability;
  const riskNotes = decision.riskNotes || [];
  const checks = decision.checks || [];

  return (
    <div className="min-w-0 overflow-hidden rounded-xl border border-card-border bg-card shadow-sm">
      <div className="grid min-w-0 gap-px bg-card-border lg:grid-cols-[1.15fr_0.85fr]">
        <div className="min-w-0 bg-card p-4">
          <div className="flex min-w-0 flex-wrap items-center gap-2">
            <span className="text-xs font-bold uppercase tracking-wide text-muted">Trade Decision</span>
            {name && <span className="text-xs text-muted">for {name}</span>}
            <span className={cn("inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[11px] font-bold", toneClasses(action.tone))}>
              <ActionIcon className="h-3 w-3" aria-hidden="true" />
              {action.label}
            </span>
            <span className={cn("rounded-full border px-2 py-0.5 text-[11px] font-bold", toneClasses(biasTone(decision.bias)))}>
              {decision.bias}
            </span>
            <span className="rounded-full border border-card-border bg-page-bg px-2 py-0.5 text-[11px] font-bold text-muted">
              {decision.quality}
            </span>
          </div>

          <div className="mt-2 text-base font-semibold leading-snug text-text-heading">
            {decision.summary}
          </div>
          <div className="mt-1 text-xs text-muted">
            {decision.timeframe} Decision aid only; confirm with live price and risk.
          </div>

          <div className="mt-4 grid min-w-0 gap-3 md:grid-cols-2">
            <DecisionBox title="Entry Trigger" value={decision.entryTrigger} tone={actionTone(decision.action)} />
            <DecisionBox title="Invalidation" value={decision.invalidation} tone="loss" />
          </div>

          {decision.targets && decision.targets.length > 0 && (
            <div className="mt-3 flex min-w-0 flex-wrap items-center gap-2 text-xs">
              <span className="font-semibold uppercase tracking-wide text-muted">Targets / Magnets</span>
              {decision.targets.map((target) => (
                <span key={target} className="rounded-md border border-card-border bg-page-bg px-2 py-1 font-mono font-semibold text-text-heading">
                  {target}
                </span>
              ))}
            </div>
          )}
        </div>

        <div className="min-w-0 bg-page-bg/45 p-4">
          <div className="flex min-w-0 items-start justify-between gap-4">
            <div className="min-w-0">
              <div className="text-xs font-bold uppercase tracking-wide text-muted">Confidence</div>
              <div className="mt-1 flex items-baseline gap-2">
                <span className="font-mono text-2xl font-bold text-text-heading">{confidence}%</span>
                <span className="text-xs uppercase text-muted">{formatMode(decision.mode)}</span>
              </div>
            </div>
            {reliability && (
              <div className={cn("shrink-0 rounded-lg border px-3 py-2 text-right", toneClasses(reliabilityTone(reliability.status)))}>
                <div className="text-[10px] font-bold uppercase tracking-wide">Data</div>
                <div className="text-xs font-bold">{reliability.status}</div>
                <div className="mt-0.5 text-[10px] opacity-80">{reliability.provider}</div>
              </div>
            )}
          </div>

          <div className="mt-3 h-2 overflow-hidden rounded-full bg-card-border/50">
            <div className={cn("h-full rounded-full", action.tone === "profit" ? "bg-profit" : action.tone === "loss" ? "bg-loss" : "bg-warning")} style={{ width: `${confidence}%` }} />
          </div>

          {checks.length > 0 && (
            <div className="mt-4 grid min-w-0 grid-cols-1 gap-2 sm:grid-cols-2">
              {checks.slice(0, 5).map((check) => (
                <div key={check.label} className="flex min-w-0 items-start gap-2 rounded-lg border border-card-border bg-card px-2 py-2">
                  {check.ok ? (
                    <CheckCircle2 className="mt-0.5 h-3.5 w-3.5 shrink-0 text-profit" aria-hidden="true" />
                  ) : (
                    <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0 text-warning" aria-hidden="true" />
                  )}
                  <div className="min-w-0">
                    <div className="truncate text-[11px] font-semibold text-text-heading">{check.label}</div>
                    <div className="truncate text-[10px] text-muted" title={check.detail}>{check.detail}</div>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>

      <div className="grid min-w-0 gap-px bg-card-border md:grid-cols-2">
        <div className="min-w-0 bg-card px-4 py-3">
          <div className="text-[11px] font-bold uppercase tracking-wide text-muted">Position Checklist</div>
          <div className="mt-1 line-clamp-2 text-xs text-text-heading" title={decision.positionPlan?.holdCondition}>
            {decision.positionPlan?.holdCondition || "Hold only while price and OI remain aligned."}
          </div>
          <div className="mt-1 line-clamp-2 text-xs text-muted" title={decision.positionPlan?.exitCondition}>
            {decision.positionPlan?.exitCondition || "Exit when the thesis breaks."}
          </div>
        </div>

        <div className="min-w-0 bg-card px-4 py-3">
          <div className="text-[11px] font-bold uppercase tracking-wide text-muted">Risk Notes</div>
          <div className="mt-1 text-xs text-muted">
            {riskNotes.length > 0 ? riskNotes.slice(0, 2).join(" ") : "No major extra risk flags from the current chain."}
          </div>
        </div>
      </div>
    </div>
  );
}

function DecisionBox({ title, value, tone }: { title: string; value: string; tone: DecisionTone }) {
  return (
    <div className={cn("min-w-0 rounded-lg border px-3 py-3", toneClasses(tone))}>
      <div className="text-[10px] font-bold uppercase tracking-wide opacity-80">{title}</div>
      <div className="mt-1 line-clamp-2 text-sm font-semibold leading-snug" title={value}>
        {value}
      </div>
    </div>
  );
}
