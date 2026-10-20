"use client";

import { cn } from "../../lib/utils";

type DirectionReading = "BULLISH" | "BEARISH" | "SIDEWAYS" | "NO_VIEW" | string;

type DirectionComponent = {
  key: string;
  label: string;
  reading: DirectionReading;
  score: number;
  value: string;
  detail: string;
  tone?: string;
};

type OptionsDirection = {
  direction: DirectionReading;
  confidence: number;
  score: number;
  summary: string;
  components: DirectionComponent[];
  greeks?: {
    atmStrike?: number;
    daysToExpiry?: number;
    callDelta?: number;
    putDelta?: number;
    gamma?: number;
    vega?: number;
    theta?: number;
    callIv?: number | null;
    putIv?: number | null;
  };
  levels?: {
    support?: number[];
    resistance?: number[];
    maxPain?: number | null;
    maxPainDistance?: number | null;
  };
  warnings?: string[];
};

function directionLabel(direction: DirectionReading) {
  if (direction === "NO_VIEW") return "NO VIEW";
  return String(direction || "NO VIEW").replace("_", " ");
}

function directionTone(direction: DirectionReading) {
  switch (direction) {
    case "BULLISH":
      return "border-profit/30 bg-profit-bg text-profit";
    case "BEARISH":
      return "border-loss/30 bg-loss-bg text-loss";
    case "SIDEWAYS":
      return "border-warning/30 bg-warning/10 text-warning";
    default:
      return "border-card-border bg-page-bg text-muted";
  }
}

function meterColor(direction: DirectionReading) {
  switch (direction) {
    case "BULLISH":
      return "bg-profit";
    case "BEARISH":
      return "bg-loss";
    case "SIDEWAYS":
      return "bg-warning";
    default:
      return "bg-muted";
  }
}

function componentTextTone(reading: DirectionReading) {
  switch (reading) {
    case "BULLISH":
      return "text-profit";
    case "BEARISH":
      return "text-loss";
    case "SIDEWAYS":
      return "text-warning";
    default:
      return "text-muted";
  }
}

function formatNumber(value: number | null | undefined, digits = 2) {
  if (typeof value !== "number" || Number.isNaN(value)) return "-";
  return value.toFixed(digits);
}

function formatLevel(value: number | null | undefined) {
  if (typeof value !== "number" || Number.isNaN(value)) return "-";
  return value.toLocaleString("en-IN", { maximumFractionDigits: 0 });
}

export function OptionsDirectionPanel({ direction, name }: { direction?: OptionsDirection | null; name?: string }) {
  if (!direction) return null;

  const greeks = direction.greeks || {};
  const warnings = direction.warnings || [];
  const confidence = Math.max(0, Math.min(100, direction.confidence || 0));

  return (
    <div className="min-w-0 overflow-hidden rounded-xl border border-card-border bg-card">
      <div className="flex flex-col gap-3 border-b border-card-border px-4 py-3 lg:flex-row lg:items-start lg:justify-between">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-xs font-bold uppercase tracking-wide text-muted">Greeks Direction</span>
            {name && <span className="text-xs text-muted">for {name}</span>}
            <span className={cn("rounded-full border px-2 py-0.5 text-[11px] font-bold", directionTone(direction.direction))}>
              {directionLabel(direction.direction)}
            </span>
          </div>
          <div className="mt-1 text-sm font-semibold text-text-heading">{direction.summary}</div>
          <div className="mt-1 text-xs text-muted">
            Direction only. This is not yet a buy/sell-options trigger.
          </div>
        </div>

        <div className="min-w-[180px] shrink-0 rounded-lg border border-card-border bg-page-bg/60 px-3 py-2">
          <div className="flex items-center justify-between text-xs">
            <span className="text-muted">Confidence</span>
            <span className="font-mono font-bold text-text-heading">{confidence}%</span>
          </div>
          <div className="mt-2 h-2 overflow-hidden rounded-full bg-card-border/40">
            <div className={cn("h-full rounded-full", meterColor(direction.direction))} style={{ width: `${confidence}%` }} />
          </div>
          <div className="mt-1 text-[11px] text-muted">Score {formatNumber(direction.score, 1)}</div>
        </div>
      </div>

      <div className="grid min-w-0 grid-cols-2 gap-px bg-card-border lg:grid-cols-7">
        {(direction.components || []).map((item) => (
          <div key={item.key} className="min-w-0 bg-card px-3 py-3">
            <div className="flex items-start justify-between gap-2">
              <div className="min-w-0">
                <div className="text-[11px] font-semibold uppercase tracking-wide text-muted">{item.label}</div>
                <div className="mt-1 truncate text-xs font-mono text-text-heading" title={item.value}>
                  {item.value}
                </div>
              </div>
              <div className={cn("text-[10px] font-bold", componentTextTone(item.reading))}>
                {directionLabel(item.reading)}
              </div>
            </div>
            <div className="mt-2 line-clamp-2 text-[11px] leading-snug text-muted" title={item.detail}>
              {item.detail}
            </div>
          </div>
        ))}
      </div>

      <div className="grid min-w-0 grid-cols-2 gap-px bg-card-border md:grid-cols-4 lg:grid-cols-8">
        <GreekStat label="ATM Strike" value={formatLevel(greeks.atmStrike)} />
        <GreekStat label="Call Delta" value={formatNumber(greeks.callDelta, 2)} />
        <GreekStat label="Put Delta" value={formatNumber(greeks.putDelta, 2)} />
        <GreekStat label="Gamma" value={formatNumber(greeks.gamma, 5)} />
        <GreekStat label="Vega" value={formatNumber(greeks.vega, 2)} />
        <GreekStat label="Theta" value={formatNumber(greeks.theta, 2)} />
        <GreekStat label="Call / Put IV" value={`${formatNumber(greeks.callIv, 1)} / ${formatNumber(greeks.putIv, 1)}`} />
        <GreekStat label="DTE" value={formatNumber(greeks.daysToExpiry, 1)} />
      </div>

      {warnings.length > 0 && (
        <div className="border-t border-card-border bg-warning/10 px-4 py-2 text-xs text-warning">
          {warnings.join(" ")}
        </div>
      )}
    </div>
  );
}

function GreekStat({ label, value }: { label: string; value: string }) {
  return (
    <div className="bg-page-bg/50 px-3 py-2">
      <div className="text-[10px] font-semibold uppercase tracking-wide text-muted">{label}</div>
      <div className="mt-1 font-mono text-xs font-bold text-text-heading">{value}</div>
    </div>
  );
}
