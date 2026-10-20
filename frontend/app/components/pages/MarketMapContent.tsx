"use client";

import { PageHeader } from "../layout/PageHeader";
import { SubTabs } from "../layout/SubTabs";

import { useCallback, useEffect, useMemo, useState } from "react";
import { postAPI } from "../../lib/api";
import { cn, formatNumber } from "../../lib/utils";
import { getSector, getUniverse } from "../../lib/stock-universe";
import { useAuth } from "../../contexts/AuthContext";
import { SectorHeatmap } from "../heatmap/SectorHeatmap";

type MapTab = "nifty50" | "nifty100" | "nifty500" | "banks" | "smallcap" | "microcap";
type Bias = "LONG" | "SHORT" | "NEUTRAL";

interface RadarCandidate {
  symbol: string;
  bias: Bias;
  score: number;
  quality: string;
  action: string;
  setups: string[];
  entry: number;
  ltp: number;
  open?: number;
  high?: number;
  low?: number;
  changePct: number;
  volume: number;
  tradedValueLakh?: number;
  volRatio: number;
  rFactor: number;
  sector: string;
  pdh?: number | null;
  pdl?: number | null;
  vwap?: number | null;
  reasons?: string[];
}

interface RadarResponse {
  success: boolean;
  candidates: RadarCandidate[];
  actionable: RadarCandidate[];
  summary?: {
    total: number;
    long: number;
    short: number;
    neutral: number;
    actionable: number;
    avgScore: number;
  };
  provider?: {
    provider?: string;
    returned?: number;
    requested?: number;
    fallback?: boolean;
    fallbackReason?: string;
  };
  timestamp?: number;
  cached?: boolean;
  generatedAt?: string | null;
  nextRefreshAt?: string | null;
  freshness?: { status: "fresh" | "stale" | "pending"; ageSeconds: number | null };
  isStale?: boolean;
}

const TABS: Array<{ key: MapTab; label: string; desc: string }> = [
  { key: "nifty50", label: "Nifty 50", desc: "Large-cap index leadership" },
  { key: "nifty100", label: "Nifty 100", desc: "Liquid leadership and F&O proxies" },
  { key: "nifty500", label: "Nifty 500", desc: "Broad cash market opportunities" },
  { key: "banks", label: "Banks", desc: "Banking and financial beta names" },
  { key: "smallcap", label: "Smallcap", desc: "Smallcap 250 momentum radar" },
  { key: "microcap", label: "Microcap", desc: "Microcap abnormal participation" },
];
const MAP_CACHE_PREFIX = "alpha-radar:market-map:";

function universeSymbols(tab: MapTab): string[] {
  if (tab === "nifty50") return getUniverse("nifty50");
  if (tab === "nifty100") return getUniverse("nifty100");
  if (tab === "nifty500") return getUniverse("nifty500");
  if (tab === "smallcap") return getUniverse("smallcap");
  if (tab === "microcap") return getUniverse("microcap");
  if (tab === "banks") {
    return getUniverse("nifty500").filter((symbol) => {
      const sector = getSector(symbol).toLowerCase();
      return sector.includes("bank") || sector.includes("finance");
    });
  }
  return [];
}

function formatVol(value?: number | null): string {
  if (!value || !Number.isFinite(value)) return "-";
  if (value >= 10000000) return `${(value / 10000000).toFixed(1)}Cr`;
  if (value >= 100000) return `${(value / 100000).toFixed(1)}L`;
  return `${Math.round(value / 1000)}K`;
}

function formatSnapshotAge(age?: number | null) {
  if (age == null) return "warming";
  if (age < 60) return `${Math.round(age)}s ago`;
  return `${Math.floor(age / 60)}m ago`;
}

function formatNextRefresh(value: string) {
  const seconds = Math.max(0, Math.round((new Date(value).getTime() - Date.now()) / 1000));
  return seconds <= 1 ? "now" : `in ${seconds}s`;
}

function trendRead(candidate: RadarCandidate): { label: string; tone: "profit" | "loss" | "warning" | "muted" } {
  const setupList = candidate.setups || [];
  const setups = new Set(setupList);
  const move = candidate.changePct || 0;
  const rvol = candidate.volRatio || 0;
  const range = candidate.rFactor || 0;
  const strong = rvol >= 1.5 || range >= 1.2;

  if (candidate.bias === "LONG" && setups.has("PDH_BREAK") && strong) return { label: "Breakout", tone: "profit" };
  if (candidate.bias === "SHORT" && setups.has("PDL_BREAK") && strong) return { label: "Breakdown", tone: "loss" };
  if (candidate.bias === "LONG" && setupList.some((s) => s.includes("ORB") || s === "VWAP_RECLAIM")) return { label: "Early long", tone: "profit" };
  if (candidate.bias === "SHORT" && setupList.some((s) => s.includes("ORB") || s === "VWAP_LOSS")) return { label: "Early short", tone: "loss" };
  if (Math.abs(move) >= 4 && rvol < 1) return { label: "Late move", tone: "warning" };
  if (candidate.bias === "LONG") return { label: "Long watch", tone: "profit" };
  if (candidate.bias === "SHORT") return { label: "Short watch", tone: "loss" };
  return { label: "Wait", tone: "muted" };
}

function toneClass(tone: ReturnType<typeof trendRead>["tone"]) {
  if (tone === "profit") return "bg-profit-bg text-profit";
  if (tone === "loss") return "bg-loss-bg text-loss";
  if (tone === "warning") return "bg-warning/10 text-warning";
  return "bg-surface-subtle text-muted";
}

export default function MarketMapContent() {
  const { subscription } = useAuth();
  const isPremium = subscription?.tier === "premium" && subscription?.is_active;
  const [tab, setTab] = useState<MapTab>("nifty100");
  const [data, setData] = useState<RadarResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [refreshNote, setRefreshNote] = useState<string | null>(null);
  const [search, setSearch] = useState("");
  const [direction, setDirection] = useState<"all" | Bias>("all");
  const [urlReady, setUrlReady] = useState(false);

  const symbols = useMemo(() => universeSymbols(tab), [tab]);
  const activeMeta = TABS.find((item) => item.key === tab) || TABS[0];

  const loadUniverse = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const result = await postAPI<RadarResponse>("/api/intraday/radar", {
        symbols,
        minTradedValueLakh: tab === "microcap" ? 5 : tab === "smallcap" ? 15 : 25,
        useCache: true,
        quoteProvider: "arrow_first",
      });
      setData(result);
      window.sessionStorage.setItem(`${MAP_CACHE_PREFIX}${tab}`, JSON.stringify(result));
    } catch (err) {
      setError(err instanceof Error ? err.message : "Universe scan failed");
    } finally {
      setLoading(false);
    }
  }, [symbols, tab]);

  const queueRescan = useCallback(async () => {
    try {
      setError(null);
      const result = await postAPI<{ message: string }>("/api/market-snapshots/rescan", {
        feed: "intraday",
        symbols,
        minTradedValueLakh: tab === "microcap" ? 5 : tab === "smallcap" ? 15 : 25,
        useCache: true,
        quoteProvider: "arrow_first",
      });
      setRefreshNote(result.message);
      await loadUniverse();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not queue a shared refresh.");
    }
  }, [loadUniverse, symbols, tab]);

  useEffect(() => {
    const requested = new URLSearchParams(window.location.search).get("universe") as MapTab | null;
    if (TABS.some((item) => item.key === requested)) setTab(requested!);
    setUrlReady(true);
  }, []);

  useEffect(() => {
    if (!urlReady) return;
    const cached = window.sessionStorage.getItem(`${MAP_CACHE_PREFIX}${tab}`);
    if (cached) {
      try { setData(JSON.parse(cached)); } catch {}
      setLoading(false);
      return;
    }
    void loadUniverse();
  }, [loadUniverse, tab, urlReady]);

  const switchTab = useCallback((next: MapTab) => {
    setTab(next); setData(null); setLoading(true); setSearch(""); setDirection("all");
    const params = new URLSearchParams(window.location.search); params.set("universe", next);
    window.history.replaceState(null, "", `${window.location.pathname}?${params.toString()}`);
  }, []);

  const candidates = useMemo(() => {
    const q = search.trim().toLowerCase();
    return (data?.candidates || [])
      .filter((candidate) => direction === "all" || candidate.bias === direction)
      .filter((candidate) => !q || candidate.symbol.toLowerCase().includes(q) || candidate.sector.toLowerCase().includes(q))
      .sort((a, b) => {
        const aEarly = trendRead(a).label.includes("Early") ? 20 : 0;
        const bEarly = trendRead(b).label.includes("Early") ? 20 : 0;
        return (b.score + bEarly + Math.min(12, b.volRatio * 2)) - (a.score + aEarly + Math.min(12, a.volRatio * 2));
      });
  }, [data, direction, search]);

  const heatmapStocks = candidates.map((candidate) => ({
    symbol: candidate.symbol,
    sector: candidate.sector || getSector(candidate.symbol),
    last: candidate.ltp,
    changePercent: candidate.changePct,
    volume: candidate.volume || 1,
  }));

  const positives = candidates.filter((candidate) => candidate.changePct > 0).length;
  const negatives = candidates.filter((candidate) => candidate.changePct < 0).length;

  return (
    <div className="space-y-4">
      <PageHeader eyebrow="Market structure" title="Market heatmap" description="See where momentum is building. Select a stock to inspect its setup and risk." />
      <SubTabs tabs={TABS} active={tab} onChange={switchTab} />

      <div className="space-y-4">
          <div className="rounded-2xl border border-card-border bg-card p-4 shadow-sm">
            <div className="flex flex-col gap-3 lg:flex-row lg:items-center lg:justify-between">
              <div>
                <div className="flex items-center gap-2">
                  <h2 className="text-base font-black text-text-heading">{activeMeta.label} Heatmap</h2>
                  <span className="rounded-full bg-surface-subtle px-2 py-1 text-[11px] font-bold text-muted">
                    {symbols.length} symbols
                  </span>
                  {data?.provider?.provider && (
                    <span className="rounded-full bg-accent/10 px-2 py-1 text-[11px] font-bold text-accent">
                      {data.provider.provider}
                    </span>
                  )}
                </div>
                <p className="mt-1 text-sm text-muted">
                  {activeMeta.desc}. Click a tile or row to open trade analysis.
                  {data?.generatedAt ? ` Updated ${formatSnapshotAge(data.freshness?.ageSeconds)}; shared refresh ${data.nextRefreshAt ? `due ${formatNextRefresh(data.nextRefreshAt)}` : "queued"}.` : ""}
                </p>
              </div>
              <div className="flex flex-wrap items-center gap-2">
                <input
                  type="text"
                  value={search}
                  onChange={(event) => setSearch(event.target.value)}
                  aria-label="Search heatmap"
                  placeholder="Search symbol or sector..."
                  className="h-10 w-full rounded-xl border border-card-border bg-page-bg px-3 text-sm text-foreground placeholder:text-muted focus:border-accent focus:outline-none sm:w-64"
                />
                <div className="flex gap-0.5 rounded-xl border border-card-border bg-page-bg p-0.5">
                  {(["all", "LONG", "SHORT", "NEUTRAL"] as const).map((key) => (
                    <button
                      key={key}
                      type="button"
                      aria-pressed={direction === key}
                      onClick={() => setDirection(key)}
                      className={cn(
                        "rounded-lg px-3 py-2 text-xs font-black transition-colors",
                        direction === key ? "bg-accent text-white" : "text-muted hover:text-foreground",
                      )}
                    >
                      {key === "all" ? "All" : key}
                    </button>
                  ))}
                </div>
                {isPremium && (
                  <button
                    type="button"
                    onClick={queueRescan}
                    disabled={loading}
                    className="h-10 rounded-xl border border-accent/30 bg-accent/10 px-4 text-xs font-black text-accent transition hover:bg-accent hover:text-white disabled:opacity-50"
                  >
                    {loading ? "Loading" : "Queue refresh"}
                  </button>
                )}
              </div>
            </div>
            <div className="mt-4 grid grid-cols-2 gap-3 lg:grid-cols-4">
              <Metric label="Candidates" value={data?.summary?.total ?? candidates.length} />
              <Metric label="Positive" value={positives} tone="profit" />
              <Metric label="Negative" value={negatives} tone="loss" />
              <Metric label="Actionable" value={data?.summary?.actionable ?? data?.actionable?.length ?? 0} tone="accent" />
            </div>
            {error && (
              <div className="mt-3 rounded-xl border border-card-border bg-loss-bg px-4 py-3 text-sm font-semibold text-loss">
                {error}
              </div>
            )}
            {refreshNote && (
              <div className="mt-3 rounded-xl border border-card-border bg-accent/10 px-4 py-3 text-sm font-semibold text-accent">
                {refreshNote}
              </div>
            )}
          </div>

          <SectorHeatmap
            stocks={heatmapStocks}
            sizeBy="volume"
            onStockClick={(symbol) => window.open(`/radar-trade?symbol=${encodeURIComponent(symbol)}`, "_self")}
          />

          <div className="overflow-hidden rounded-2xl border border-card-border bg-card shadow-sm">
            <div className="flex items-center justify-between border-b border-card-border px-4 py-3">
              <div>
                <h3 className="text-sm font-black text-text-heading">Tradable Names</h3>
                <p className="text-xs text-muted">Sorted by score, early signal quality, RVOL, and range expansion.</p>
              </div>
              <span className="text-xs font-semibold text-muted">{candidates.length} shown</span>
            </div>
            <div className="max-h-[560px] overflow-auto">
              <table className="w-full min-w-[1120px] text-xs">
                <thead className="sticky top-0 bg-card">
                  <tr className="border-b border-card-border text-muted">
                    <th className="px-4 py-2 text-left">Symbol</th>
                    <th className="px-2 py-2 text-left">Sector</th>
                    <th className="px-2 py-2 text-center">Bias</th>
                    <th className="px-2 py-2 text-right">Score</th>
                    <th className="px-2 py-2 text-right">LTP</th>
                    <th className="px-2 py-2 text-right">Move</th>
                    <th className="px-2 py-2 text-right">Volume</th>
                    <th className="px-2 py-2 text-right">RVOL</th>
                    <th className="px-2 py-2 text-right">Range</th>
                    <th className="px-2 py-2 text-center">Read</th>
                    <th className="px-2 py-2 text-left">Setup</th>
                    <th className="px-4 py-2 text-right">Entry</th>
                  </tr>
                </thead>
                <tbody className="font-mono">
                  {candidates.map((candidate) => {
                    const read = trendRead(candidate);
                    return (
                      <tr
                        key={candidate.symbol}
                        className="border-b border-card-border/40 transition hover:bg-hover-bg"
                      >
                        <td className="px-4 py-2 font-black text-text-heading">
                          <a href={`/radar-trade?symbol=${encodeURIComponent(candidate.symbol)}`} className="hover:text-accent">
                            {candidate.symbol}
                          </a>
                        </td>
                        <td className="px-2 py-2 text-muted">{candidate.sector || getSector(candidate.symbol)}</td>
                        <td className="px-2 py-2 text-center">
                          <span className={cn(
                            "rounded px-2 py-1 text-[10px] font-black",
                            candidate.bias === "LONG" ? "bg-profit-bg text-profit" : candidate.bias === "SHORT" ? "bg-loss-bg text-loss" : "bg-surface-subtle text-muted",
                          )}>
                            {candidate.bias}
                          </span>
                        </td>
                        <td className="px-2 py-2 text-right font-black text-accent">{candidate.score}</td>
                        <td className="px-2 py-2 text-right">{formatNumber(candidate.ltp)}</td>
                        <td className={cn("px-2 py-2 text-right font-black", candidate.changePct >= 0 ? "text-profit" : "text-loss")}>
                          {candidate.changePct >= 0 ? "+" : ""}{candidate.changePct.toFixed(2)}%
                        </td>
                        <td className="px-2 py-2 text-right text-muted">{formatVol(candidate.volume)}</td>
                        <td className="px-2 py-2 text-right">{candidate.volRatio.toFixed(1)}x</td>
                        <td className="px-2 py-2 text-right">{candidate.rFactor.toFixed(1)}R</td>
                        <td className="px-2 py-2 text-center">
                          <span className={cn("rounded px-2 py-1 text-[10px] font-black", toneClass(read.tone))}>{read.label}</span>
                        </td>
                        <td className="max-w-[260px] truncate px-2 py-2 text-muted" title={(candidate.setups || []).join(", ")}>
                          {(candidate.setups || []).slice(0, 3).join(", ") || "-"}
                        </td>
                        <td className="px-4 py-2 text-right">{candidate.entry ? formatNumber(candidate.entry) : "-"}</td>
                      </tr>
                    );
                  })}
                  {!loading && candidates.length === 0 && (
                    <tr>
                      <td colSpan={12} className="px-4 py-8 text-center text-sm text-muted">
                        No live candidates yet. Try Refresh or loosen the direction/search filter.
                      </td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>
          </div>
      </div>
    </div>
  );
}

function Metric({ label, value, tone = "muted" }: { label: string; value: number; tone?: "profit" | "loss" | "accent" | "muted" }) {
  return (
    <div className="rounded-xl border border-card-border bg-page-bg px-4 py-3">
      <div className="text-[11px] font-bold uppercase tracking-wide text-muted">{label}</div>
      <div
        className={cn(
          "mt-1 text-2xl font-black",
          tone === "profit" && "text-profit",
          tone === "loss" && "text-loss",
          tone === "accent" && "text-accent",
          tone === "muted" && "text-text-heading",
        )}
      >
        {value}
      </div>
    </div>
  );
}
