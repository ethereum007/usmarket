"use client";

import { cn, formatNumber } from "../../lib/utils";

type Level = number | { strike?: number };

interface AnalyticsProps {
  pcr: number;
  pcrSentiment: string;
  maxPainStrike: number;
  maxPainDistance?: number;
  totalCallOI: number;
  totalPutOI: number;
  resistance?: Level[];
  support?: Level[];
  topOICalls?: Level[];
  topOIPuts?: Level[];
  atmIV: number;
}

function formatOILarge(value: number | undefined | null): string {
  if (value == null) return "0";
  const absolute = Math.abs(value);
  if (absolute >= 10_000_000) return `${(value / 10_000_000).toFixed(1)}Cr`;
  if (absolute >= 100_000) return `${(value / 100_000).toFixed(1)}L`;
  if (absolute >= 1_000) return `${(value / 1_000).toFixed(1)}K`;
  return String(value);
}

function normalizeLevels(levels: Level[] | undefined): number[] {
  return (levels || []).map((level) => typeof level === "number" ? level : Number(level.strike || 0)).filter((level) => level > 0).slice(0, 3);
}

function Stat({ label, value, helper, valueClass }: { label: string; value: string; helper?: React.ReactNode; valueClass?: string }) {
  return <div className="min-w-0 px-4 py-3.5"><div className="text-[10px] font-black uppercase tracking-[0.13em] text-muted">{label}</div><div className={cn("mt-1.5 truncate font-mono text-xl font-black text-text-heading", valueClass)}>{value}</div>{helper && <div className="mt-1 text-[11px] text-muted">{helper}</div>}</div>;
}

function LevelGroup({ title, levels, tone }: { title: string; levels: number[]; tone: "loss" | "profit" }) {
  return <div className="px-4 py-3.5"><div className="text-[10px] font-black uppercase tracking-[0.13em] text-muted">{title}</div><div className="mt-2 flex flex-wrap gap-2">{levels.length ? levels.map((level, index) => <div key={level} className={cn("min-w-[94px] rounded-lg px-3 py-2", index === 0 ? tone === "loss" ? "bg-loss-bg" : "bg-profit-bg" : "bg-surface-hover/70")}><div className={cn("text-[10px] font-black", tone === "loss" ? "text-loss" : "text-profit")}>{tone === "loss" ? "R" : "S"}{index + 1}{index === 0 ? " · Primary" : ""}</div><div className="mt-0.5 font-mono text-sm font-black text-text-heading">{formatNumber(level, 0)}</div></div>) : <span className="text-sm text-muted">Levels unavailable</span>}</div></div>;
}

export function OptionsAnalyticsBar({ analytics, spot }: { analytics: AnalyticsProps; spot: number }) {
  const resistance = normalizeLevels(analytics.resistance ?? analytics.topOICalls);
  const support = normalizeLevels(analytics.support ?? analytics.topOIPuts);
  const maxPainDistance = analytics.maxPainDistance ?? (analytics.maxPainStrike ? analytics.maxPainStrike - spot : 0);
  const pcrTone = analytics.pcrSentiment === "BULLISH" ? "text-profit" : analytics.pcrSentiment === "BEARISH" ? "text-loss" : "text-warning";

  return <section className="overflow-hidden rounded-xl bg-card shadow-sm" aria-label="Options positioning summary">
    <div className="grid divide-y divide-card-border/60 sm:grid-cols-2 sm:divide-x xl:grid-cols-4 xl:divide-y-0">
      <Stat label="Spot" value={formatNumber(spot)} helper="Current underlying price" />
      <Stat label="PCR · OI" value={analytics.pcr?.toFixed(2) || "—"} valueClass={pcrTone} helper={<><span className={cn("font-black", pcrTone)}>{analytics.pcrSentiment}</span> · CE {formatOILarge(analytics.totalCallOI)} · PE {formatOILarge(analytics.totalPutOI)}</>} />
      <Stat label="Max pain" value={analytics.maxPainStrike ? formatNumber(analytics.maxPainStrike, 0) : "—"} helper={maxPainDistance ? `${maxPainDistance > 0 ? "+" : ""}${formatNumber(maxPainDistance, 0)} points from spot` : "At spot"} />
      <Stat label="ATM IV" value={analytics.atmIV > 0 ? `${analytics.atmIV}%` : "—"} helper={analytics.atmIV > 0 ? "At-the-money implied volatility" : "Not available from feed"} />
    </div>
    <div className="grid border-t border-card-border/60 sm:grid-cols-2 sm:divide-x sm:divide-card-border/60"><LevelGroup title="Resistance · Call OI walls" levels={resistance} tone="loss" /><LevelGroup title="Support · Put OI walls" levels={support} tone="profit" /></div>
  </section>;
}
