"use client";

import { useEffect, useMemo, useState } from "react";
import { Activity, Clock3, TrendingDown, TrendingUp } from "lucide-react";
import {
  Area,
  AreaChart,
  CartesianGrid,
  ComposedChart,
  Legend,
  Line,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import { fetchAPI } from "../../lib/api";
import { cn, formatNumber } from "../../lib/utils";
import { StrikeScopeToggle } from "./StrikeScopeToggle";
import { getAtmWindow, type StrikeScope } from "./strikeScope";

interface OptionLeg {
  oi?: number | null;
  oiChange?: number | null;
}

interface Strike {
  strike: number;
  call?: OptionLeg | null;
  put?: OptionLeg | null;
}

interface OIHistoryPoint {
  bucketAt: string;
  capturedAt: string;
  strike: number;
  spot: number;
  spotChangePct: number;
  callOi: number;
  putOi: number;
  totalOi: number;
  callOiChange: number;
  putOiChange: number;
  totalOiChange: number;
  netOi: number;
  netOiChange: number;
  pcr: number | null;
  callLtp: number | null;
  putLtp: number | null;
  callLtpChangePct: number;
  putLtpChangePct: number;
  callAction: string;
  putAction: string;
  direction: "BULLISH" | "BEARISH" | "NEUTRAL";
  label: string;
  reason: string;
  source: string;
}

interface OIHistorySnapshot {
  bucketAt: string;
  overall: OIHistoryPoint | null;
  strike: OIHistoryPoint | null;
}

interface OIHistoryResponse {
  success: boolean;
  enabled: boolean;
  expiry: string;
  requestedExpiry: string;
  sessionDate: string | null;
  intervalMinutes: number;
  storage: "redis" | "supabase";
  snapshots: OIHistorySnapshot[];
}

interface Props {
  indexKey: string;
  expiry: string;
  chain: Strike[];
  spot: number;
}

interface ChartPoint {
  bucketAt: string;
  time: string;
  callChange: number;
  putChange: number;
  spot: number;
  pcr: number | null;
}

const HISTORY_LIMIT = 96;
const HISTORY_REFRESH_MS = 5 * 60 * 1000;

function formatOI(value: number, signed = true): string {
  const sign = signed && value > 0 ? "+" : "";
  const absolute = Math.abs(value);
  if (absolute >= 10_000_000) return `${sign}${(value / 10_000_000).toFixed(2)}Cr`;
  if (absolute >= 100_000) return `${sign}${(value / 100_000).toFixed(1)}L`;
  if (absolute >= 1_000) return `${sign}${(value / 1_000).toFixed(1)}K`;
  return `${sign}${Math.round(value)}`;
}

function formatTime(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "-";
  return new Intl.DateTimeFormat("en-IN", {
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
    timeZone: "Asia/Kolkata",
  }).format(date);
}

function formatSessionDate(value?: string | null): string {
  if (!value) return "Latest session";
  const date = new Date(`${value}T00:00:00+05:30`);
  return new Intl.DateTimeFormat("en-IN", { day: "numeric", month: "short", year: "numeric" }).format(date);
}

function formatExpiry(value?: string | null): string {
  if (!value) return "";
  const parsed = new Date(`${value}T00:00:00+05:30`);
  if (Number.isNaN(parsed.getTime())) return value;
  return new Intl.DateTimeFormat("en-IN", { day: "numeric", month: "short" }).format(parsed);
}

function changeTone(value: number, positiveTone: "profit" | "loss"): string {
  if (value === 0) return "text-muted";
  const positive = positiveTone === "profit" ? "text-profit" : "text-loss";
  const negative = positiveTone === "profit" ? "text-loss" : "text-profit";
  return value > 0 ? positive : negative;
}

function HistoryTable({ rows, emptyText }: { rows: OIHistoryPoint[]; emptyText: string }) {
  if (!rows.length) return <div className="px-4 py-8 text-center text-sm text-muted">{emptyText}</div>;
  return <div className="max-h-[360px] overflow-auto">
    <table className="w-full min-w-[680px] text-left text-xs">
      <thead className="sticky top-0 z-10 bg-card text-[10px] uppercase tracking-wide text-muted">
        <tr className="border-b border-card-border/60"><th className="px-3 py-2 font-bold">Time</th><th className="px-3 py-2 font-bold">OI level</th><th className="px-3 py-2 font-bold">5M change</th><th className="px-3 py-2 font-bold">Read</th><th className="px-3 py-2 font-bold">Evidence</th></tr>
      </thead>
      <tbody className="divide-y divide-card-border/50">{rows.map((row) => <tr key={`${row.bucketAt}-${row.strike}`} className="align-top hover:bg-hover-bg">
        <td className="whitespace-nowrap px-3 py-3 font-mono font-bold text-foreground">{formatTime(row.bucketAt)}</td>
        <td className="whitespace-nowrap px-3 py-3 font-mono"><div className="text-loss">CE {formatOI(row.callOi, false)}</div><div className="mt-1 text-profit">PE {formatOI(row.putOi, false)}</div></td>
        <td className="whitespace-nowrap px-3 py-3 font-mono"><div className={changeTone(row.callOiChange, "loss")}>CE {formatOI(row.callOiChange)}</div><div className={cn("mt-1", changeTone(row.putOiChange, "profit"))}>PE {formatOI(row.putOiChange)}</div></td>
        <td className="px-3 py-3"><span className={cn("inline-flex rounded px-2 py-1 text-[10px] font-black", row.direction === "BULLISH" ? "bg-profit-bg text-profit" : row.direction === "BEARISH" ? "bg-loss-bg text-loss" : "bg-surface-hover text-muted")}>{row.label}</span></td>
        <td className="max-w-[380px] px-3 py-3 leading-relaxed text-muted">{row.reason}</td>
      </tr>)}</tbody>
    </table>
  </div>;
}

function LevelStack({ title, levels, tone }: { title: string; levels: Array<{ strike: number; oi: number }>; tone: "loss" | "profit" }) {
  return <div className="rounded-xl bg-card p-4 shadow-sm"><div className="flex items-center justify-between"><div className="text-[10px] font-black uppercase tracking-[0.14em] text-muted">{title}</div><div className={cn("text-[10px] font-bold", tone === "loss" ? "text-loss" : "text-profit")}>{tone === "loss" ? "Call wall" : "Put wall"}</div></div><div className="mt-3 grid grid-cols-3 gap-2">{levels.map((level, index) => <div key={level.strike} className={cn("rounded-lg px-3 py-2", index === 0 ? tone === "loss" ? "bg-loss-bg" : "bg-profit-bg" : "bg-surface-hover/70")}><div className={cn("text-[10px] font-black", tone === "loss" ? "text-loss" : "text-profit")}>{tone === "loss" ? "R" : "S"}{index + 1}</div><div className="mt-1 font-mono text-sm font-black text-text-heading">{formatNumber(level.strike, 0)}</div><div className="mt-0.5 text-[10px] text-muted">{formatOI(level.oi, false)} OI</div></div>)}</div></div>;
}

export function OIHistoryPanel({ indexKey, expiry, chain, spot }: Props) {
  const strikes = useMemo(() => [...new Set(chain.map((row) => Number(row.strike)).filter((strike) => strike > 0))].sort((a, b) => a - b), [chain]);
  const atmStrike = useMemo(() => strikes.reduce((best, strike) => Math.abs(strike - spot) < Math.abs(best - spot) ? strike : best, strikes[0] || 0), [spot, strikes]);
  const [scope, setScope] = useState<StrikeScope>("near");
  const visibleStrikes = useMemo(
    () => scope === "all" ? strikes : getAtmWindow(strikes.map((strike) => ({ strike })), spot, 5).map((row) => row.strike),
    [scope, spot, strikes],
  );
  const [selectedStrike, setSelectedStrike] = useState(atmStrike);
  const [history, setHistory] = useState<OIHistoryResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!strikes.includes(selectedStrike)) setSelectedStrike(atmStrike);
  }, [atmStrike, selectedStrike, strikes]);

  useEffect(() => {
    if (scope === "near" && !visibleStrikes.includes(selectedStrike)) setSelectedStrike(atmStrike);
  }, [atmStrike, scope, selectedStrike, visibleStrikes]);

  useEffect(() => {
    if (!indexKey || !expiry || !selectedStrike || !strikes.includes(selectedStrike)) return;
    let cancelled = false;
    const load = async (background = false) => {
      if (!background) setLoading(true);
      try {
        const query = new URLSearchParams({ expiry, strike: String(selectedStrike), limit: String(HISTORY_LIMIT) });
        const response = await fetchAPI<OIHistoryResponse>(`/api/options/${indexKey}/oi-history?${query.toString()}`);
        if (!cancelled) { setHistory(response); setError(null); }
      } catch {
        if (!cancelled) setError("OI Change is temporarily unavailable. The live OI Clock is unaffected.");
      } finally {
        if (!cancelled) setLoading(false);
      }
    };
    void load();
    const timer = window.setInterval(() => void load(true), HISTORY_REFRESH_MS);
    return () => { cancelled = true; window.clearInterval(timer); };
  }, [expiry, indexKey, selectedStrike, strikes]);

  const snapshots = history?.snapshots || [];
  const overallRows = snapshots.flatMap((snapshot) => snapshot.overall ? [snapshot.overall] : []);
  const strikeRows = [...snapshots].reverse().flatMap((snapshot) => snapshot.strike ? [snapshot.strike] : []);
  const chartData = useMemo(() => {
    let callChange = 0;
    let putChange = 0;
    return overallRows.map<ChartPoint>((row) => {
      callChange += row.callOiChange;
      putChange += row.putOiChange;
      return { bucketAt: row.bucketAt, time: formatTime(row.bucketAt), callChange, putChange, spot: row.spot, pcr: row.pcr };
    });
  }, [overallRows]);
  const latest = chartData[chartData.length - 1];
  const net = (latest?.putChange || 0) - (latest?.callChange || 0);
  const supports = useMemo(() => chain.filter((row) => row.strike <= spot).map((row) => ({ strike: row.strike, oi: row.put?.oi || 0 })).sort((a, b) => b.oi - a.oi).slice(0, 3), [chain, spot]);
  const resistances = useMemo(() => chain.filter((row) => row.strike >= spot).map((row) => ({ strike: row.strike, oi: row.call?.oi || 0 })).sort((a, b) => b.oi - a.oi).slice(0, 3), [chain, spot]);
  const emptyText = history?.enabled ? "The first comparison appears after two five-minute captures." : "OI history capture is not enabled for this environment.";

  if (loading && !history) return <div className="space-y-4" aria-live="polite"><div className="h-24 animate-pulse rounded-xl bg-card shadow-sm motion-reduce:animate-none" /><div className="h-[420px] animate-pulse rounded-xl bg-card shadow-sm motion-reduce:animate-none" /></div>;

  return <section className="min-w-0 space-y-4" aria-labelledby="oi-change-title">
    <div className="flex flex-col gap-3 rounded-xl bg-card p-4 shadow-sm lg:flex-row lg:items-center lg:justify-between"><div><div className="flex items-center gap-2"><Activity size={17} className="text-accent" /><h3 id="oi-change-title" className="text-base font-black text-text-heading">OI Change</h3></div><p className="mt-1 max-w-3xl text-xs leading-relaxed text-muted">Session buildup from stored {history?.intervalMinutes || 5}-minute snapshots. CE reflects resistance pressure; PE reflects support pressure.</p></div><div className="flex flex-wrap items-center gap-2 text-xs"><span className="rounded bg-surface-hover px-2.5 py-1.5 font-semibold text-muted">{formatSessionDate(history?.sessionDate)}</span>{history?.expiry && <span className="rounded bg-surface-hover px-2.5 py-1.5 font-semibold text-muted">Expiry {formatExpiry(history.expiry)}</span>}<span className="rounded bg-accent-bg px-2.5 py-1.5 font-semibold text-accent">{snapshots.length} snapshots</span><span className="rounded bg-surface-hover px-2.5 py-1.5 font-semibold text-muted">{history?.storage === "supabase" ? "Durable history" : "Session cache"}</span></div></div>

    <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4"><div className="rounded-xl bg-card p-4 shadow-sm"><div className="text-[10px] font-black uppercase tracking-[0.14em] text-muted">Call OI change</div><div className="mt-2 font-mono text-xl font-black text-loss">{formatOI(latest?.callChange || 0)}</div><div className="mt-1 text-xs text-muted">Resistance added since baseline</div></div><div className="rounded-xl bg-card p-4 shadow-sm"><div className="text-[10px] font-black uppercase tracking-[0.14em] text-muted">Put OI change</div><div className="mt-2 font-mono text-xl font-black text-profit">{formatOI(latest?.putChange || 0)}</div><div className="mt-1 text-xs text-muted">Support added since baseline</div></div><div className="rounded-xl bg-card p-4 shadow-sm"><div className="text-[10px] font-black uppercase tracking-[0.14em] text-muted">PCR trend</div><div className="mt-2 font-mono text-xl font-black text-text-heading">{latest?.pcr?.toFixed(2) ?? "—"}</div><div className="mt-1 text-xs text-muted">Latest stored OI ratio</div></div><div className="rounded-xl bg-card p-4 shadow-sm"><div className="text-[10px] font-black uppercase tracking-[0.14em] text-muted">Session read</div><div className={cn("mt-2 flex items-center gap-2 text-sm font-black", net > 0 ? "text-profit" : net < 0 ? "text-loss" : "text-muted")}>{net > 0 ? <TrendingUp size={17} /> : net < 0 ? <TrendingDown size={17} /> : <Clock3 size={17} />}{net > 0 ? "Support leads" : net < 0 ? "Resistance leads" : "Balanced"}</div><div className="mt-1 text-xs text-muted">PE minus CE: {formatOI(net)}</div></div></div>

    {chartData.length >= 2 ? <div className="min-w-0 rounded-xl bg-card p-4 shadow-sm"><div className="mb-4 flex flex-wrap items-start justify-between gap-3"><div><h4 className="text-sm font-black text-text-heading">Session OI buildup</h4><p className="mt-1 text-xs text-muted">Cumulative change from the first stored snapshot, with spot on the right scale.</p></div><div className="text-xs text-muted">Hover the chart for exact values</div></div><div className="h-[390px] min-w-0 w-full" role="img" aria-label={`Session chart with call OI change ${formatOI(latest?.callChange || 0)}, put OI change ${formatOI(latest?.putChange || 0)}, and spot ${formatNumber(latest?.spot || spot)}`}><ResponsiveContainer width="100%" height="100%" minWidth={0} initialDimension={{ width: 800, height: 390 }}><ComposedChart data={chartData} margin={{ top: 8, right: 8, left: 8, bottom: 0 }}><CartesianGrid stroke="var(--card-border)" strokeDasharray="3 5" vertical={false} /><XAxis dataKey="time" minTickGap={34} tick={{ fill: "var(--muted)", fontSize: 11 }} axisLine={false} tickLine={false} /><YAxis yAxisId="oi" tickFormatter={(value) => formatOI(Number(value))} width={62} tick={{ fill: "var(--muted)", fontSize: 10 }} axisLine={false} tickLine={false} /><YAxis yAxisId="spot" orientation="right" domain={["auto", "auto"]} tickFormatter={(value) => formatNumber(value, 0)} width={64} tick={{ fill: "var(--muted)", fontSize: 10 }} axisLine={false} tickLine={false} /><Tooltip contentStyle={{ border: "0", borderRadius: 10, boxShadow: "0 10px 30px rgba(15,23,42,.14)", background: "var(--card)" }} formatter={(value, name) => [name === "Spot" ? formatNumber(Number(value)) : formatOI(Number(value)), name]} labelFormatter={(label) => `${label} IST`} /><Legend iconType="plainline" wrapperStyle={{ fontSize: 11, paddingTop: 10 }} /><Line yAxisId="oi" type="monotone" dataKey="callChange" name="Call OI change" stroke="var(--loss)" strokeWidth={2.5} dot={false} activeDot={{ r: 4 }} /><Line yAxisId="oi" type="monotone" dataKey="putChange" name="Put OI change" stroke="var(--profit)" strokeWidth={2.5} dot={false} activeDot={{ r: 4 }} /><Line yAxisId="spot" type="monotone" dataKey="spot" name="Spot" stroke="var(--muted)" strokeWidth={1.4} strokeDasharray="4 4" dot={false} /></ComposedChart></ResponsiveContainer></div></div> : <div className="rounded-xl bg-card px-6 py-14 text-center shadow-sm"><Clock3 className="mx-auto text-muted" size={22} /><h4 className="mt-3 font-black text-text-heading">OI Change is building</h4><p className="mt-2 text-sm text-muted">{emptyText}</p></div>}

    <div className="grid min-w-0 gap-4 xl:grid-cols-[1.2fr_0.8fr]"><div className="min-w-0 rounded-xl bg-card p-4 shadow-sm"><div className="mb-3"><h4 className="text-sm font-black text-text-heading">PCR session trend</h4><p className="mt-1 text-xs text-muted">Stored put-call ratio across the latest session.</p></div><div className="h-[210px] min-w-0" role="img" aria-label={`PCR trend ending at ${latest?.pcr?.toFixed(2) ?? "unavailable"}`}><ResponsiveContainer width="100%" height="100%" minWidth={0} initialDimension={{ width: 640, height: 210 }}><AreaChart data={chartData}><defs><linearGradient id="pcrFill" x1="0" y1="0" x2="0" y2="1"><stop offset="0%" stopColor="var(--accent)" stopOpacity={0.3} /><stop offset="100%" stopColor="var(--accent)" stopOpacity={0.02} /></linearGradient></defs><CartesianGrid stroke="var(--card-border)" strokeDasharray="3 5" vertical={false} /><XAxis dataKey="time" minTickGap={36} tick={{ fill: "var(--muted)", fontSize: 10 }} axisLine={false} tickLine={false} /><YAxis domain={["auto", "auto"]} width={38} tick={{ fill: "var(--muted)", fontSize: 10 }} axisLine={false} tickLine={false} /><Tooltip contentStyle={{ border: "0", borderRadius: 10, boxShadow: "0 10px 30px rgba(15,23,42,.14)", background: "var(--card)" }} formatter={(value) => [Number(value).toFixed(2), "PCR"]} /><Area type="monotone" dataKey="pcr" name="PCR" stroke="var(--accent)" strokeWidth={2.3} fill="url(#pcrFill)" connectNulls /></AreaChart></ResponsiveContainer></div></div><div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-1"><LevelStack title="Resistance levels" levels={resistances} tone="loss" /><LevelStack title="Support levels" levels={supports} tone="profit" /></div></div>

    <div className="overflow-hidden rounded-xl bg-card shadow-sm"><div className="flex min-h-16 flex-wrap items-center justify-between gap-3 border-b border-card-border/60 px-4 py-3"><div><h4 className="text-sm font-black text-text-heading">Strike drill-down</h4><p className="mt-0.5 text-xs text-muted">Review the five-minute evidence for one captured strike.</p></div><div className="flex flex-wrap items-center gap-2"><StrikeScopeToggle value={scope} onChange={setScope} total={strikes.length} compact /><label className="flex items-center gap-2 text-xs font-semibold text-muted">Strike<select value={selectedStrike || ""} onChange={(event) => setSelectedStrike(Number(event.target.value))} className="min-h-11 cursor-pointer rounded-lg border border-card-border bg-page-bg px-3 font-mono text-sm font-bold text-foreground outline-none focus:border-accent focus:ring-2 focus:ring-accent/20">{visibleStrikes.map((strike) => <option key={strike} value={strike}>{strike}{strike === atmStrike ? " · ATM" : ""}</option>)}</select></label></div></div><HistoryTable rows={strikeRows} emptyText={emptyText} />{error && <div className="border-t border-warning/30 bg-warning/10 px-4 py-3 text-xs text-warning" role="status">{error}</div>}</div>
  </section>;
}
