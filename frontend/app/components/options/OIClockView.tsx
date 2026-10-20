"use client";

import { useMemo, useState } from "react";
import { cn, formatNumber } from "../../lib/utils";
import { StrikeScopeToggle } from "./StrikeScopeToggle";
import { getAtmStrike, getAtmWindow, type StrikeScope } from "./strikeScope";

interface Strike {
  strike: number;
  call: { oi: number; oiChange: number; volume: number; ltp: number; bidQty?: number; askQty?: number } | null;
  put: { oi: number; oiChange: number; volume: number; ltp: number; bidQty?: number; askQty?: number } | null;
}

interface Props {
  chain: Strike[];
  spot: number;
  strikeStep: number;
  expiry?: string;
  timestamp?: string;
  isLive?: boolean;
  chartContext?: {
    timeframe?: string;
    open?: number;
    high?: number;
    low?: number;
    close?: number;
    vwap?: number;
    changePct?: number;
    recentHigh?: number;
    recentLow?: number;
    trend?: "UP" | "DOWN" | "SIDEWAYS";
  };
  analytics: {
    pcr: number;
    pcrSentiment: string;
    totalCallOI: number;
    totalPutOI: number;
    maxPainStrike: number;
    resistance?: number[];
    support?: number[];
    topOICalls?: number[];
    topOIPuts?: number[];
  };
}

function formatOI(v: number): string {
  if (Math.abs(v) >= 10000000) return `${(v / 10000000).toFixed(1)}Cr`;
  if (Math.abs(v) >= 100000) return `${(v / 100000).toFixed(1)}L`;
  if (Math.abs(v) >= 1000) return `${(v / 1000).toFixed(1)}K`;
  return String(Math.round(v));
}

function clampScore(value: number): number {
  return Math.max(0, Math.min(100, Math.round(value)));
}

function nearestAbove(levels: number[], spot: number): number | undefined {
  return [...levels].filter((level) => level >= spot).sort((a, b) => Math.abs(a - spot) - Math.abs(b - spot))[0];
}

function nearestBelow(levels: number[], spot: number): number | undefined {
  return [...levels].filter((level) => level <= spot).sort((a, b) => Math.abs(a - spot) - Math.abs(b - spot))[0];
}

function pctDistance(level: number | undefined, spot: number): number {
  if (!level || !spot) return 99;
  return Math.abs(level - spot) / spot * 100;
}

function decisionWall(
  chain: Strike[],
  spot: number,
  strikeStep: number,
  side: "call" | "put",
): number | undefined {
  const rows = chain
    .filter((row) => (side === "call" ? row.strike >= spot : row.strike <= spot))
    .filter((row) => Math.abs(row.strike - spot) <= strikeStep * 8)
    .map((row) => {
      const leg = side === "call" ? row.call : row.put;
      return {
        strike: row.strike,
        oi: leg?.oi || 0,
        oiChange: Math.max(0, leg?.oiChange || 0),
        distanceSteps: Math.abs(row.strike - spot) / Math.max(strikeStep, 1),
      };
    })
    .filter((row) => row.oi > 0);

  if (!rows.length) return undefined;

  const maxOi = Math.max(...rows.map((row) => row.oi), 1);
  const maxOiChange = Math.max(...rows.map((row) => row.oiChange), 1);
  const qualified = rows.filter((row) => row.distanceSteps <= 3 || row.oi >= maxOi * 0.18 || row.oiChange >= maxOiChange * 0.25);
  const source = qualified.length ? qualified : rows;

  return source
    .map((row) => ({
      ...row,
      score: (row.oi / maxOi) * 55 + (row.oiChange / maxOiChange) * 25 - row.distanceSteps * 7,
    }))
    .sort((a, b) => b.score - a.score || a.distanceSteps - b.distanceSteps)[0]?.strike;
}

export function OIClockView({ chain, spot, strikeStep, expiry, timestamp, isLive = false, chartContext, analytics }: Props) {
  const [scope, setScope] = useState<StrikeScope>("near");
  const resistanceLevels = useMemo(() => analytics.resistance ?? analytics.topOICalls ?? [], [analytics.resistance, analytics.topOICalls]);
  const supportLevels = useMemo(() => analytics.support ?? analytics.topOIPuts ?? [], [analytics.support, analytics.topOIPuts]);

  const filteredChain = useMemo(() => {
    const sorted = [...chain].sort((a, b) => a.strike - b.strike);
    const rows = scope === "all" ? sorted : getAtmWindow(sorted, spot, 5);
    return [...rows].sort((a, b) => a.strike - b.strike);
  }, [chain, scope, spot]);

  // Max OI for scaling bars
  const maxOI = useMemo(() => {
    let max = 1;
    for (const s of filteredChain) {
      if (s.call?.oi && s.call.oi > max) max = s.call.oi;
      if (s.put?.oi && s.put.oi > max) max = s.put.oi;
    }
    return max;
  }, [filteredChain]);

  // Net OI changes for the position chart
  const totalBullsOIChange = filteredChain.reduce((s, r) => s + (r.put?.oiChange || 0), 0);
  const totalBearsOIChange = filteredChain.reduce((s, r) => s + (r.call?.oiChange || 0), 0);
  const maxChangeForBar = Math.max(Math.abs(totalBullsOIChange), Math.abs(totalBearsOIChange), 1);

  // Distribution
  const totalCallOI = analytics.totalCallOI;
  const totalPutOI = analytics.totalPutOI;
  const totalOI = totalCallOI + totalPutOI;
  const bullsPct = totalOI > 0 ? (totalPutOI / totalOI) * 100 : 50;
  const bearsPct = 100 - bullsPct;

  // ATM strike for highlighting
  const atmStrike = getAtmStrike(chain, spot);

  const largeOiResistance = useMemo(() => {
    return nearestAbove(resistanceLevels, spot);
  }, [resistanceLevels, spot]);

  const largeOiSupport = useMemo(() => {
    return nearestBelow(supportLevels, spot);
  }, [supportLevels, spot]);

  const nearestResistance = useMemo(() => {
    return decisionWall(chain, spot, strikeStep, "call") ?? largeOiResistance;
  }, [chain, largeOiResistance, spot, strikeStep]);

  const nearestSupport = useMemo(() => {
    return decisionWall(chain, spot, strikeStep, "put") ?? largeOiSupport;
  }, [chain, largeOiSupport, spot, strikeStep]);

  const trendRead = useMemo(() => {
    const pcr = analytics.pcr || 0;
    const callOiShare = totalOI > 0 ? totalCallOI / totalOI : 0.5;
    const oiChangeNet = totalBullsOIChange - totalBearsOIChange;
    const maxPainDistancePct = analytics.maxPainStrike ? ((spot - analytics.maxPainStrike) / spot) * 100 : 0;
    const chartChangePct = chartContext?.changePct;
    const chartTrend = chartContext?.trend || "SIDEWAYS";
    const aboveVwap = chartContext?.vwap && chartContext.close ? chartContext.close >= chartContext.vwap : undefined;
    const nearResistance = pctDistance(nearestResistance, spot) <= 0.35;
    const nearSupport = pctDistance(nearestSupport, spot) <= 0.35;

    let score = 50;
    const drivers: string[] = [];

    if (pcr < 0.7) {
      score -= 18;
      drivers.push(`PCR ${pcr.toFixed(2)}: call writers dominate`);
    } else if (pcr < 0.9) {
      score -= 9;
      drivers.push(`PCR ${pcr.toFixed(2)}: mild call-writer edge`);
    } else if (pcr > 1.3) {
      score += 18;
      drivers.push(`PCR ${pcr.toFixed(2)}: put writers dominate`);
    } else if (pcr > 1.1) {
      score += 9;
      drivers.push(`PCR ${pcr.toFixed(2)}: mild put-writer edge`);
    }

    if (oiChangeNet < 0) {
      score -= Math.min(16, Math.abs(oiChangeNet) / 1000000);
      drivers.push("fresh call OI is heavier than put OI");
    } else if (oiChangeNet > 0) {
      score += Math.min(16, Math.abs(oiChangeNet) / 1000000);
      drivers.push("fresh put OI is heavier than call OI");
    }

    if (callOiShare >= 0.62) {
      score -= 8;
      drivers.push(`${Math.round(callOiShare * 100)}% of total OI is on calls`);
    } else if (callOiShare <= 0.42) {
      score += 8;
      drivers.push(`${Math.round((1 - callOiShare) * 100)}% of total OI is on puts`);
    }

    if (analytics.maxPainStrike && maxPainDistancePct < -0.35) {
      score -= 6;
      drivers.push(`spot is below max pain ${analytics.maxPainStrike}`);
    } else if (analytics.maxPainStrike && maxPainDistancePct > 0.35) {
      score += 6;
      drivers.push(`spot is above max pain ${analytics.maxPainStrike}`);
    }

    if (chartTrend === "DOWN") {
      score -= 12;
      drivers.push(`${chartContext?.timeframe || "chart"} trend is down`);
    } else if (chartTrend === "UP") {
      score += 12;
      drivers.push(`${chartContext?.timeframe || "chart"} trend is up`);
    }

    if (typeof chartChangePct === "number") {
      if (chartChangePct <= -0.35) {
        score -= 6;
        drivers.push(`intraday price is ${chartChangePct.toFixed(2)}% from open`);
      } else if (chartChangePct >= 0.35) {
        score += 6;
        drivers.push(`intraday price is +${chartChangePct.toFixed(2)}% from open`);
      }
    }

    if (aboveVwap === false) {
      score -= 6;
      drivers.push("price is below intraday VWAP");
    } else if (aboveVwap === true) {
      score += 6;
      drivers.push("price is above intraday VWAP");
    }

    if (nearResistance && score < 50) {
      score -= 4;
      drivers.push(`price is near OI resistance ${nearestResistance}`);
    }
    if (nearSupport && score > 50) {
      score += 4;
      drivers.push(`price is near OI support ${nearestSupport}`);
    }

    const finalScore = clampScore(score);
    const bearish = finalScore <= 42;
    const bullish = finalScore >= 58;
    const label = finalScore <= 28 ? "Strong Bearish" : finalScore <= 42 ? "Bearish Pressure" : finalScore >= 72 ? "Strong Bullish" : finalScore >= 58 ? "Bullish Pressure" : "Range / No Clean Edge";
    const tone = bearish ? "text-loss" : bullish ? "text-profit" : "text-warning";
    const bg = bearish ? "bg-loss-bg" : bullish ? "bg-profit-bg" : "bg-warning/10";
    const confirmation = bearish
      ? `Short confirms below ${nearestSupport || chartContext?.recentLow || atmStrike || "-"}`
      : bullish
        ? `Long confirms above ${nearestResistance || chartContext?.recentHigh || atmStrike || "-"}`
        : `Wait for break of ${nearestResistance || "resistance"} or ${nearestSupport || "support"}`;
    const invalidation = bearish
      ? `Bearish view weakens above ${nearestResistance || chartContext?.recentHigh || analytics.maxPainStrike || "-"}`
      : bullish
        ? `Bullish view weakens below ${nearestSupport || chartContext?.recentLow || analytics.maxPainStrike || "-"}`
        : "No directional invalidation until range breaks.";
    const line = bearish
      ? "OI and chart context favour sellers, but avoid chasing inside support. Prefer rejection near resistance or breakdown below support."
      : bullish
        ? "OI and chart context favour buyers. Prefer continuation above resistance or a support hold with fresh put writing."
        : "The stock is inside a decision zone. Wait for OI change and candle close to align before taking direction.";

    return {
      label,
      tone,
      bg,
      score: finalScore,
      line,
      confirmation,
      invalidation,
      drivers: drivers.slice(0, 5),
    };
  }, [
    analytics.maxPainStrike,
    analytics.pcr,
    atmStrike,
    chartContext,
    nearestResistance,
    nearestSupport,
    spot,
    totalBearsOIChange,
    totalBullsOIChange,
    totalCallOI,
    totalOI,
  ]);

  const clockRead = useMemo(() => {
    const pcr = analytics.pcr || 0;
    const netChange = totalBullsOIChange - totalBearsOIChange;
    const nearMaxPain = analytics.maxPainStrike
      ? Math.abs(spot - analytics.maxPainStrike) <= strikeStep
      : false;

    if (nearMaxPain && pcr >= 0.9 && pcr <= 1.15) {
      return {
        bias: "Range / wait",
        tone: "text-warning",
        bg: "bg-warning/10",
        line: "Spot is close to max pain and PCR is balanced. Treat this as a battleground, not a clean target.",
      };
    }

    if (pcr > 1.15 || netChange > 0) {
      return {
        bias: "Bullish if support holds",
        tone: "text-profit",
        bg: "bg-profit-bg",
        line: `Put writers are stronger. Upside needs spot to hold above ${nearestSupport || atmStrike || "-"} and call OI to unwind near ${nearestResistance || analytics.maxPainStrike || "-"}.`,
      };
    }

    if (pcr < 0.9 || netChange < 0) {
      return {
        bias: "Bearish if support breaks",
        tone: "text-loss",
        bg: "bg-loss-bg",
        line: `Call writers are stronger. Downside confirms if spot loses ${nearestSupport || atmStrike || "-"} and put OI starts unwinding.`,
      };
    }

    return {
      bias: "Neutral",
      tone: "text-muted",
      bg: "bg-card-border/20",
      line: "OI is balanced. Wait for a fresh buildup or unwind before taking direction.",
    };
  }, [
    analytics.maxPainStrike,
    analytics.pcr,
    atmStrike,
    nearestResistance,
    nearestSupport,
    spot,
    strikeStep,
    totalBearsOIChange,
    totalBullsOIChange,
  ]);

  const updatedLabel = timestamp
    ? new Date(timestamp).toLocaleTimeString("en-IN", { hour: "2-digit", minute: "2-digit" })
    : "-";

  return (
    <div className="min-w-0 space-y-4">
      <section className="overflow-hidden rounded-xl bg-card shadow-sm">
        <header className="flex flex-wrap items-start justify-between gap-3 border-b border-card-border/60 px-4 py-3">
          <div><h3 className="text-sm font-black text-text-heading">OI Clock</h3><p className="mt-0.5 text-xs text-muted">Calls show resistance on the left; puts show support on the right{expiry ? ` · expiry ${expiry}` : ""}. Depth is shown when supplied by the feed.</p></div>
          <div className="flex items-center gap-3"><span className="flex items-center gap-1.5 text-xs font-bold text-loss"><i className="h-2.5 w-2.5 rounded-sm bg-loss"/>CALLS</span><span className="flex items-center gap-1.5 text-xs font-bold text-profit"><i className="h-2.5 w-2.5 rounded-sm bg-profit"/>PUTS</span><StrikeScopeToggle value={scope} onChange={setScope} total={chain.length} compact /></div>
        </header>
        <div className={cn("overflow-auto", scope === "all" && "max-h-[620px]")}>
          <table className="w-full min-w-[1040px] table-fixed text-xs">
            <thead className="sticky top-0 z-10 bg-surface-hover text-[10px] font-black uppercase tracking-wider text-muted">
              <tr><th className="w-[7%] px-2 py-2 text-right">Price</th><th className="w-[6%] px-2 py-2 text-right">Bid</th><th className="w-[6%] px-2 py-2 text-right">Ask</th><th className="w-[8%] px-2 py-2 text-right">OI Δ</th><th className="w-[16%] px-2 py-2 text-right text-loss">Call OI</th><th className="w-[9%] px-2 py-2 text-center">Strike</th><th className="w-[16%] px-2 py-2 text-left text-profit">Put OI</th><th className="w-[8%] px-2 py-2 text-left">OI Δ</th><th className="w-[7%] px-2 py-2 text-left">Price</th><th className="w-[6%] px-2 py-2 text-left">Bid</th><th className="w-[6%] px-2 py-2 text-left">Ask</th></tr>
            </thead>
            <tbody className="divide-y divide-card-border/50">
              {filteredChain.map((row) => {
                const call = row.call; const put = row.put; const isATM = row.strike === atmStrike; const isMaxPain = row.strike === analytics.maxPainStrike;
                const callWidth = `${Math.max(2, ((call?.oi || 0) / maxOI) * 100)}%`; const putWidth = `${Math.max(2, ((put?.oi || 0) / maxOI) * 100)}%`;
                return <tr key={row.strike} className={cn("h-10 transition-colors hover:bg-hover-bg", isATM && "bg-accent-bg/80")}>
                  <Cell value={formatNumber(call?.ltp || 0)} strong/><Cell value={depth(call?.bidQty)}/><Cell value={depth(call?.askQty)}/><Delta value={call?.oiChange || 0} side="call"/>
                  <td className="relative px-2 py-1.5 text-right"><div className="absolute inset-y-1 right-1 rounded-sm bg-loss/15" style={{width:callWidth}}/><span className="relative font-mono font-black text-loss">{formatOI(call?.oi || 0)}</span></td>
                  <td className={cn("px-2 py-1.5 text-center font-mono text-sm font-black", isATM ? "text-accent" : isMaxPain ? "text-warning" : "text-text-heading")}>{row.strike}{isATM && <span className="ml-1 rounded bg-accent px-1 py-0.5 text-[8px] text-white">ATM</span>}{isMaxPain && !isATM && <span className="ml-1 text-[8px] text-warning">MP</span>}</td>
                  <td className="relative px-2 py-1.5 text-left"><div className="absolute inset-y-1 left-1 rounded-sm bg-profit/15" style={{width:putWidth}}/><span className="relative font-mono font-black text-profit">{formatOI(put?.oi || 0)}</span></td>
                  <Delta value={put?.oiChange || 0} side="put"/><Cell value={formatNumber(put?.ltp || 0)} strong/><Cell value={depth(put?.bidQty)}/><Cell value={depth(put?.askQty)}/>
                </tr>;
              })}
            </tbody>
          </table>
        </div>
        <footer className="flex flex-wrap items-center justify-center gap-x-6 gap-y-1 border-t border-card-border/60 bg-surface-hover/50 px-4 py-2 text-xs"><span>Spot <b className="font-mono text-accent">{formatNumber(spot)}</b></span><span>Max pain <b className="font-mono text-warning">{analytics.maxPainStrike || "—"}</b></span><span>Resistance <b className="font-mono text-loss">{nearestResistance || "—"}</b></span><span>Support <b className="font-mono text-profit">{nearestSupport || "—"}</b></span></footer>
      </section>

      <section className="overflow-hidden rounded-xl bg-card shadow-sm">
        <header className="flex flex-wrap items-center justify-between gap-3 border-b border-card-border/60 px-4 py-3"><div><h3 className="text-sm font-black text-text-heading">Market Read</h3><p className="text-xs text-muted">A compact decision view from price, OI and nearby walls.</p></div><span className={cn("rounded px-2 py-1 text-[10px] font-black", isLive ? "bg-profit-bg text-profit" : "bg-warning/10 text-warning")}>{isLive ? "LIVE" : "LAST SESSION"} · {updatedLabel}</span></header>
        <div className="grid gap-0 lg:grid-cols-[1.15fr_.85fr] lg:divide-x lg:divide-card-border/60">
          <div className="p-4">
            <div className={cn("rounded-lg p-4", trendRead.bg)}><div className="flex items-start justify-between gap-3"><div><div className="text-[10px] font-black uppercase tracking-wider text-muted">Trader verdict</div><div className={cn("mt-1 text-xl font-black", trendRead.tone)}>{trendRead.label}</div></div><div className={cn("font-mono text-3xl font-black", trendRead.tone)}>{trendRead.score}</div></div><p className="mt-2 text-sm leading-6 text-foreground">{trendRead.line}</p></div>
            <div className="mt-3 grid gap-2 sm:grid-cols-2"><Read label="Confirmation" value={trendRead.confirmation} tone="text-profit"/><Read label="Invalidation" value={trendRead.invalidation} tone="text-loss"/></div>
            <div className="mt-3 grid grid-cols-3 gap-2"><Metric label="Resistance" value={nearestResistance || "—"} tone="text-loss"/><Metric label="Support" value={nearestSupport || "—"} tone="text-profit"/><Metric label="Max pain" value={analytics.maxPainStrike || "—"} tone="text-warning"/></div>
            {trendRead.drivers.length > 0 && <div className="mt-3 flex flex-wrap gap-1.5">{trendRead.drivers.map((driver) => <span key={driver} className="rounded bg-surface-hover px-2 py-1 text-[10px] font-semibold text-muted">{driver}</span>)}</div>}
          </div>
          <div className="space-y-4 p-4">
            <div className={cn("rounded-lg p-3", clockRead.bg)}><div className={cn("font-black", clockRead.tone)}>{clockRead.bias}</div><p className="mt-1 text-xs leading-5 text-foreground">{clockRead.line}</p></div>
            <div><div className="mb-2 flex items-center justify-between"><span className="text-xs font-black uppercase tracking-wide text-muted">Net OI change</span><span className="font-mono text-xs text-muted">PCR {analytics.pcr}</span></div><Position label="Put writers · bulls" value={totalBullsOIChange} max={maxChangeForBar} tone="profit"/><Position label="Call writers · bears" value={totalBearsOIChange} max={maxChangeForBar} tone="loss"/></div>
            <div><div className="mb-2 flex justify-between text-xs font-bold"><span className="text-profit">PUT OI {formatOI(totalPutOI)}</span><span className="text-loss">CALL OI {formatOI(totalCallOI)}</span></div><div className="flex h-3 overflow-hidden rounded-full bg-surface-hover"><div className="bg-profit" style={{width:`${bullsPct}%`}}/><div className="bg-loss" style={{width:`${bearsPct}%`}}/></div><div className="mt-1.5 flex justify-between text-[10px] font-semibold text-muted"><span>{bullsPct.toFixed(1)}% support</span><span>{bearsPct.toFixed(1)}% resistance</span></div></div>
          </div>
        </div>
      </section>
    </div>
  );
}

function Cell({ value, strong = false }: { value: string; strong?: boolean }) { return <td className={cn("px-2 py-1.5 text-right font-mono", strong ? "font-bold text-text-heading" : "text-muted")}>{value}</td>; }
function Delta({ value, side }: { value:number; side:"call"|"put" }) { const good = side === "put" ? value >= 0 : value < 0; return <td className={cn("px-2 py-1.5 font-mono font-bold", side === "call" ? "text-right" : "text-left", value === 0 ? "text-muted" : good ? "text-profit" : "text-loss")}>{value > 0 ? "+" : ""}{formatOI(value)}</td>; }
function depth(value?: number) { return value ? formatOI(value) : "—"; }
function Read({label,value,tone}:{label:string;value:string;tone:string}) { return <div className="rounded-lg bg-surface-hover px-3 py-2"><div className="text-[10px] font-black uppercase tracking-wide text-muted">{label}</div><div className={cn("mt-1 text-xs font-bold",tone)}>{value}</div></div>; }
function Metric({label,value,tone}:{label:string;value:number|string;tone:string}) { return <div className="rounded-lg bg-surface-hover px-2 py-2 text-center"><div className="text-[10px] text-muted">{label}</div><div className={cn("mt-1 font-mono text-sm font-black",tone)}>{value}</div></div>; }
function Position({label,value,max,tone}:{label:string;value:number;max:number;tone:"profit"|"loss"}) { return <div className="mb-2"><div className="mb-1 flex justify-between text-xs"><span className={tone === "profit" ? "text-profit" : "text-loss"}>{label}</span><b className="font-mono">{formatOI(value)}</b></div><div className="h-5 overflow-hidden rounded bg-surface-hover"><div className={cn("h-full",tone === "profit" ? "bg-profit" : "bg-loss")} style={{width:`${Math.abs(value)/max*100}%`}}/></div></div>; }
