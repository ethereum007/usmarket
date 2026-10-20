"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { fetchAPI, postAPI } from "../../lib/api";
import { cn, formatNumber } from "../../lib/utils";

type RiskFlag =
  | "Clean Momentum"
  | "Watch Carefully"
  | "Liquidity Trap"
  | "Circuit Risk"
  | "News-Only Move"
  | "Avoid: Surveillance/Low Liquidity";

interface ScoreBreakdown {
  volume_expansion: number;
  delivery_strength: number;
  breakout: number;
  sector_support: number;
  institutional_footprint: number;
  liquidity_quality: number;
  governance_cleanliness: number;
}

interface AbnormalMove {
  symbol: string;
  last_price: number;
  change_pct: number;
  volume_vs_avg: number;
  delivery_pct: number | null;
  breakout_status: string;
  circuit_status: string;
  liquidity_score: number;
  risk_flag: RiskFlag;
  alpha_score: number;
  score_breakdown: ScoreBreakdown;
  reasons: string[];
  invalidation_level: number | null;
  market_cap_bucket: string;
  sector: string;
  turnover_lakh: number;
  tags: string[];
}

interface RadarResponse {
  success: boolean;
  source: string;
  cached?: boolean;
  cachedAt?: string;
  count: number;
  totalScored: number;
  results: AbnormalMove[];
  summary: {
    cleanMomentum: number;
    watchCarefully: number;
    avoid: number;
    avgScore: number;
  };
  meta: {
    elapsedMs: number;
    disclaimer: string;
    warning?: string | null;
    provider?: {
      provider?: string;
      requested?: number;
      returned?: number;
      fallback?: boolean;
      fallbackReason?: string;
    };
    universe?: {
      requested?: number;
      quoted?: number;
      scored?: number;
    };
    cache?: {
      hit?: boolean;
      ageSeconds?: number;
      ttlSeconds?: number;
      sessionFallback?: boolean;
    };
    dataQuality?: {
      avgVolumeCoveragePct?: number;
      deliveryCoveragePct?: number;
      pdhCoveragePct?: number;
      avgVolumeHits?: number;
      deliveryHits?: number;
      pdhHits?: number;
    };
    filters?: {
      relaxedVolumeFilter?: boolean;
      requestedMinVolumeSpike?: number;
      effectiveMinVolumeSpike?: number;
    };
  };
}

type RadarMode = "live" | "snapshot";
type SortKey = keyof Pick<AbnormalMove, "alpha_score" | "change_pct" | "volume_vs_avg" | "delivery_pct" | "liquidity_score" | "turnover_lakh" | "last_price">;
type DirectionFilter = "all" | "gainers" | "losers";

interface SnapshotDetailResponse<T> {
  success?: boolean;
  snapshot: {
    key: string;
    label: string;
    status: "fresh" | "last-session" | "stale" | "missing" | "unknown";
    timestamp?: string | null;
    ageLabel?: string | null;
  };
  data: T;
}

const DEFAULT_FILTERS = {
  minVolumeSpike: 1.5,
  minPriceChange: 2,
  marketCapBucket: "all",
  avoidSurveillance: true,
  onlyBreakout: false,
};

const CACHE_KEY = "alphaRadar.abnormalMoves.cache.v1";
const BACKGROUND_REFRESH_AFTER_MS = 30_000;
const RADAR_CANDIDATE_STORAGE_KEY = "alpha-radar:selected-candidate";

interface CachedRadarState {
  data: RadarResponse;
  filters: typeof DEFAULT_FILTERS;
  sortKey: SortKey;
  watchlist: string[];
  cachedAt: string;
}

export default function AbnormalMovesContent() {
  const [data, setData] = useState<RadarResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [mode, setMode] = useState<RadarMode>("live");
  const [replayLoading, setReplayLoading] = useState(false);
  const [replayError, setReplayError] = useState<string | null>(null);
  const [replayMeta, setReplayMeta] = useState<SnapshotDetailResponse<RadarResponse>["snapshot"] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [filters, setFilters] = useState(DEFAULT_FILTERS);
  const [sortKey, setSortKey] = useState<SortKey>("alpha_score");
  const [query, setQuery] = useState("");
  const [direction, setDirection] = useState<DirectionFilter>("all");
  const [selected, setSelected] = useState<AbnormalMove | null>(null);
  const [watchlist, setWatchlist] = useState<Set<string>>(new Set());
  const [uploadedRows, setUploadedRows] = useState<Array<Record<string, unknown>> | null>(null);
  const [cachedAt, setCachedAt] = useState<string | null>(null);
  const [cacheReady, setCacheReady] = useState(false);
  const autoRefreshStarted = useRef(false);

  const sorted = useMemo(() => {
    const needle = query.trim().toUpperCase();
    const rows = (data?.results || []).filter((row) => {
      if (direction === "gainers" && row.change_pct <= 0) return false;
      if (direction === "losers" && row.change_pct >= 0) return false;
      if (!needle) return true;
      return row.symbol.includes(needle) || row.sector.toUpperCase().includes(needle) || row.risk_flag.toUpperCase().includes(needle);
    });
    rows.sort((a, b) => Number(b[sortKey] || 0) - Number(a[sortKey] || 0));
    return rows;
  }, [data, direction, query, sortKey]);

  useEffect(() => {
    try {
      const raw = window.localStorage.getItem(CACHE_KEY);
      if (!raw) return;
      const cached = JSON.parse(raw) as CachedRadarState;
      if (!cached?.data?.results) return;
      setData(cached.data);
      setFilters({ ...DEFAULT_FILTERS, ...cached.filters });
      setSortKey(cached.sortKey || "alpha_score");
      setWatchlist(new Set(cached.watchlist || []));
      setSelected(cached.data.results[0] || null);
      setCachedAt(cached.cachedAt || null);
    } catch {
      window.localStorage.removeItem(CACHE_KEY);
    } finally {
      setCacheReady(true);
    }
  }, []);

  useEffect(() => {
    if (!cacheReady || !data) return;
    const payload: CachedRadarState = {
      data,
      filters,
      sortKey,
      watchlist: Array.from(watchlist),
      cachedAt: cachedAt || new Date().toISOString(),
    };
    window.localStorage.setItem(CACHE_KEY, JSON.stringify(payload));
  }, [cacheReady, cachedAt, data, filters, sortKey, watchlist]);

  const runRadar = useCallback(async (rows = uploadedRows, options?: { background?: boolean; filtersOverride?: typeof DEFAULT_FILTERS }) => {
    const background = Boolean(options?.background);
    const scanFilters = options?.filtersOverride || filters;
    if (background) setRefreshing(true);
    else {
      setLoading(true);
      setError(null);
    }
    setReplayError(null);
    setReplayMeta(null);
    setMode("live");
    try {
      const res = await postAPI<RadarResponse>("/api/abnormal/radar", {
        rows: rows || undefined,
        source: rows ? "payload" : "live",
        quoteProvider: "arrow_first",
        useCache: true,
        filters: scanFilters,
      });
      setData(res);
      setSelected(res.results[0] || null);
      setCachedAt(new Date().toISOString());
    } catch (err) {
      if (!background) setError(err instanceof Error ? err.message : "Could not load abnormal moves.");
    } finally {
      if (background) setRefreshing(false);
      else setLoading(false);
    }
  }, [filters, uploadedRows]);

  const loadReplay = useCallback(async () => {
    setReplayLoading(true);
    setReplayError(null);
    setError(null);

    try {
      const res = await fetchAPI<SnapshotDetailResponse<RadarResponse>>("/api/snapshots/abnormal_live");
      if (!res.data?.success || !Array.isArray(res.data.results)) {
        throw new Error("Saved Abnormal Moves payload is not available yet.");
      }
      setData({
        ...res.data,
        cached: true,
        cachedAt: res.snapshot.timestamp ?? undefined,
      });
      setSelected(res.data.results[0] || null);
      setCachedAt(res.snapshot.timestamp || new Date().toISOString());
      setReplayMeta(res.snapshot);
      setMode("snapshot");
    } catch (err) {
      const rawMessage = err instanceof Error ? err.message : "Could not load saved Abnormal Moves snapshot";
      const msg = rawMessage.includes("No saved snapshot") || rawMessage.includes("404")
        ? "No saved Abnormal Moves replay is available yet. Run one successful live radar scan to seed this replay."
        : rawMessage;
      setReplayError(msg);
    } finally {
      setReplayLoading(false);
      setLoading(false);
    }
  }, []);

  function returnToLive() {
    setMode("live");
    setReplayMeta(null);
    setReplayError(null);
    if (data?.cached && replayMeta) setData(null);
  }

  function resetFiltersAndScan() {
    setFilters(DEFAULT_FILTERS);
    setQuery("");
    setDirection("all");
    void runRadar(uploadedRows, { filtersOverride: DEFAULT_FILTERS });
  }

  useEffect(() => {
    if (!cacheReady || uploadedRows || autoRefreshStarted.current || mode === "snapshot") return;
    const ageMs = cachedAt ? Date.now() - new Date(cachedAt).getTime() : Number.POSITIVE_INFINITY;
    if (!data || ageMs > BACKGROUND_REFRESH_AFTER_MS) {
      autoRefreshStarted.current = true;
      void runRadar(undefined, { background: Boolean(data) });
    }
  }, [cacheReady, cachedAt, data, mode, runRadar, uploadedRows]);

  async function uploadCsv(file: File | null) {
    if (!file) return;
    setLoading(true);
    setError(null);
    try {
      const body = new FormData();
      body.append("file", file);
      const apiBase = process.env.NEXT_PUBLIC_API_URL || "";
      const res = await fetch(`${apiBase}/api/abnormal/upload`, {
        method: "POST",
        credentials: "include",
        body,
      });
      if (!res.ok) throw new Error(`Upload failed: ${res.status}`);
      const json = await res.json();
      setUploadedRows(json.rows || []);
      await runRadar(json.rows || []);
    } catch (err) {
      setError(err instanceof Error ? err.message : "CSV upload failed.");
    } finally {
      setLoading(false);
    }
  }

  function toggleWatch(symbol: string) {
    setWatchlist((prev) => {
      const next = new Set(prev);
      if (next.has(symbol)) next.delete(symbol);
      else next.add(symbol);
      return next;
    });
  }

  function exportCsv() {
    const header = ["symbol", "last_price", "change_pct", "volume_vs_avg", "delivery_pct", "breakout_status", "liquidity_score", "risk_flag", "alpha_score"];
    const lines = sorted.map((row) => header.map((key) => JSON.stringify((row as any)[key] ?? "")).join(","));
    const blob = new Blob([[header.join(","), ...lines].join("\n")], { type: "text/csv" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = "alpha-radar-abnormal-moves.csv";
    a.click();
    URL.revokeObjectURL(url);
  }

  return (
    <div className="space-y-4">
      <div className="bg-card border border-card-border rounded-lg p-4">
        <div className="flex flex-col xl:flex-row xl:items-end justify-between gap-4">
          <div>
            <div className="text-xs uppercase tracking-wide text-muted">Abnormal Momentum Surveillance</div>
            <h2 className="text-lg font-semibold text-text-heading mt-1">Find unusual price-volume-delivery moves before they become obvious</h2>
            <p className="text-xs text-muted mt-1 max-w-3xl">
              {data ? sourceLabel(data) : "Live broker-backed scan with CSV fallback."} Screening and risk tool only. Not investment advice and not a manipulation detector.
            </p>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            {cachedAt && (
              <div className="text-[11px] text-muted mr-1">
                {replayLoading
                  ? "Loading replay..."
                  : refreshing
                    ? "Refreshing live..."
                    : `${mode === "snapshot" ? "Replay" : "Cached"} ${new Date(cachedAt).toLocaleTimeString("en-IN", { hour: "2-digit", minute: "2-digit" })}`}
              </div>
            )}
            <label className="px-3 py-2 rounded border border-card-border text-xs text-muted hover:text-foreground cursor-pointer">
              Upload CSV
              <input type="file" accept=".csv" className="hidden" onChange={(e) => uploadCsv(e.target.files?.[0] || null)} />
            </label>
            <button type="button" onClick={exportCsv} disabled={!sorted.length} className="px-3 py-2 rounded border border-card-border text-xs text-muted hover:text-foreground disabled:opacity-50">
              Export CSV
            </button>
            <div className="flex gap-0.5 bg-card border border-card-border rounded p-0.5">
              <button
                type="button"
                onClick={returnToLive}
                disabled={loading || refreshing || replayLoading}
                className={cn(
                  "px-3 py-1.5 rounded text-xs font-medium transition-colors disabled:opacity-50",
                  mode === "live" ? "bg-accent text-white" : "text-muted hover:text-foreground",
                )}
              >
                Live
              </button>
              <button
                type="button"
                onClick={loadReplay}
                disabled={loading || refreshing || replayLoading}
                className={cn(
                  "px-3 py-1.5 rounded text-xs font-medium transition-colors disabled:opacity-50",
                  mode === "snapshot" ? "bg-warning text-white" : "text-muted hover:text-foreground",
                )}
              >
                {replayLoading ? "Loading" : "Replay"}
              </button>
            </div>
            <button type="button" onClick={() => runRadar()} disabled={loading || refreshing || replayLoading} className="px-4 py-2 rounded bg-accent text-white text-sm font-semibold disabled:opacity-50">
              {loading ? "Scanning..." : refreshing ? "Refreshing..." : uploadedRows ? "Scan Uploaded" : "Run Radar"}
            </button>
          </div>
        </div>

        <div className="grid grid-cols-2 md:grid-cols-6 gap-3 mt-4">
          <label className="text-xs text-muted">
            Search
            <input
              type="search"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Symbol, sector, risk"
              className="mt-1 w-full bg-page-bg border border-card-border rounded px-2 py-2 text-foreground"
            />
          </label>
          <label className="text-xs text-muted">
            Direction
            <select
              value={direction}
              onChange={(e) => setDirection(e.target.value as DirectionFilter)}
              className="mt-1 w-full bg-page-bg border border-card-border rounded px-2 py-2 text-foreground"
            >
              <option value="all">All Moves</option>
              <option value="gainers">Gainers</option>
              <option value="losers">Losers</option>
            </select>
          </label>
          <FilterNumber label="Min Vol x" value={filters.minVolumeSpike} onChange={(value) => setFilters((f) => ({ ...f, minVolumeSpike: value }))} />
          <FilterNumber label="Min Change %" value={filters.minPriceChange} onChange={(value) => setFilters((f) => ({ ...f, minPriceChange: value }))} />
          <label className="text-xs text-muted">
            Liquidity Bucket
            <select
              value={filters.marketCapBucket}
              onChange={(e) => setFilters((f) => ({ ...f, marketCapBucket: e.target.value }))}
              className="mt-1 w-full bg-page-bg border border-card-border rounded px-2 py-2 text-foreground"
            >
              <option value="all">All</option>
              <option value="large">Large</option>
              <option value="mid">Mid</option>
              <option value="small">Small</option>
              <option value="micro">Micro</option>
            </select>
          </label>
          <Toggle label="Avoid ASM/GSM/T2T" checked={filters.avoidSurveillance} onChange={(checked) => setFilters((f) => ({ ...f, avoidSurveillance: checked }))} />
          <Toggle label="Breakouts Only" checked={filters.onlyBreakout} onChange={(checked) => setFilters((f) => ({ ...f, onlyBreakout: checked }))} />
          <div className="bg-page-bg rounded border border-card-border px-3 py-2">
            <div className="text-[11px] text-muted">Latency</div>
            <div className="text-sm font-mono text-accent">{data ? `${data.meta.elapsedMs} ms` : "-"}</div>
          </div>
        </div>
      </div>

      {error && <div className="bg-loss-bg border border-loss/20 text-loss rounded p-3 text-sm">{error}</div>}
      {replayError && <div className="bg-warning/10 border border-warning/20 text-warning rounded p-3 text-sm">{replayError}</div>}
      {mode === "snapshot" && replayMeta && (
        <div className="bg-warning/10 border border-warning/20 text-warning rounded p-3 text-sm flex items-center justify-between gap-3 flex-wrap">
          <span>
            Abnormal Moves replay is active from {replayMeta.timestamp || "the last saved scan"} ({replayMeta.ageLabel || replayMeta.status} old).
          </span>
          <Link href="/snapshots?key=abnormal_live" className="text-accent font-semibold hover:underline">
            Open raw replay
          </Link>
        </div>
      )}
      {data?.meta.warning && <div className="bg-warning/10 border border-warning/20 text-warning rounded p-3 text-sm">{data.meta.warning}</div>}
      {data && <DataQualityStrip data={data} />}

      {data && (
        <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
          <Summary label="Names" value={data.count} />
          <Summary label="Clean" value={data.summary.cleanMomentum} tone="profit" />
          <Summary label="Avoid" value={data.summary.avoid} tone="loss" />
          <Summary label="Avg Score" value={data.summary.avgScore.toFixed(1)} />
        </div>
      )}

      <div className="grid grid-cols-1 min-[1500px]:grid-cols-[minmax(0,1fr)_340px] gap-4">
        <div className="bg-card border border-card-border rounded-lg overflow-hidden">
          <div className="px-4 py-3 border-b border-card-border flex items-center justify-between">
            <div>
              <div className="text-sm font-semibold text-text-heading">Daily Radar Watchlist</div>
              <div className="text-xs text-muted">
                {data ? `${sorted.length}/${data.totalScored} visible after filters` : "Run the radar or upload CSV data"}
              </div>
            </div>
          </div>
          <div className="overflow-auto max-h-[620px]">
            <table className="w-full text-xs">
              <thead className="sticky top-0 bg-card z-10">
                <tr className="text-muted border-b border-card-border">
                  <Th label="Symbol" />
                  <Th label="LTP" sort="last_price" active={sortKey} onSort={setSortKey} />
                  <Th label="%" sort="change_pct" active={sortKey} onSort={setSortKey} />
                  <Th label="Vol x" sort="volume_vs_avg" active={sortKey} onSort={setSortKey} />
                  <Th label="Deliv" sort="delivery_pct" active={sortKey} onSort={setSortKey} />
                  <Th label="Breakout" />
                  <Th label="Circuit" />
                  <Th label="Liq" sort="liquidity_score" active={sortKey} onSort={setSortKey} />
                  <Th label="Risk" />
                  <Th label="Score" sort="alpha_score" active={sortKey} onSort={setSortKey} />
                  <Th label="Tag" />
                </tr>
              </thead>
              <tbody className="font-mono">
                {sorted.map((row) => (
                  <tr
                    key={row.symbol}
                    onClick={() => setSelected(row)}
                    className={cn("border-b border-card-border/30 hover:bg-hover-bg cursor-pointer", selected?.symbol === row.symbol && "bg-accent-bg/20")}
                  >
                    <td className="px-3 py-2 font-bold text-accent"><button type="button" onClick={() => setSelected(row)} aria-pressed={selected?.symbol === row.symbol}>{row.symbol}</button></td>
                    <td className="px-2 py-2 text-right">{formatNumber(row.last_price)}</td>
                    <td className={cn("px-2 py-2 text-right font-bold", row.change_pct >= 0 ? "text-profit" : "text-loss")}>{row.change_pct.toFixed(2)}%</td>
                    <td className="px-2 py-2 text-right">{row.volume_vs_avg.toFixed(1)}x</td>
                    <td className="px-2 py-2 text-right">{row.delivery_pct == null ? "-" : `${row.delivery_pct.toFixed(0)}%`}</td>
                    <td className="px-2 py-2">{row.breakout_status}</td>
                    <td className={cn("px-2 py-2", row.circuit_status === "Hit" ? "text-loss" : "text-muted")}>{row.circuit_status}</td>
                    <td className="px-2 py-2 text-right">{row.liquidity_score.toFixed(1)}</td>
                    <td className={cn("px-2 py-2", riskColor(row.risk_flag))}>{row.risk_flag}</td>
                    <td className="px-2 py-2 text-right text-lg font-bold text-accent">{row.alpha_score.toFixed(1)}</td>
                    <td className="px-3 py-2">
                      <button
                        type="button"
                        onClick={(event) => {
                          event.stopPropagation();
                          toggleWatch(row.symbol);
                        }}
                        className={cn("px-2 py-1 rounded text-[10px]", watchlist.has(row.symbol) ? "bg-accent text-white" : "bg-page-bg text-muted")}
                      >
                        {watchlist.has(row.symbol) ? "Saved" : "Watch"}
                      </button>
                    </td>
                  </tr>
                ))}
                {!sorted.length && (
                  <tr>
                    <td colSpan={11} className="py-12 text-center">
                      <div className="text-sm text-muted">{data ? "No names match the current filters." : "No scan results yet."}</div>
                      <div className="text-xs text-muted mt-1">
                        {data ? "Loosen the volume/change thresholds or clear search to widen the radar." : "Run the radar to load live abnormal-momentum candidates."}
                      </div>
                      <button
                        type="button"
                        onClick={data ? resetFiltersAndScan : () => runRadar()}
                        disabled={loading || refreshing}
                        className="mt-3 px-3 py-2 rounded bg-accent text-white text-xs font-semibold disabled:opacity-50"
                      >
                        {data ? "Reset Filters" : "Run Radar"}
                      </button>
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        </div>

        <StockDetailPanel stock={selected} />
      </div>
    </div>
  );
}

function FilterNumber({ label, value, onChange }: { label: string; value: number; onChange: (value: number) => void }) {
  return (
    <label className="text-xs text-muted">
      {label}
      <input
        type="number"
        step="0.5"
        value={value}
        onChange={(e) => onChange(Number(e.target.value) || 0)}
        className="mt-1 w-full bg-page-bg border border-card-border rounded px-2 py-2 text-foreground"
      />
    </label>
  );
}

function Toggle({ label, checked, onChange }: { label: string; checked: boolean; onChange: (value: boolean) => void }) {
  return (
    <label className="flex items-center gap-2 text-xs text-muted bg-page-bg border border-card-border rounded px-3 py-2">
      <input type="checkbox" checked={checked} onChange={(e) => onChange(e.target.checked)} />
      {label}
    </label>
  );
}

function Summary({ label, value, tone }: { label: string; value: number | string; tone?: "profit" | "loss" }) {
  return (
    <div className="bg-card border border-card-border rounded p-3">
      <div className="text-xs text-muted">{label}</div>
      <div className={cn("text-2xl font-bold", tone === "profit" && "text-profit", tone === "loss" && "text-loss")}>{value}</div>
    </div>
  );
}

function DataQualityStrip({ data }: { data: RadarResponse }) {
  const quoteRequested = data.meta.provider?.requested ?? data.meta.universe?.requested ?? 0;
  const quoteReturned = data.meta.provider?.returned ?? data.meta.universe?.quoted ?? 0;
  const quoteCoverage = quoteRequested ? Math.round((quoteReturned / quoteRequested) * 100) : 0;
  const q = data.meta.dataQuality;
  const relaxed = data.meta.filters?.relaxedVolumeFilter;
  const sessionFallback = data.source === "live-cache" || Boolean(data.meta.cache?.sessionFallback) || Boolean(data.cached);

  return (
    <div className="grid grid-cols-2 lg:grid-cols-5 gap-3">
      <QualityMetric
        label="Provider"
        value={(data.meta.provider?.provider || data.source).toUpperCase()}
        sub={sessionFallback ? "last good scan" : data.meta.provider?.fallback ? "fallback active" : "primary feed"}
        tone={sessionFallback || data.meta.provider?.fallback ? "warning" : "profit"}
      />
      <QualityMetric label="Quotes" value={`${quoteCoverage || "-"}%`} sub={`${quoteReturned}/${quoteRequested || "-"}`} tone={quoteCoverage >= 90 ? "profit" : quoteCoverage >= 50 ? "warning" : "loss"} />
      <QualityMetric label="Volume Context" value={q?.avgVolumeCoveragePct == null ? "-" : `${q.avgVolumeCoveragePct}%`} sub={relaxed ? "filter relaxed" : `${q?.avgVolumeHits ?? 0} cached`} tone={relaxed ? "warning" : qualityTone(q?.avgVolumeCoveragePct)} />
      <QualityMetric label="Delivery Context" value={q?.deliveryCoveragePct == null ? "-" : `${q.deliveryCoveragePct}%`} sub={`${q?.deliveryHits ?? 0} cached`} tone={qualityTone(q?.deliveryCoveragePct)} />
      <QualityMetric label="PDH Context" value={q?.pdhCoveragePct == null ? "-" : `${q.pdhCoveragePct}%`} sub={`${q?.pdhHits ?? 0} cached`} tone={qualityTone(q?.pdhCoveragePct)} />
    </div>
  );
}

function QualityMetric({ label, value, sub, tone }: { label: string; value: string; sub: string; tone?: "profit" | "warning" | "loss" }) {
  return (
    <div className="bg-card border border-card-border rounded p-3">
      <div className="text-xs text-muted">{label}</div>
      <div className={cn("text-lg font-bold font-mono", tone === "profit" && "text-profit", tone === "warning" && "text-warning", tone === "loss" && "text-loss")}>{value}</div>
      <div className="text-[11px] text-muted truncate" title={sub}>{sub}</div>
    </div>
  );
}

function qualityTone(value?: number): "profit" | "warning" | "loss" {
  if (value == null) return "warning";
  if (value >= 70) return "profit";
  if (value >= 25) return "warning";
  return "loss";
}

function Th({ label, sort, active, onSort }: { label: string; sort?: SortKey; active?: SortKey; onSort?: (sort: SortKey) => void }) {
  return (
    <th className="px-2 py-2 text-left whitespace-nowrap">
      {sort && onSort ? (
        <button type="button" onClick={() => onSort(sort)} className={cn("hover:text-accent", active === sort && "text-accent")}>
          {label}
        </button>
      ) : label}
    </th>
  );
}

function StockDetailPanel({ stock }: { stock: AbnormalMove | null }) {
  if (!stock) {
    return (
      <div className="bg-card border border-card-border rounded-lg p-6 text-sm text-muted">
        Select a stock to see score reasons, abnormal candles, breakout levels, and invalidation.
      </div>
    );
  }

  const breakdown = [
    ["Volume", stock.score_breakdown.volume_expansion, 2],
    ["Delivery", stock.score_breakdown.delivery_strength, 2],
    ["Breakout", stock.score_breakdown.breakout, 2],
    ["Theme", stock.score_breakdown.sector_support, 1],
    ["Deals", stock.score_breakdown.institutional_footprint, 1],
    ["Liquidity", stock.score_breakdown.liquidity_quality, 1],
    ["Cleanliness", stock.score_breakdown.governance_cleanliness, 1],
  ] as const;

  return (
    <div className="bg-card border border-card-border rounded-lg overflow-hidden">
      <div className="px-4 py-3 border-b border-card-border">
        <div className="flex items-start justify-between">
          <div>
            <div className="font-mono text-2xl font-bold text-accent">{stock.symbol}</div>
            <div className="text-xs text-muted">{stock.sector} / {stock.market_cap_bucket}</div>
          </div>
          <div className="text-right">
            <div className="text-3xl font-bold text-accent">{stock.alpha_score.toFixed(1)}</div>
            <div className="text-xs text-muted">/10</div>
          </div>
        </div>
        <div className={cn("mt-2 text-sm font-semibold", riskColor(stock.risk_flag))}>{stock.risk_flag}</div>
      </div>

      <div className="p-4 space-y-4">
        <div className="grid grid-cols-2 gap-2 text-xs">
          <DetailMetric label="Breakout" value={stock.breakout_status} />
          <DetailMetric label="Invalidation" value={stock.invalidation_level ? formatNumber(stock.invalidation_level) : "-"} />
          <DetailMetric label="Turnover" value={`${stock.turnover_lakh.toFixed(0)}L`} />
          <DetailMetric label="Volume" value={`${stock.volume_vs_avg.toFixed(1)}x`} />
        </div>

        <Link
          href={`/stocks?symbol=${encodeURIComponent(stock.symbol)}&universe=all`}
          className="block w-full text-center px-3 py-2 rounded bg-accent text-white text-xs font-semibold hover:bg-accent/80"
        >
          Open Chart
        </Link>
        <button
          type="button"
          onClick={() => {
            window.sessionStorage.setItem(RADAR_CANDIDATE_STORAGE_KEY, JSON.stringify(toRadarCandidate(stock)));
            window.open(`/radar-trade?symbol=${encodeURIComponent(stock.symbol)}`, "_self");
          }}
          className="block w-full text-center px-3 py-2 rounded border border-card-border text-xs font-semibold text-foreground hover:bg-hover-bg"
        >
          Decision Cockpit
        </button>

        <div>
          <div className="text-xs font-semibold text-text-heading mb-2">Score Build</div>
          <div className="space-y-2">
            {breakdown.map(([label, value, max]) => (
              <div key={label}>
                <div className="flex justify-between text-[11px] text-muted mb-1">
                  <span>{label}</span>
                  <span>{value}/{max}</span>
                </div>
                <div className="h-2 rounded bg-page-bg overflow-hidden">
                  <div className="h-full bg-accent" style={{ width: `${(value / max) * 100}%` }} />
                </div>
              </div>
            ))}
          </div>
        </div>

        <div>
          <div className="text-xs font-semibold text-text-heading mb-2">Why It Scored</div>
          <div className="space-y-1">
            {stock.reasons.map((reason) => (
              <div key={reason} className="text-xs text-muted">- {reason}</div>
            ))}
            {!stock.reasons.length && <div className="text-xs text-muted">No strong abnormal factor yet.</div>}
          </div>
        </div>

        <div className="bg-warning/10 border border-warning/20 rounded p-3 text-xs text-warning">
          Suggested invalidation is a screening level, not a buy/sell recommendation. Confirm liquidity, news, ASM/GSM status, and execution risk before acting.
        </div>
      </div>
    </div>
  );
}

function toRadarCandidate(stock: AbnormalMove) {
  const bias = stock.change_pct >= 0 ? "LONG" : "SHORT";
  const stop = stock.invalidation_level || (bias === "LONG" ? stock.last_price * 0.97 : stock.last_price * 1.03);
  const risk = Math.abs(stock.last_price - stop);
  const target = bias === "LONG" ? stock.last_price + risk * 2 : stock.last_price - risk * 2;
  return {
    symbol: stock.symbol,
    bias,
    score: Math.round(stock.alpha_score * 10),
    quality: stock.alpha_score >= 8.5 ? "A_PLUS" : stock.alpha_score >= 7.5 ? "A" : stock.alpha_score >= 6.5 ? "B" : "WATCH",
    action: stock.alpha_score >= 8 ? "CONFIRM" : "WAIT",
    setups: ["ABNORMAL_MOMENTUM", stock.breakout_status, stock.risk_flag],
    entry: stock.last_price,
    stop,
    target1: target,
    target2: null,
    riskReward: risk > 0 ? Math.abs(target - stock.last_price) / risk : null,
    invalidation: stock.invalidation_level
      ? `Abnormal-move thesis invalidates beyond ${formatNumber(stock.invalidation_level)}.`
      : "No clean invalidation level found; use small size or wait.",
    ltp: stock.last_price,
    changePct: stock.change_pct,
    volume: 0,
    volRatio: stock.volume_vs_avg,
    rFactor: risk > 0 ? Math.abs(target - stock.last_price) / risk : 0,
    vwap: null,
    pdh: null,
    pdl: null,
    sector: stock.sector,
    freshness: { status: "fresh", ageSeconds: null },
    dataWarnings: ["Abnormal momentum setup adapted into the intraday decision cockpit."],
    reasons: stock.reasons,
  };
}

function DetailMetric({ label, value }: { label: string; value: string }) {
  return (
    <div className="bg-page-bg rounded p-2 min-w-0">
      <div className="text-[10px] text-muted">{label}</div>
      <div className="font-mono font-semibold text-foreground truncate" title={value}>{value}</div>
    </div>
  );
}

function riskColor(flag: RiskFlag | string) {
  if (flag === "Clean Momentum") return "text-profit";
  if (flag === "Watch Carefully" || flag === "News-Only Move") return "text-warning";
  return "text-loss";
}

function sourceLabel(data: RadarResponse) {
  if (data.source === "payload") return "Uploaded/payload data.";
  if (data.source === "sample") return "Sample data.";
  if (data.cached && data.cachedAt && data.source !== "live-cache") {
    return `Snapshot replay from ${new Date(data.cachedAt).toLocaleTimeString("en-IN", { hour: "2-digit", minute: "2-digit" })}.`;
  }
  const provider = data.meta.provider?.provider?.toUpperCase() || "LIVE";
  const returned = data.meta.provider?.returned ?? data.meta.universe?.quoted;
  const requested = data.meta.provider?.requested ?? data.meta.universe?.requested;
  const sessionFallback = data.source === "live-cache" || Boolean(data.meta.cache?.sessionFallback);
  if (sessionFallback) {
    const cachedAt = data.cachedAt ? ` from ${new Date(data.cachedAt).toLocaleTimeString("en-IN", { hour: "2-digit", minute: "2-digit" })}` : "";
    return `Last good ${provider} scan${returned != null && requested != null ? ` ${returned}/${requested}` : ""}${cachedAt}.`;
  }
  const cache = data.meta.cache?.hit ? ` cached ${data.meta.cache.ageSeconds}s ago` : "";
  const fallback = data.meta.provider?.fallback ? " with fallback" : "";
  return `Live ${provider}${fallback}${returned != null && requested != null ? ` ${returned}/${requested}` : ""}${cache}.`;
}
