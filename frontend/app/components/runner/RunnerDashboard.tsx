"use client";

import {
  Activity,
  AlertTriangle,
  ArrowRight,
  BarChart3,
  CheckCircle2,
  Clock3,
  Database,
  Gauge,
  Layers3,
  Radio,
  RefreshCw,
  Search,
  ServerCog,
  ShieldCheck,
  SlidersHorizontal,
  TrendingUp,
  X,
} from "lucide-react";
import { FormEvent, useCallback, useEffect, useMemo, useState } from "react";
import { fetchAPI } from "../../lib/api";
import { cn } from "../../lib/utils";
import type {
  BaselineStat,
  RunnerBaselineResponse,
  RunnerFeature,
  RunnerLatestResponse,
  RunnerSort,
  RunnerStatus,
  RunnerRankingResponse,
  ParticipationUniverse,
} from "./types";
import { RunnerRankingPanel } from "./ParticipationShortlist";

const REFRESH_SECONDS = 10;
const SORTS: { value: RunnerSort; label: string }[] = [
  { value: "rvol_tod_20d", label: "RVOL TOD 20D" },
  { value: "rvol_tod_60d", label: "RVOL TOD 60D" },
  { value: "rvol_5m", label: "5m abnormal volume" },
  { value: "volume_acceleration", label: "Volume acceleration" },
  { value: "ret_5m", label: "5m return" },
  { value: "range_tod_ratio", label: "Range expansion" },
  { value: "freshness_seconds", label: "Data age" },
];

const BASELINE_LABELS: Record<string, string> = {
  cumulative_volume: "Cumulative volume",
  volume_1m: "1-minute volume",
  volume_5m: "5-minute volume",
  volume_15m: "15-minute volume",
  cumulative_traded_value: "Cumulative turnover",
  intraday_range: "Intraday range",
  abs_move_prev_close: "Move from prev close",
  abs_move_open: "Move from open",
  return_1m: "1-minute return",
  return_5m: "5-minute return",
  return_15m: "15-minute return",
};

function finite(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function number(value: number | null | undefined, digits = 2): string {
  return finite(value) ? value.toLocaleString("en-IN", { maximumFractionDigits: digits }) : "—";
}

function percent(value: number | null | undefined, digits = 2): string {
  if (!finite(value)) return "—";
  const sign = value > 0 ? "+" : "";
  return `${sign}${value.toFixed(digits)}%`;
}

function ratio(value: number | null | undefined): string {
  return finite(value) ? `${value.toFixed(2)}x` : "—";
}

function compact(value: number | null | undefined): string {
  if (!finite(value)) return "—";
  return Intl.NumberFormat("en-IN", { notation: "compact", maximumFractionDigits: 1 }).format(value);
}

function time(value: string | null | undefined): string {
  if (!value) return "—";
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return "—";
  return parsed.toLocaleTimeString("en-IN", {
    timeZone: "Asia/Kolkata",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
}

function age(value: number | null | undefined): string {
  if (!finite(value)) return "—";
  if (value < 60) return `${Math.round(value)}s`;
  return `${Math.floor(value / 60)}m ${Math.round(value % 60)}s`;
}

function valueTone(value: number | null | undefined) {
  if (!finite(value) || value === 0) return "text-muted";
  return value > 0 ? "text-profit" : "text-loss";
}

function qualityTone(qualities: string[]) {
  if (qualities.length === 1 && qualities[0] === "GOOD") return "border-profit/25 bg-profit-bg text-profit";
  if (qualities.includes("STALE") || qualities.includes("PROVIDER_MISMATCH")) {
    return "border-loss/25 bg-loss-bg text-loss";
  }
  return "border-warning/25 bg-warning/10 text-warning";
}

function MetricCard({
  label,
  value,
  helper,
  icon,
  tone = "neutral",
}: {
  label: string;
  value: string;
  helper: string;
  icon: React.ReactNode;
  tone?: "neutral" | "good" | "warn" | "bad";
}) {
  const toneClass =
    tone === "good"
      ? "border-profit/25 bg-profit-bg/40"
      : tone === "warn"
        ? "border-warning/25 bg-warning/5"
        : tone === "bad"
          ? "border-loss/25 bg-loss-bg/40"
          : "border-card-border bg-card";
  return (
    <div className={cn("min-w-0 rounded-xl border p-4 shadow-sm", toneClass)}>
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="text-[10px] font-black uppercase tracking-[0.14em] text-muted">{label}</div>
          <div className="mt-2 truncate font-mono text-2xl font-black text-text-heading">{value}</div>
          <div className="mt-1 truncate text-xs text-muted" title={helper}>{helper}</div>
        </div>
        <div className="rounded-lg border border-card-border bg-surface-subtle p-2 text-accent">{icon}</div>
      </div>
    </div>
  );
}

function PipelineStep({
  label,
  detail,
  state,
  icon,
}: {
  label: string;
  detail: string;
  state: "good" | "warn" | "idle";
  icon: React.ReactNode;
}) {
  return (
    <div className="flex min-w-[190px] flex-1 items-center gap-3 rounded-xl border border-card-border bg-card px-4 py-3">
      <div className={cn(
        "flex h-9 w-9 shrink-0 items-center justify-center rounded-lg border",
        state === "good" ? "border-profit/25 bg-profit-bg text-profit" : state === "warn" ? "border-warning/25 bg-warning/10 text-warning" : "border-card-border bg-surface-subtle text-muted",
      )}>
        {icon}
      </div>
      <div className="min-w-0">
        <div className="text-[10px] font-black uppercase tracking-[0.12em] text-muted">{label}</div>
        <div className="mt-0.5 truncate text-sm font-bold text-text-heading" title={detail}>{detail}</div>
      </div>
    </div>
  );
}

function Metric({ label, value, tone }: { label: string; value: string; tone?: string }) {
  return (
    <div className="rounded-lg border border-card-border bg-surface-subtle px-3 py-2.5">
      <div className="text-[10px] font-bold uppercase tracking-wide text-muted">{label}</div>
      <div className={cn("mt-1 font-mono text-sm font-bold text-text-heading", tone)}>{value}</div>
    </div>
  );
}

function Flag({ active, children }: { active: boolean | null | undefined; children: React.ReactNode }) {
  return (
    <span className={cn(
      "rounded-md border px-2 py-1 text-[10px] font-black uppercase tracking-wide",
      active === true
        ? "border-profit/30 bg-profit-bg text-profit"
        : active === false
          ? "border-card-border bg-surface-subtle text-muted"
          : "border-dashed border-card-border text-text-tertiary",
    )}>
      {children}
    </span>
  );
}

function StatusBadge({ status }: { status: RunnerStatus }) {
  const good = status.enabled && status.running && status.providerLive;
  const label = !status.enabled ? "Disabled" : !status.running ? "Stopped" : status.providerLive ? "Live" : "Waiting for data";
  return (
    <span className={cn(
      "inline-flex items-center gap-2 rounded-full border px-3 py-1.5 text-xs font-black uppercase tracking-wide",
      good ? "border-profit/30 bg-profit-bg text-profit" : status.enabled ? "border-warning/30 bg-warning/10 text-warning" : "border-card-border bg-surface-subtle text-muted",
    )}>
      <span className={cn("h-2 w-2 rounded-full", good ? "animate-pulse bg-profit" : status.enabled ? "bg-warning" : "bg-muted")} />
      {label}
    </span>
  );
}

function RunnerTable({ features, selected, onSelect }: { features: RunnerFeature[]; selected?: string; onSelect: (feature: RunnerFeature) => void }) {
  return (
    <div className="overflow-x-auto">
      <table className="w-full min-w-[1120px] border-collapse text-left">
        <thead className="sticky top-0 z-10 bg-card">
          <tr className="border-b border-card-border text-[10px] font-black uppercase tracking-[0.12em] text-muted">
            <th className="px-4 py-3">Symbol</th>
            <th className="px-3 py-3 text-right">LTP</th>
            <th className="px-3 py-3 text-right">1m</th>
            <th className="px-3 py-3 text-right">5m</th>
            <th className="px-3 py-3 text-right">RVOL TOD</th>
            <th className="px-3 py-3 text-right">RVOL 5m</th>
            <th className="px-3 py-3 text-right">Acceleration</th>
            <th className="px-3 py-3 text-right">Range</th>
            <th className="px-3 py-3 text-right">VWAP</th>
            <th className="px-3 py-3">Structure</th>
            <th className="px-4 py-3">Quality</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-card-border/60">
          {features.map((feature) => (
            <tr
              key={feature.symbol}
              onClick={() => onSelect(feature)}
              onKeyDown={(event) => {
                if (event.key === "Enter" || event.key === " ") onSelect(feature);
              }}
              role="button"
              tabIndex={0}
              aria-label={`Inspect ${feature.symbol}`}
              className={cn(
                "cursor-pointer outline-none transition-colors hover:bg-surface-hover focus-visible:bg-accent-bg",
                selected === feature.symbol && "bg-accent-bg",
              )}
            >
              <td className="px-4 py-3">
                <div className="font-mono text-sm font-black text-text-heading">{feature.symbol}</div>
                <div className="mt-0.5 text-[10px] text-muted">{feature.sector || feature.exchange}</div>
              </td>
              <td className="px-3 py-3 text-right font-mono text-xs font-bold text-text-heading">{number(feature.ltp)}</td>
              <td className={cn("px-3 py-3 text-right font-mono text-xs font-bold", valueTone(feature.ret_1m))}>{percent(feature.ret_1m)}</td>
              <td className={cn("px-3 py-3 text-right font-mono text-xs font-bold", valueTone(feature.ret_5m))}>{percent(feature.ret_5m)}</td>
              <td className="px-3 py-3 text-right font-mono text-xs font-black text-accent">{ratio(feature.rvol_tod_20d)}</td>
              <td className="px-3 py-3 text-right font-mono text-xs text-text-heading">{ratio(feature.rvol_5m)}</td>
              <td className="px-3 py-3 text-right font-mono text-xs text-text-heading">{ratio(feature.volume_acceleration)}</td>
              <td className="px-3 py-3 text-right font-mono text-xs text-text-heading">{ratio(feature.range_tod_ratio)}</td>
              <td className={cn("px-3 py-3 text-right font-mono text-xs", valueTone(feature.distance_vwap_pct))}>{percent(feature.distance_vwap_pct)}</td>
              <td className="px-3 py-3">
                <div className="flex flex-wrap gap-1">
                  {feature.pdh_break && <Flag active>PDH</Flag>}
                  {feature.pdl_break && <Flag active>PDL</Flag>}
                  {feature.orb15_break_high && <Flag active>ORB15↑</Flag>}
                  {feature.orb15_break_low && <Flag active>ORB15↓</Flag>}
                  {!feature.pdh_break && !feature.pdl_break && !feature.orb15_break_high && !feature.orb15_break_low && <span className="text-[10px] text-text-tertiary">No break</span>}
                </div>
              </td>
              <td className="px-4 py-3">
                <span className={cn("inline-flex rounded-md border px-2 py-1 text-[10px] font-black", qualityTone(feature.data_quality))}>
                  {feature.data_quality.join(" · ") || "UNKNOWN"}
                </span>
                <div className="mt-1 text-[10px] text-muted">{age(feature.freshness_seconds)} old</div>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function FeatureInspector({ feature, baseline, loadingBaseline, onClose }: { feature: RunnerFeature; baseline: RunnerBaselineResponse | null; loadingBaseline: boolean; onClose: () => void }) {
  const baselineGroups = useMemo(() => {
    const groups = new Map<string, BaselineStat[]>();
    for (const stat of baseline?.baselines || []) {
      const group = groups.get(stat.metric) || [];
      group.push(stat);
      groups.set(stat.metric, group);
    }
    return [...groups.entries()];
  }, [baseline]);

  return (
    <aside className="rounded-xl border border-card-border bg-card shadow-[0_18px_70px_rgba(0,0,0,0.18)]">
      <div className="flex items-start justify-between gap-4 border-b border-card-border p-4">
        <div>
          <div className="flex flex-wrap items-center gap-2">
            <h2 className="font-mono text-2xl font-black text-text-heading">{feature.symbol}</h2>
            <span className={cn("rounded-md border px-2 py-1 text-[10px] font-black", qualityTone(feature.data_quality))}>{feature.data_quality.join(" · ") || "UNKNOWN"}</span>
          </div>
          <div className="mt-1 flex flex-wrap items-center gap-3 text-xs text-muted">
            <span>{feature.exchange}</span>
            <span>{feature.sector || "Sector unavailable"}</span>
            <span>Minute {feature.minute_of_session}</span>
            <span>{time(feature.source_timestamp)} IST</span>
          </div>
        </div>
        <button type="button" onClick={onClose} className="flex h-10 w-10 cursor-pointer items-center justify-center rounded-lg border border-card-border text-muted transition hover:bg-surface-hover hover:text-text-heading" aria-label="Close feature inspector">
          <X className="h-4 w-4" />
        </button>
      </div>

      <div className="space-y-5 p-4">
        <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
          <Metric label="LTP" value={`₹${number(feature.ltp)}`} />
          <Metric label="From open" value={percent(feature.ret_from_open)} tone={valueTone(feature.ret_from_open)} />
          <Metric label="From prev close" value={percent(feature.ret_from_prev_close)} tone={valueTone(feature.ret_from_prev_close)} />
          <Metric label="Freshness" value={age(feature.freshness_seconds)} />
        </div>

        <InspectorSection title="Participation entering now" icon={<Activity className="h-4 w-4" />}>
          <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
            <Metric label="RVOL TOD 20D" value={ratio(feature.rvol_tod_20d)} />
            <Metric label="RVOL TOD 60D" value={ratio(feature.rvol_tod_60d)} />
            <Metric label="1m volume" value={ratio(feature.rvol_1m)} />
            <Metric label="3m volume" value={ratio(feature.rvol_3m)} />
            <Metric label="5m volume" value={ratio(feature.rvol_5m)} />
            <Metric label="15m volume" value={ratio(feature.rvol_15m)} />
            <Metric label="Acceleration" value={ratio(feature.volume_acceleration)} />
            <Metric label="Turnover velocity" value={ratio(feature.turnover_velocity)} />
          </div>
        </InspectorSection>

        <InspectorSection title="Price and range normalization" icon={<TrendingUp className="h-4 w-4" />}>
          <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
            <Metric label="Return 1m" value={percent(feature.ret_1m)} tone={valueTone(feature.ret_1m)} />
            <Metric label="Return 5m" value={percent(feature.ret_5m)} tone={valueTone(feature.ret_5m)} />
            <Metric label="Return 15m" value={percent(feature.ret_15m)} tone={valueTone(feature.ret_15m)} />
            <Metric label="Return 30m" value={percent(feature.ret_30m)} tone={valueTone(feature.ret_30m)} />
            <Metric label="Z-score 1m" value={number(feature.return_z_1m)} />
            <Metric label="Z-score 5m" value={number(feature.return_z_5m)} />
            <Metric label="Range TOD" value={ratio(feature.range_tod_ratio)} />
            <Metric label="ATR move" value={ratio(feature.atr_normalized_move)} />
          </div>
        </InspectorSection>

        <InspectorSection title="Trading structure" icon={<Layers3 className="h-4 w-4" />}>
          <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
            <Metric label="VWAP" value={finite(feature.vwap) ? `₹${number(feature.vwap)}` : "—"} />
            <Metric label="VWAP distance" value={percent(feature.distance_vwap_pct)} tone={valueTone(feature.distance_vwap_pct)} />
            <Metric label="PDH distance" value={percent(feature.distance_pdh_pct)} tone={valueTone(feature.distance_pdh_pct)} />
            <Metric label="PDL distance" value={percent(feature.distance_pdl_pct)} tone={valueTone(feature.distance_pdl_pct)} />
          </div>
          <div className="mt-3 flex flex-wrap gap-2">
            <Flag active={feature.above_vwap}>Above VWAP</Flag>
            <Flag active={feature.pdh_break}>PDH break</Flag>
            <Flag active={feature.pdl_break}>PDL break</Flag>
            <Flag active={feature.orb15_break_high}>ORB15 high</Flag>
            <Flag active={feature.orb15_break_low}>ORB15 low</Flag>
            <Flag active={feature.orb30_break_high}>ORB30 high</Flag>
            <Flag active={feature.orb30_break_low}>ORB30 low</Flag>
            <Flag active={feature.at_20d_high}>20D high</Flag>
            <Flag active={feature.at_50d_high}>50D high</Flag>
          </div>
        </InspectorSection>

        <InspectorSection title="Context and existing Alpha Radar inputs" icon={<BarChart3 className="h-4 w-4" />}>
          <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
            <Metric label="Sector return" value={percent(feature.sector_return)} tone={valueTone(feature.sector_return)} />
            <Metric label="Sector vs Nifty" value={percent(feature.sector_relative_strength)} tone={valueTone(feature.sector_relative_strength)} />
            <Metric label="Sector rank" value={feature.sector_rank == null ? "—" : `#${feature.sector_rank}`} />
            <Metric label="Market return" value={percent(feature.market_return)} tone={valueTone(feature.market_return)} />
            <Metric label="Abnormal score" value={number(feature.abnormal_score)} />
            <Metric label="Accumulation" value={number(feature.accumulation_score)} />
            <Metric label="Institutional" value={number(feature.institutional_score)} />
            <Metric label="Market regime" value={feature.market_regime || "—"} />
          </div>
        </InspectorSection>

        <InspectorSection title={`Same-time baseline · minute ${feature.minute_of_session}`} icon={<Database className="h-4 w-4" />}>
          {loadingBaseline ? (
            <div className="flex items-center gap-2 py-5 text-sm text-muted"><RefreshCw className="h-4 w-4 animate-spin" /> Loading baseline diagnostics…</div>
          ) : baselineGroups.length ? (
            <div className="overflow-x-auto rounded-lg border border-card-border">
              <table className="w-full min-w-[620px] text-left text-xs">
                <thead className="bg-surface-subtle text-[10px] font-black uppercase tracking-wide text-muted">
                  <tr><th className="px-3 py-2">Metric</th><th className="px-3 py-2">Lookback</th><th className="px-3 py-2 text-right">Median</th><th className="px-3 py-2 text-right">Mean</th><th className="px-3 py-2 text-right">Std</th><th className="px-3 py-2 text-right">Sessions</th></tr>
                </thead>
                <tbody className="divide-y divide-card-border/60">
                  {baselineGroups.flatMap(([metricName, stats]) => stats.map((stat) => (
                    <tr key={`${metricName}-${stat.lookback_sessions}`}>
                      <td className="px-3 py-2 font-semibold text-text-heading">{BASELINE_LABELS[metricName] || metricName.replaceAll("_", " ")}</td>
                      <td className="px-3 py-2 text-muted">{stat.lookback_sessions} sessions</td>
                      <td className="px-3 py-2 text-right font-mono">{number(stat.median)}</td>
                      <td className="px-3 py-2 text-right font-mono">{number(stat.mean)}</td>
                      <td className="px-3 py-2 text-right font-mono">{number(stat.std)}</td>
                      <td className="px-3 py-2 text-right font-mono">{stat.sample_count}</td>
                    </tr>
                  )))}
                </tbody>
              </table>
            </div>
          ) : (
            <div className="rounded-lg border border-dashed border-warning/35 bg-warning/5 p-4 text-sm text-warning">No same-minute baseline is available for this symbol yet.</div>
          )}
        </InspectorSection>

        <div className="grid grid-cols-2 gap-2 text-xs text-muted sm:grid-cols-4">
          <div><span className="block text-[10px] uppercase">Source</span><span className="mt-1 block font-mono text-foreground">{feature.data_source}</span></div>
          <div><span className="block text-[10px] uppercase">Feature version</span><span className="mt-1 block font-mono text-foreground">{feature.feature_version}</span></div>
          <div><span className="block text-[10px] uppercase">Source time</span><span className="mt-1 block font-mono text-foreground">{time(feature.source_timestamp)} IST</span></div>
          <div><span className="block text-[10px] uppercase">Processed</span><span className="mt-1 block font-mono text-foreground">{time(feature.processing_timestamp)} IST</span></div>
        </div>
      </div>
    </aside>
  );
}

function InspectorSection({ title, icon, children }: { title: string; icon: React.ReactNode; children: React.ReactNode }) {
  return (
    <section>
      <h3 className="mb-2.5 flex items-center gap-2 text-xs font-black uppercase tracking-[0.12em] text-muted">{icon}{title}</h3>
      {children}
    </section>
  );
}

export default function RunnerDashboard() {
  const [status, setStatus] = useState<RunnerStatus | null>(null);
  const [latest, setLatest] = useState<RunnerLatestResponse | null>(null);
  const [rankings, setRankings] = useState<RunnerRankingResponse | null>(null);
  const [selected, setSelected] = useState<RunnerFeature | null>(null);
  const [baseline, setBaseline] = useState<RunnerBaselineResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [loadingBaseline, setLoadingBaseline] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [sort, setSort] = useState<RunnerSort>("rvol_tod_20d");
  const [search, setSearch] = useState("");
  const [autoRefresh, setAutoRefresh] = useState(true);
  const [participationUniverse, setParticipationUniverse] = useState<ParticipationUniverse>("broad");
  const [lastLoadedAt, setLastLoadedAt] = useState<Date | null>(null);

  const load = useCallback(async (background = false) => {
    if (background) setRefreshing(true);
    else setLoading(true);
    try {
      const [statusResponse, latestResponse, rankingResponse] = await Promise.all([
        fetchAPI<RunnerStatus>("/api/runner/status"),
        fetchAPI<RunnerLatestResponse>(`/api/runner/latest?limit=100&sort=${sort}`),
        fetchAPI<RunnerRankingResponse>(`/api/runner/rankings?universe=${participationUniverse}&limit=5`),
      ]);
      setStatus(statusResponse);
      setLatest(latestResponse);
      setRankings(rankingResponse);
      setSelected((current) => current ? latestResponse.features.find((row) => row.symbol === current.symbol) || current : null);
      setError(null);
      setLastLoadedAt(new Date());
    } catch (requestError) {
      const detail = requestError instanceof Error ? requestError.message : "Runner diagnostics could not be loaded.";
      setError(background
        ? `Live refresh delayed; showing the last successful snapshot. ${detail}`
        : detail);
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, [sort, participationUniverse]);

  useEffect(() => { load(); }, [load]);
  useEffect(() => {
    if (!autoRefresh) return;
    const timer = window.setInterval(() => load(true), REFRESH_SECONDS * 1000);
    return () => window.clearInterval(timer);
  }, [autoRefresh, load]);

  const inspect = useCallback(async (feature: RunnerFeature) => {
    setSelected(feature);
    setBaseline(null);
    setLoadingBaseline(true);
    try {
      const response = await fetchAPI<RunnerBaselineResponse>(`/api/runner/baseline/${encodeURIComponent(feature.symbol)}?minute=${feature.minute_of_session}`);
      setBaseline(response);
    } catch {
      setBaseline(null);
    } finally {
      setLoadingBaseline(false);
    }
  }, []);

  async function submitSearch(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const symbol = search.trim().toUpperCase();
    if (!symbol) return;
    setLoadingBaseline(true);
    try {
      const feature = await fetchAPI<RunnerFeature>(`/api/runner/features/${encodeURIComponent(symbol)}`);
      await inspect(feature);
      setSearch("");
      setError(null);
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : `No live feature found for ${symbol}.`);
      setLoadingBaseline(false);
    }
  }

  async function inspectSymbol(symbol: string) {
    try {
      const feature = await fetchAPI<RunnerFeature>(`/api/runner/features/${encodeURIComponent(symbol)}`);
      await inspect(feature);
      const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
      window.setTimeout(() => document.getElementById("runner-feature-inspector")?.scrollIntoView({ behavior: reducedMotion ? "auto" : "smooth", block: "start" }), 0);
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : `No live feature found for ${symbol}.`);
    }
  }

  if (loading && !status) {
    return (
      <div className="flex min-h-[520px] items-center justify-center rounded-2xl border border-card-border bg-card">
        <div className="text-center"><RefreshCw className="mx-auto h-7 w-7 animate-spin text-accent" /><p className="mt-3 text-sm font-semibold text-muted">Loading Runner telemetry…</p></div>
      </div>
    );
  }

  if (!status) {
    return (
      <div className="rounded-2xl border border-card-border bg-loss-bg p-8 text-center">
        <AlertTriangle className="mx-auto h-8 w-8 text-loss" />
        <h2 className="mt-3 text-lg font-black text-text-heading">Runner diagnostics unavailable</h2>
        <p className="mx-auto mt-2 max-w-xl text-sm text-muted">{error || "The backend did not return Runner status."}</p>
        <button type="button" onClick={() => load()} className="mt-5 cursor-pointer rounded-lg bg-accent px-4 py-2.5 text-sm font-bold text-white">Retry</button>
      </div>
    );
  }

  const features = latest?.features || [];
  const shortLookback = Object.keys(status.baselineCoverage).sort((a, b) => Number(a) - Number(b))[0];
  const longLookback = Object.keys(status.baselineCoverage).sort((a, b) => Number(a) - Number(b)).at(-1);
  const shortCoverage = shortLookback ? status.baselineCoverage[shortLookback] : 0;
  const longCoverage = longLookback ? status.baselineCoverage[longLookback] : 0;
  const contextLoaded = status.dailyContextCoverage?.loaded || 0;
  const market = status.marketContext;
  const activeProvider = status.activeProvider || status.provider;
  const providerDetail = status.activeProvider && status.provider && status.activeProvider !== status.provider
    ? `${status.activeProvider} fallback for ${status.provider}`
    : status.provider === "KITE" && status.providerLive && status.kiteStreamLive === false
      ? "KITE REST fallback"
      : `${activeProvider || "No provider"}${status.providerLive ? " · live" : " · not live"}`;

  return (
    <div className="mx-auto max-w-[1880px] space-y-5 pb-8">
      <header className="flex flex-col gap-4 xl:flex-row xl:items-end xl:justify-between">
        <div>
          <div className="flex flex-wrap items-center gap-3">
            <h1 className="text-3xl font-semibold tracking-tight text-text-heading">Runner Engine Lab</h1>
            <StatusBadge status={status} />
            <span className="rounded-full border border-card-border bg-surface-subtle px-3 py-1.5 font-mono text-[10px] font-bold text-muted">{status.featureVersion}</span>
          </div>
          <p className="mt-2 max-w-3xl text-sm leading-6 text-muted">Live intraday diagnostics for what each stock is doing now versus its own normal behavior at the same NSE session minute.</p>
          <div className="mt-2 flex items-center gap-2 text-xs text-warning"><ShieldCheck aria-hidden="true" className="h-4 w-4" /><span>Research ranking is live. Entry timing, extension checks, stops, targets, sizing, and trade execution are not yet produced.</span></div>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <label className="flex h-10 cursor-pointer items-center gap-2 rounded-lg border border-card-border bg-card px-3 text-xs font-bold text-muted">
            <input type="checkbox" checked={autoRefresh} onChange={(event) => setAutoRefresh(event.target.checked)} className="accent-emerald-500" />
            Auto {REFRESH_SECONDS}s
          </label>
          <button type="button" onClick={() => load(true)} disabled={refreshing} className="flex h-10 cursor-pointer items-center gap-2 rounded-lg border border-card-border bg-card px-3 text-xs font-bold text-foreground transition hover:bg-surface-hover disabled:cursor-wait disabled:opacity-60">
            <RefreshCw className={cn("h-4 w-4", refreshing && "animate-spin")} /> Refresh
          </button>
          <div className="h-10 rounded-lg border border-card-border bg-card px-3 py-2 text-[10px] text-muted">
            <span className="block uppercase tracking-wide">Dashboard updated</span><span className="font-mono text-foreground">{lastLoadedAt ? time(lastLoadedAt.toISOString()) : "—"} IST</span>
          </div>
        </div>
      </header>

      {error && (
        <div role="alert" className="flex items-start justify-between gap-4 rounded-xl border border-warning/30 bg-warning/10 px-4 py-3 text-sm text-warning">
          <div className="flex items-start gap-2"><AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" /><span>{error}</span></div>
          <button type="button" onClick={() => setError(null)} className="cursor-pointer" aria-label="Dismiss error"><X className="h-4 w-4" /></button>
        </div>
      )}

      {!status.enabled && (
        <div className="rounded-xl border border-card-border bg-warning/10 p-4">
          <div className="flex items-start gap-3"><AlertTriangle className="mt-0.5 h-5 w-5 shrink-0 text-warning" /><div><div className="font-black text-warning">Runner Engine is disabled in production</div><p className="mt-1 text-sm text-muted">Set RUNNER_ENGINE_ENABLED=true on the VM after applying the Runner database migrations. Existing Alpha Radar remains unaffected while it is off.</p></div></div>
        </div>
      )}

      <RunnerRankingPanel
        data={rankings}
        universe={participationUniverse}
        onUniverseChange={setParticipationUniverse}
        onInspect={inspectSymbol}
        baselineCoverage={shortCoverage}
      />

      <section aria-label="Runner processing pipeline" className="rounded-2xl border border-card-border bg-surface-subtle p-3">
        <div className="mb-3 flex items-center justify-between px-1"><h2 className="text-[11px] font-black uppercase tracking-[0.16em] text-muted">Live processing pipeline</h2><span className="text-[10px] text-muted">Backend-owned · provider-agnostic · leakage-safe</span></div>
        <div className="flex gap-2 overflow-x-auto pb-1">
          <PipelineStep label="Market data" detail={providerDetail} state={status.providerLive ? "good" : status.enabled ? "warn" : "idle"} icon={<Radio className="h-4 w-4" />} />
          <ArrowRight className="mt-6 hidden h-4 w-4 shrink-0 text-text-tertiary lg:block" />
          <PipelineStep label="Minute bars" detail={`${compact(status.metrics.bars_completed)} completed`} state={status.metrics.bars_completed > 0 ? "good" : "idle"} icon={<BarChart3 className="h-4 w-4" />} />
          <ArrowRight className="mt-6 hidden h-4 w-4 shrink-0 text-text-tertiary lg:block" />
          <PipelineStep label="TOD baselines" detail={`${number(shortCoverage, 1)}% short · ${number(longCoverage, 1)}% stable`} state={shortCoverage > 90 ? "good" : shortCoverage > 0 ? "warn" : "idle"} icon={<Database className="h-4 w-4" />} />
          <ArrowRight className="mt-6 hidden h-4 w-4 shrink-0 text-text-tertiary lg:block" />
          <PipelineStep label="Feature engine" detail={`${compact(status.metrics.features_calculated)} calculated`} state={status.metrics.features_calculated > 0 ? "good" : "idle"} icon={<Gauge className="h-4 w-4" />} />
          <ArrowRight className="mt-6 hidden h-4 w-4 shrink-0 text-text-tertiary lg:block" />
          <PipelineStep label="Feature store" detail={`${compact(status.metrics.feature_rows_persisted)} persisted`} state={status.persistenceRetryRows > 0 ? "warn" : status.metrics.feature_rows_persisted > 0 ? "good" : "idle"} icon={<ServerCog className="h-4 w-4" />} />
        </div>
      </section>

      <section className="grid grid-cols-2 gap-3 md:grid-cols-4 min-[1600px]:grid-cols-8">
        <MetricCard label="Universe" value={status.universe.toUpperCase()} helper={`${status.symbolsConfigured} configured`} icon={<Layers3 className="h-4 w-4" />} />
        <MetricCard label="Live states" value={`${status.symbolsMonitored}/${status.symbolsConfigured}`} helper="symbols reporting" icon={<Radio className="h-4 w-4" />} tone={status.symbolsMonitored === status.symbolsConfigured && status.symbolsConfigured > 0 ? "good" : "warn"} />
        <MetricCard label={`${shortLookback || "Short"}D baseline`} value={`${number(shortCoverage, 1)}%`} helper="same-minute coverage" icon={<Database className="h-4 w-4" />} tone={shortCoverage > 90 ? "good" : "warn"} />
        <MetricCard label={`${longLookback || "Long"}D baseline`} value={`${number(longCoverage, 1)}%`} helper="stable coverage" icon={<Database className="h-4 w-4" />} tone={longCoverage > 90 ? "good" : "warn"} />
        <MetricCard label="Daily context" value={`${contextLoaded}/${status.symbolsConfigured}`} helper="ATR / 20D / 50D" icon={<TrendingUp className="h-4 w-4" />} tone={contextLoaded > 0 ? "good" : "warn"} />
        <MetricCard label="Stale symbols" value={number(status.staleCount, 0)} helper={`provider age ${age(status.providerDataAgeSeconds)}`} icon={<Clock3 className="h-4 w-4" />} tone={status.staleCount > 0 ? "bad" : "good"} />
        <MetricCard label="Latency" value={`${number(status.processingLatencyMs, 0)} ms`} helper="latest feature cycle" icon={<Gauge className="h-4 w-4" />} tone={status.processingLatencyMs > 5000 ? "warn" : "neutral"} />
        <MetricCard label="Persist retry" value={number(status.persistenceRetryRows, 0)} helper={`${status.persistenceRetryRowsDropped} dropped`} icon={<ShieldCheck className="h-4 w-4" />} tone={status.persistenceRetryRows > 0 ? "warn" : "good"} />
      </section>

      <section className="grid gap-3 lg:grid-cols-[1.2fr_1fr_1fr]">
        <div className="rounded-xl border border-card-border bg-card p-4">
          <div className="flex items-start justify-between"><div><h2 className="text-sm font-black text-text-heading">Market context</h2><p className="mt-1 text-xs text-muted">Attached to every live feature row</p></div><Activity className="h-5 w-5 text-accent" /></div>
          <div className="mt-4 grid grid-cols-2 gap-2 sm:grid-cols-4">
            <Metric label="Nifty" value={percent(market.niftyReturn)} tone={valueTone(market.niftyReturn)} />
            <Metric label="Breadth" value={percent(market.breadthPct, 1)} tone={valueTone((market.breadthPct ?? 50) - 50)} />
            <Metric label="Adv / Dec" value={`${market.advancing || 0} / ${market.declining || 0}`} />
            <Metric label="Regime" value={market.regime || "—"} />
          </div>
        </div>
        <div className="rounded-xl border border-card-border bg-card p-4">
          <div className="flex items-start justify-between"><div><h2 className="text-sm font-black text-text-heading">Data quality</h2><p className="mt-1 text-xs text-muted">Fail-closed evidence, never filled with fake values</p></div><ShieldCheck className="h-5 w-5 text-accent" /></div>
          <div className="mt-4 flex flex-wrap gap-2">
            {Object.keys(status.dataQuality).length ? Object.entries(status.dataQuality).map(([label, count]) => (
              <span key={label} className={cn("rounded-md border px-2.5 py-1.5 text-[10px] font-black", qualityTone([label]))}>{label.replaceAll("_", " ")} · {count}</span>
            )) : <span className="text-xs text-muted">No feature quality states reported yet.</span>}
          </div>
        </div>
        <div className="rounded-xl border border-card-border bg-card p-4">
          <div className="flex items-start justify-between"><div><h2 className="text-sm font-black text-text-heading">Background jobs</h2><p className="mt-1 text-xs text-muted">Reproducible baseline and daily-history work</p></div><ServerCog className="h-5 w-5 text-accent" /></div>
          <div className="mt-4 space-y-2 text-xs">
            <JobLine label="TOD baselines" active={status.baselineTaskActive} progress={status.baselineJob} />
            <JobLine label="Daily context" active={status.dailyContextTaskActive} progress={status.dailyContextJob} />
          </div>
        </div>
      </section>

      <section className="overflow-hidden rounded-2xl border border-card-border bg-card shadow-sm">
        <div className="flex flex-col gap-3 border-b border-card-border p-4 lg:flex-row lg:items-center lg:justify-between">
          <div>
            <div className="flex items-center gap-2"><SlidersHorizontal className="h-4 w-4 text-accent" /><h2 className="text-sm font-black text-text-heading">Latest feature vectors</h2><span className="rounded-full bg-accent-bg px-2 py-0.5 text-[10px] font-black text-accent">{latest?.total || 0}</span></div>
            <p className="mt-1 text-xs text-muted">Operational ranking by one raw feature—not a trade score. Click any row to inspect its complete calculation context.</p>
          </div>
          <div className="flex flex-col gap-2 sm:flex-row">
            <form onSubmit={submitSearch} className="flex h-10 items-center gap-2 rounded-lg border border-input-border bg-input-bg px-3 focus-within:border-accent/50">
              <Search aria-hidden="true" className="h-4 w-4 text-muted" />
              <label htmlFor="runner-symbol-search" className="sr-only">Inspect a symbol</label>
              <input id="runner-symbol-search" value={search} onChange={(event) => setSearch(event.target.value.toUpperCase())} placeholder="Inspect symbol" className="w-32 bg-transparent text-sm font-bold text-foreground outline-none placeholder:font-normal placeholder:text-muted" />
            </form>
            <select value={sort} onChange={(event) => setSort(event.target.value as RunnerSort)} aria-label="Sort feature vectors" className="h-10 cursor-pointer rounded-lg border border-input-border bg-input-bg px-3 text-xs font-bold text-foreground outline-none focus:border-accent/50">
              {SORTS.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
            </select>
          </div>
        </div>
        {features.length ? <RunnerTable features={features} selected={selected?.symbol} onSelect={inspect} /> : (
          <div className="p-12 text-center"><Radio className="mx-auto h-8 w-8 text-text-tertiary" /><h3 className="mt-3 text-sm font-black text-text-heading">No live feature snapshots yet</h3><p className="mx-auto mt-2 max-w-xl text-sm text-muted">The table fills after the enabled engine receives market data, builds minute bars, and finds matching historical baselines. During closed markets, the most recent in-memory session may be empty after a restart.</p></div>
        )}
      </section>

      {selected && <div id="runner-feature-inspector"><FeatureInspector feature={selected} baseline={baseline} loadingBaseline={loadingBaseline} onClose={() => { setSelected(null); setBaseline(null); }} /></div>}

      <footer className="rounded-xl border border-dashed border-card-border p-4 text-xs leading-5 text-muted">
        <span className="font-black text-text-heading">Interpretation:</span> RVOL TOD compares cumulative volume at this exact session minute with the symbol&apos;s historical median. Runner Score ranks the eligible live cross-section using participation, velocity, price, range, structure, and context. It is research evidence—not an entry signal. Missing evidence remains blank; the state machine, setup engines, extension and risk gates, paper execution, and chronological replay remain intentionally separate.
      </footer>
    </div>
  );
}

function JobLine({ label, active, progress }: { label: string; active: boolean; progress: RunnerStatus["baselineJob"] }) {
  const completed = typeof progress?.completed === "number" ? progress.completed : null;
  const total = typeof progress?.total === "number" ? progress.total : null;
  return (
    <div className="flex items-center justify-between gap-3 rounded-lg border border-card-border bg-surface-subtle px-3 py-2.5">
      <span className="font-bold text-foreground">{label}</span>
      <span className={cn("inline-flex items-center gap-1.5 font-mono", active ? "text-warning" : "text-muted")}>
        {active ? <RefreshCw className="h-3 w-3 animate-spin" /> : <CheckCircle2 className="h-3 w-3" />}
        {active ? `${completed ?? 0}/${total ?? "—"}` : progress?.status || "Idle"}
      </span>
    </div>
  );
}
