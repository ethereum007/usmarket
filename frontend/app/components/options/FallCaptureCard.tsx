"use client";

import { AlertTriangle, CheckCircle2, TrendingDown } from "lucide-react";
import { cn } from "../../lib/utils";

type FallCaptureState = "FALL_ACTIVE" | "FALL_STARTING" | "WATCH_BREAKDOWN" | "WAIT" | "NO_DATA" | string;

type FallCaptureSignal = {
  state: FallCaptureState;
  bias: string;
  score: number;
  confidence: number;
  summary: string;
  trigger: string;
  confirmation: string;
  invalidation: string;
  timeframe?: string;
  chaseRisk?: boolean;
  levels?: {
    spot?: number;
    breakdown?: number;
    confirmation?: number;
    continuation?: number;
    invalidation?: number;
    immediateFloor?: number;
    nextSupport?: number;
  };
  metrics?: {
    changePts?: number | null;
    changePct?: number | null;
    pcr?: number | null;
    ceBuildText?: string;
    peBuildText?: string;
    cePeBuildRatio?: number;
    maxPain?: number | null;
  };
  checks?: { label: string; ok: boolean; detail: string }[];
  warnings?: string[];
};

function stateTone(state: FallCaptureState) {
  if (state === "FALL_ACTIVE") {
    return {
      label: "Fall Active",
      shell: "border-loss/30 bg-loss-bg text-loss",
      bar: "bg-loss",
      panel: "border-card-border bg-loss-bg",
    };
  }
  if (state === "FALL_STARTING" || state === "WATCH_BREAKDOWN") {
    return {
      label: state === "FALL_STARTING" ? "Fall Starting" : "Watch Breakdown",
      shell: "border-warning/30 bg-warning/10 text-warning",
      bar: "bg-warning",
      panel: "border-card-border bg-warning/10",
    };
  }
  return {
    label: state === "NO_DATA" ? "No Data" : "No Fall Signal",
    shell: "border-card-border bg-page-bg text-muted",
    bar: "bg-muted",
    panel: "border-card-border bg-card",
  };
}

function formatLevel(value?: number | null) {
  if (!value || Number.isNaN(value)) return "-";
  return Math.abs(value - Math.round(value)) < 0.01
    ? Math.round(value).toLocaleString("en-IN")
    : value.toLocaleString("en-IN", { maximumFractionDigits: 2 });
}

function formatSigned(value?: number | null, suffix = "") {
  if (value === null || value === undefined || Number.isNaN(value)) return "-";
  const sign = value > 0 ? "+" : "";
  return `${sign}${value.toFixed(2)}${suffix}`;
}

export function FallCaptureCard({ signal, name }: { signal?: FallCaptureSignal | null; name?: string }) {
  if (!signal || signal.state === "NO_DATA") return null;

  const tone = stateTone(signal.state);
  const confidence = Math.max(0, Math.min(100, signal.confidence || signal.score || 0));
  const checks = signal.checks || [];
  const warnings = signal.warnings || [];

  return (
    <div className={cn("overflow-hidden rounded-xl border shadow-sm", tone.panel)}>
      <div className="grid min-w-0 gap-px bg-card-border lg:grid-cols-[1fr_280px]">
        <div className="min-w-0 bg-card p-4">
          <div className="flex min-w-0 flex-wrap items-center gap-2">
            <span className="text-xs font-bold uppercase tracking-wide text-muted">Fall Capture</span>
            {name && <span className="text-xs text-muted">for {name}</span>}
            <span className={cn("inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[11px] font-bold", tone.shell)}>
              <TrendingDown className="h-3.5 w-3.5" aria-hidden="true" />
              {tone.label}
            </span>
            <span className="rounded-full border border-card-border bg-page-bg px-2 py-0.5 text-[11px] font-bold text-muted">
              {signal.bias?.replace(/_/g, " ") || "NO VIEW"}
            </span>
            {signal.chaseRisk && (
              <span className="rounded-full border border-warning/30 bg-warning/10 px-2 py-0.5 text-[11px] font-bold text-warning">
                Chase Risk
              </span>
            )}
          </div>

          <div className="mt-2 text-base font-semibold leading-snug text-text-heading">
            {signal.summary}
          </div>
          <div className="mt-1 text-xs text-muted">
            {signal.timeframe || "Use 5-minute acceptance and 15-minute structure for follow-through."}
          </div>

          <div className="mt-4 grid min-w-0 gap-3 md:grid-cols-3">
            <LevelBox title="Trigger" value={signal.trigger} tone="loss" />
            <LevelBox title="Confirmation" value={signal.confirmation} tone="warning" />
            <LevelBox title="Invalidation" value={signal.invalidation} tone="neutral" />
          </div>
        </div>

        <div className="min-w-0 bg-page-bg/45 p-4">
          <div className="flex items-start justify-between gap-3">
            <div>
              <div className="text-xs font-bold uppercase tracking-wide text-muted">Capture Score</div>
              <div className="mt-1 font-mono text-2xl font-bold text-text-heading">{signal.score}</div>
            </div>
            <div className="text-right text-xs text-muted">
              <div>Confidence</div>
              <div className="font-mono text-base font-bold text-text-heading">{confidence}%</div>
            </div>
          </div>
          <div className="mt-3 h-2 overflow-hidden rounded-full bg-card-border/60">
            <div className={cn("h-full rounded-full", tone.bar)} style={{ width: `${confidence}%` }} />
          </div>

          <div className="mt-4 grid grid-cols-2 gap-2 text-xs">
            <Metric label="Spot" value={formatLevel(signal.levels?.spot)} />
            <Metric label="Wall" value={formatLevel(signal.levels?.breakdown)} />
            <Metric label="CE build" value={signal.metrics?.ceBuildText || "-"} />
            <Metric label="PE build" value={signal.metrics?.peBuildText || "-"} />
            <Metric label="PCR" value={signal.metrics?.pcr ? signal.metrics.pcr.toFixed(2) : "-"} />
            <Metric label="Move" value={formatSigned(signal.metrics?.changePts, " pts")} />
          </div>
        </div>
      </div>

      <div className="grid min-w-0 gap-px bg-card-border lg:grid-cols-[1fr_280px]">
        <div className="min-w-0 bg-card px-4 py-3">
          <div className="grid min-w-0 gap-2 md:grid-cols-5">
            {checks.slice(0, 5).map((check) => (
              <div key={check.label} className="flex min-w-0 items-start gap-2 rounded-lg border border-card-border bg-page-bg px-2 py-2">
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
        </div>
        <div className="min-w-0 bg-card px-4 py-3">
          <div className="text-[11px] font-bold uppercase tracking-wide text-muted">Risk Read</div>
          <div className="mt-1 line-clamp-2 text-xs text-muted">
            {warnings.length > 0 ? warnings.slice(0, 2).join(" ") : "No extra fall-capture warnings."}
          </div>
        </div>
      </div>
    </div>
  );
}

function LevelBox({ title, value, tone }: { title: string; value: string; tone: "loss" | "warning" | "neutral" }) {
  return (
    <div
      className={cn(
        "min-w-0 rounded-lg border px-3 py-3",
        tone === "loss" && "border-loss/30 bg-loss-bg text-loss",
        tone === "warning" && "border-warning/30 bg-warning/10 text-warning",
        tone === "neutral" && "border-card-border bg-page-bg text-text-heading",
      )}
    >
      <div className="text-[10px] font-bold uppercase tracking-wide opacity-80">{title}</div>
      <div className="mt-1 line-clamp-2 text-sm font-semibold leading-snug" title={value}>
        {value}
      </div>
    </div>
  );
}

function Metric({ label, value }: { label: string; value: string }) {
  return (
    <div className="min-w-0 rounded-md border border-card-border bg-card px-2 py-2">
      <div className="text-[10px] font-bold uppercase tracking-wide text-muted">{label}</div>
      <div className="truncate font-mono text-xs font-bold text-text-heading" title={value}>
        {value}
      </div>
    </div>
  );
}
