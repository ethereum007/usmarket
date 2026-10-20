"use client";

import { useEffect, useMemo, useState } from "react";
import { Activity, ChevronDown, RefreshCw } from "lucide-react";
import { fetchAPI } from "../../lib/api";
import { cn } from "../../lib/utils";

type TimeframeKey = "daily" | "weekly" | "monthly";

interface PulseComponent {
  name: string;
  score: number;
  weight: number;
  value: number;
  unit: string;
}

interface PulseTimeframe {
  key: TimeframeKey;
  label: string;
  score: number;
  zone: "extreme-greed" | "greed" | "neutral" | "fear" | "extreme-fear";
  sentiment: string;
  description: string;
  previousScore: number;
  change: number;
  comparison: string;
  components: PulseComponent[];
}

interface PulseResponse {
  success: boolean;
  name: string;
  scale: string;
  methodologyVersion: string;
  asOf: string;
  cached?: boolean;
  warning?: string;
  timeframes: Record<TimeframeKey, PulseTimeframe>;
}

const TIMEFRAMES: TimeframeKey[] = ["daily", "weekly", "monthly"];
const CACHE_KEY = "alpha-radar:nifty-pulse-index";
const ZONES = [
  { from: 0, to: 20, color: "#059669", label: "Extreme Greed", range: "0–20" },
  { from: 20, to: 35, color: "#34d399", label: "Greed", range: "20–35" },
  { from: 35, to: 50, color: "#f59e0b", label: "Neutral", range: "35–50" },
  { from: 50, to: 65, color: "#fb7185", label: "Fear", range: "50–65" },
  { from: 65, to: 100, color: "#ef4444", label: "Extreme Fear", range: "65–100" },
] as const;

function polar(value: number, radius: number) {
  const angle = Math.PI + (value / 100) * Math.PI;
  return { x: 150 + radius * Math.cos(angle), y: 135 + radius * Math.sin(angle) };
}

function arcPath(from: number, to: number, radius = 105) {
  const start = polar(from, radius);
  const end = polar(to, radius);
  return `M ${start.x} ${start.y} A ${radius} ${radius} 0 0 1 ${end.x} ${end.y}`;
}

function PulseGauge({ value }: { value: number }) {
  const needle = polar(Math.max(0, Math.min(100, value)), 76);
  return (
    <div className="relative mx-auto w-full max-w-[220px]" aria-label={`NIFTY Pulse score ${value} out of 100`}>
      <svg viewBox="0 0 300 170" role="img" className="h-auto w-full overflow-visible">
        <title>NIFTY Pulse gauge. Higher values indicate more fear.</title>
        {ZONES.map((zone) => (
          <path
            key={zone.label}
            d={arcPath(zone.from + 0.6, zone.to - 0.6)}
            fill="none"
            stroke={zone.color}
            strokeWidth="17"
            strokeLinecap="round"
          />
        ))}
        {[0, 20, 35, 50, 65, 100].map((tick) => {
          const point = polar(tick, 126);
          return (
            <text
              key={tick}
              x={point.x}
              y={point.y}
              textAnchor="middle"
              dominantBaseline="middle"
              className="fill-muted text-[9px] font-semibold"
            >
              {tick}
            </text>
          );
        })}
        <line
          x1="150"
          y1="135"
          x2={needle.x}
          y2={needle.y}
          stroke="var(--text-heading)"
          strokeWidth="5"
          strokeLinecap="round"
          className="transition-all duration-500 motion-reduce:transition-none"
        />
        <circle cx="150" cy="135" r="12" fill="var(--text-heading)" opacity="0.18" />
        <circle cx="150" cy="135" r="7" fill="var(--text-heading)" />
        <circle cx="150" cy="135" r="3" fill="var(--card)" />
      </svg>
    </div>
  );
}

function zoneTextColor(zone: PulseTimeframe["zone"]) {
  if (zone === "extreme-greed") return "text-emerald-600";
  if (zone === "greed") return "text-emerald-500";
  if (zone === "neutral") return "text-warning";
  if (zone === "fear") return "text-rose-400";
  return "text-loss";
}

export function NiftyPulseIndexCard() {
  const [data, setData] = useState<PulseResponse | null>(null);
  const [timeframe, setTimeframe] = useState<TimeframeKey>("daily");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [showDrivers, setShowDrivers] = useState(false);
  const [reloadKey, setReloadKey] = useState(0);

  useEffect(() => {
    let active = true;
    async function load() {
      try {
        const response = await fetchAPI<PulseResponse>("/api/nifty-pulse-index");
        if (active) {
          setData(response);
          window.sessionStorage.setItem(CACHE_KEY, JSON.stringify(response));
          setError(null);
        }
      } catch (err) {
        if (active) setError(err instanceof Error ? err.message : "Pulse data is unavailable");
      } finally {
        if (active) setLoading(false);
      }
    }
    const cached = reloadKey === 0 ? window.sessionStorage.getItem(CACHE_KEY) : null;
    if (cached) {
      try { setData(JSON.parse(cached)); } catch {}
      setLoading(false);
    } else {
      void load();
    }
    return () => {
      active = false;
    };
  }, [reloadKey]);

  const selected = data?.timeframes[timeframe];
  const updatedLabel = useMemo(() => {
    if (!data?.asOf) return "";
    const date = new Date(data.asOf);
    if (Number.isNaN(date.getTime())) return "";
    return date.toLocaleString("en-IN", { dateStyle: "medium", timeStyle: "short" });
  }, [data?.asOf]);

  if (loading) {
    return <div className="h-[240px] animate-pulse rounded-2xl border border-card-border bg-card" aria-label="Loading NIFTY Pulse Index" />;
  }

  if (!selected) {
    return (
      <div className="rounded-2xl border border-card-border bg-card p-6" role="alert">
        <div className="flex items-center gap-3 text-text-heading">
          <Activity className="h-5 w-5 text-accent" aria-hidden="true" />
          <h2 className="font-semibold">NIFTY Pulse Index</h2>
        </div>
        <p className="mt-3 text-sm text-muted">{error || "Pulse data is temporarily unavailable."}</p>
        <button
          type="button"
          onClick={() => {
            setLoading(true);
            setReloadKey((value) => value + 1);
          }}
          className="mt-4 min-h-11 cursor-pointer rounded-lg border border-card-border px-4 text-sm font-semibold text-foreground transition-colors hover:bg-surface-hover focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
        >
          Retry
        </button>
      </div>
    );
  }

  return (
    <section className="overflow-hidden rounded-2xl border border-card-border bg-card" aria-labelledby="nifty-pulse-title">
      <div className="flex flex-col gap-3 border-b border-card-border px-5 py-3 sm:flex-row sm:items-center sm:justify-between">
        <div className="flex items-center gap-3">
          <div className="flex h-9 w-9 items-center justify-center rounded-lg bg-accent-bg text-accent">
            <Activity className="h-5 w-5" aria-hidden="true" />
          </div>
          <div>
            <h2 id="nifty-pulse-title" className="font-semibold tracking-wide text-text-heading">NIFTY PULSE INDEX</h2>
            <p className="text-xs text-muted">Higher score means greater market fear</p>
          </div>
        </div>
        <div className="flex items-center gap-2"><div className="grid grid-cols-3 rounded-xl border border-card-border bg-surface-subtle p-1" aria-label="Pulse timeframe">
          {TIMEFRAMES.map((key) => (
            <button
              key={key}
              type="button"
              onClick={() => setTimeframe(key)}
              aria-pressed={timeframe === key}
              className={cn(
                "min-h-9 cursor-pointer rounded-lg px-4 text-xs font-semibold capitalize transition-colors focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent",
                timeframe === key ? "bg-card text-text-heading shadow-sm" : "text-muted hover:text-foreground",
              )}
            >
              {key}
            </button>
          ))}
        </div><button type="button" aria-label="Refresh NIFTY Pulse Index" onClick={() => { setLoading(true); setReloadKey((value) => value + 1); }} className="workspace-button"><RefreshCw className="h-3.5 w-3.5" /> Refresh</button></div>
      </div>

      <div className="grid gap-3 px-5 py-3 sm:grid-cols-[1fr_240px] sm:items-center">
        <div>
          <div className="flex flex-wrap items-end gap-3">
            <span className="text-4xl font-semibold tabular-nums tracking-tight text-text-heading">{selected.score.toFixed(1)}</span>
            <span className={cn("pb-1 text-lg font-semibold", zoneTextColor(selected.zone))}>{selected.sentiment}</span>
          </div>
          <div className="mt-2 text-xs text-foreground">
            {selected.comparison}
          </div>
          <p className="mt-2 max-w-xl text-xs leading-5 text-muted">{selected.description}</p>
        </div>

        <div>
          <PulseGauge value={selected.score} />
        </div>
      </div>

      <div className="border-t border-card-border bg-surface-subtle px-5 py-2">
        <button
          type="button"
          onClick={() => setShowDrivers((value) => !value)}
          aria-expanded={showDrivers}
          className="flex min-h-8 w-full cursor-pointer items-center justify-between gap-3 text-left text-xs font-medium text-muted focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
        >
          <span className="flex items-center gap-2">
            {data.cached && <RefreshCw className="h-3.5 w-3.5" aria-hidden="true" />}
            {data.cached ? data.warning : `Updated ${updatedLabel}`}
          </span>
          <span className="flex items-center gap-1 text-foreground">
            Score drivers
            <ChevronDown className={cn("h-4 w-4 transition-transform", showDrivers && "rotate-180")} aria-hidden="true" />
          </span>
        </button>
        {showDrivers && (
          <div className="space-y-4 pb-2 pt-3">
            <div className="flex flex-wrap gap-x-6 gap-y-2">{ZONES.map(zone => <div key={zone.label} className="flex items-center gap-2 text-xs text-muted"><span className="h-1.5 w-1.5 rounded-full" style={{backgroundColor:zone.color}} />{zone.label} · {zone.range}</div>)}</div>
            <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-5">
            {selected.components.map((component) => (
              <div key={component.name} className="rounded-lg border border-card-border bg-card px-3 py-2">
                <div className="text-[10px] text-muted">{component.name} · {component.weight}%</div>
                <div className="mt-1 text-sm font-semibold tabular-nums text-text-heading">{component.value} {component.unit}</div>
              </div>
            ))}
            </div>
          </div>
        )}
      </div>
    </section>
  );
}
