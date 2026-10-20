"use client";

import { Suspense, useEffect, useState, useCallback } from "react";
import { useSearchParams } from "next/navigation";
import { fetchAPI, postAPI } from "../lib/api";
import { formatNumber, cn, profitLossColor } from "../lib/utils";
import {
  type UniverseKey,
  UNIVERSE_META,
  getUniverse,
  getSector,
  getAllSectors,
  getSectorStocks,
  getIndexMembership,
} from "../lib/stock-universe";
import { CandlestickChart } from "../components/charts/CandlestickChart";

import { PageHeader } from "../components/layout/PageHeader";
import { SubTabs } from "../components/layout/SubTabs";

interface StockQuote {
  symbol: string;
  sector: string;
  last: number;
  change: number;
  changePercent: number;
  volume: number;
  open: number;
  high: number;
  low: number;
}

interface BarData {
  date: string;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

type SortField = "changePercent" | "volume" | "symbol" | "last" | "sector";

const INDEX_SYMBOLS = ["NIFTY 50", "NIFTY BANK"];

export default function StocksPageWrapper() {
  return (
    <Suspense fallback={<div className="flex items-center justify-center h-64"><div className="animate-pulse text-accent">Loading stocks...</div></div>}>
      <StocksPage />
    </Suspense>
  );
}

function StocksPage() {
  const searchParams = useSearchParams();
  const paramSymbol = searchParams.get("symbol");
  const requestedUniverse = searchParams.get("universe");
  const paramUniverse = requestedUniverse && Object.hasOwn(UNIVERSE_META, requestedUniverse) ? requestedUniverse as UniverseKey : null;

  const [universe, setUniverse] = useState<UniverseKey>(paramUniverse || "nifty50");

  // Sync universe from URL params
  useEffect(() => {
    if (paramUniverse) {
      setUniverse(paramUniverse);
    }
  }, [paramUniverse]);

  // Listen for navbar search click event (when already on /stocks)
  useEffect(() => {
    const handler = () => setUniverse("all");
    window.addEventListener("switch-to-all-stocks", handler);
    return () => window.removeEventListener("switch-to-all-stocks", handler);
  }, []);

  const [stocks, setStocks] = useState<StockQuote[]>([]);
  const [quotesError, setQuotesError] = useState("");
  const [loading, setLoading] = useState(true);
  const [filter, setFilter] = useState("");
  const [sectorFilter, setSectorFilter] = useState("All");
  const [sortBy, setSortBy] = useState<SortField>("changePercent");
  const [sortDir, setSortDir] = useState<"asc" | "desc">("desc");

  // All Stocks search state
  const [allSearchQuery, setAllSearchQuery] = useState("");
  const [allSearchResult, setAllSearchResult] = useState<StockQuote | null>(null);
  const [allSearchLoading, setAllSearchLoading] = useState(false);
  const [allSearchError, setAllSearchError] = useState<string | null>(null);
  const [suggestions, setSuggestions] = useState<{ symbol: string; name: string }[]>([]);
  const [showSuggestions, setShowSuggestions] = useState(false);
  const [instrumentList, setInstrumentList] = useState<{ symbol: string; name: string }[]>([]);

  // Fetch instrument list for typeahead (NSE + BSE equities)
  useEffect(() => {
    async function loadInstruments() {
      try {
        const res = await fetchAPI<any>("/api/instruments-list");
        if (Array.isArray(res)) {
          const seen = new Set<string>();
          const list: { symbol: string; name: string }[] = [];
          for (const i of res) {
            if (i.exchange === "NSE" && i.symbol && i.name) {
              if (!seen.has(i.symbol)) {
                seen.add(i.symbol);
                list.push({ symbol: i.symbol, name: i.name });
              }
            }
          }
          for (const i of res) {
            if (i.exchange === "BSE" && i.symbol && i.name) {
              if (!seen.has(i.symbol)) {
                seen.add(i.symbol);
                list.push({ symbol: i.symbol, name: i.name });
              }
            }
          }
          setInstrumentList(list);
        }
      } catch {}
    }
    loadInstruments();
  }, []);

  // Auto-suggest as user types
  useEffect(() => {
    const q = allSearchQuery.trim().toUpperCase();
    if (q.length < 2) {
      setSuggestions([]);
      setShowSuggestions(false);
      return;
    }
    const matches = instrumentList
      .filter((i) =>
        i.symbol.toUpperCase().includes(q) ||
        i.name.toUpperCase().includes(q)
      )
      .slice(0, 8);
    setSuggestions(matches);
    setShowSuggestions(matches.length > 0);
  }, [allSearchQuery, instrumentList]);

  // Chart state
  const [chartSymbol, setChartSymbol] = useState<string | null>(paramSymbol || null);
  const [chartData, setChartData] = useState<BarData[]>([]);
  const [chartLoading, setChartLoading] = useState(false);
  const [chartError, setChartError] = useState<string | null>(null);
  const [chartInterval, setChartInterval] = useState("day");
  const [chartDays, setChartDays] = useState("180");

  const loadQuotes = useCallback(async () => {
    if (universe === "all") {
      setLoading(false);
      return;
    }
    const symbols = getUniverse(universe);
    try {
      let data: Record<string, any>;
      if (symbols.length <= 50) {
        const res = await fetchAPI(`/api/quotes?symbols=${symbols.join(",")}`);
        data = res.success ? res.data : {};
      } else {
        const res = await postAPI("/api/quotes/batch", { symbols });
        data = res.success ? res.data : {};
      }

      const parsed: StockQuote[] = Object.entries(data).map(
        ([key, q]: [string, any]) => {
          const sym = key.replace("NSE:", "");
          return {
            symbol: sym,
            sector: getSector(sym),
            last: q.last_price,
            change: q.net_change || (q.last_price - (q.ohlc?.close || 0)),
            changePercent: q.ohlc?.close
              ? ((q.last_price - q.ohlc.close) / q.ohlc.close) * 100
              : 0,
            volume: q.volume || 0,
            open: q.ohlc?.open || 0,
            high: q.ohlc?.high || 0,
            low: q.ohlc?.low || 0,
          };
        }
      );
      setStocks(parsed);
      setQuotesError(parsed.length ? "" : "No quotes are available from the feed for this universe.");
    } catch { setQuotesError("Quotes could not be refreshed. Please try again."); }
    setLoading(false);
  }, [universe]);

  // Auto-close chart when universe changes
  useEffect(() => {
    setLoading(true);
    setStocks([]);
    setSectorFilter("All");
    setAllSearchResult(null);
    setAllSearchError(null);
    setChartSymbol(null);
    loadQuotes();
    if (universe === "all") return;
    const interval = setInterval(loadQuotes, universe === "nifty50" ? 10000 : 30000);
    return () => clearInterval(interval);
  }, [loadQuotes, universe]);

  // Load chart when symbol or settings change
  const loadChart = useCallback(async (sym: string) => {
    setChartLoading(true);
    setChartError(null);
    try {
      const res = await fetchAPI(
        `/api/quotes/history?symbol=${encodeURIComponent(sym)}&interval=${chartInterval}&days=${chartDays}`
      );
      if (res.success) {
        const formatted = res.data.map((bar: any) => ({
          ...bar,
          date: new Date(bar.date).toISOString().split("T")[0],
        }));
        setChartData(formatted);
      } else {
        setChartError(res.error || "Failed to load");
      }
    } catch {
      setChartError("Gateway not reachable.");
    }
    setChartLoading(false);
  }, [chartInterval, chartDays]);

  useEffect(() => {
    if (chartSymbol) loadChart(chartSymbol);
  }, [chartSymbol, loadChart]);

  // Load chart from URL param on mount
  useEffect(() => {
    if (paramSymbol) {
      setChartSymbol(paramSymbol);
    }
  }, [paramSymbol]);

  // All Stocks search
  async function handleAllSearch(value = allSearchQuery) {
    const sym = value.trim().toUpperCase();
    if (!sym) return;
    setAllSearchLoading(true);
    setAllSearchError(null);
    setAllSearchResult(null);
    try {
      const res = await fetchAPI(`/api/quotes?symbols=${encodeURIComponent(sym)}`);
      if (res.success && res.data) {
        const entry = Object.entries(res.data)[0];
        if (entry) {
          const [key, q] = entry as [string, any];
          const symbol = key.replace("NSE:", "");
          setAllSearchResult({
            symbol,
            sector: getSector(symbol),
            last: q.last_price,
            change: q.net_change || (q.last_price - (q.ohlc?.close || 0)),
            changePercent: q.ohlc?.close
              ? ((q.last_price - q.ohlc.close) / q.ohlc.close) * 100
              : 0,
            volume: q.volume || 0,
            open: q.ohlc?.open || 0,
            high: q.ohlc?.high || 0,
            low: q.ohlc?.low || 0,
          });
        } else {
          setAllSearchError("No data found for this symbol.");
        }
      } else {
        setAllSearchError(res.error || "Symbol not found.");
      }
    } catch {
      setAllSearchError("Failed to fetch quote. Check the symbol and try again.");
    }
    setAllSearchLoading(false);
  }

  // Compute sector peers for chart quick-switch
  const chartPeers = (() => {
    if (!chartSymbol) return [];
    const sector = getSector(chartSymbol);
    const sectorStocks = getSectorStocks(sector);
    const peers = [chartSymbol, ...sectorStocks.filter((s) => s !== chartSymbol)];
    if (peers.length < 8) {
      for (const idx of INDEX_SYMBOLS) {
        if (!peers.includes(idx)) peers.push(idx);
        if (peers.length >= 10) break;
      }
    }
    return peers.slice(0, 12);
  })();

  function handleStockClick(symbol: string) {
    setChartSymbol(symbol);
    setTimeout(() => {
      document.getElementById("stock-chart-section")?.scrollIntoView({ behavior: "smooth", block: "start" });
    }, 100);
  }

  const universeSymbols = getUniverse(universe);
  const sectors = ["All", ...getAllSectors(universeSymbols)];

  // Sector stock counts for dropdown labels
  const sectorCounts: Record<string, number> = {};
  for (const s of sectors) {
    if (s === "All") continue;
    sectorCounts[s] = stocks.filter((st) => st.sector === s).length;
  }

  const filtered = stocks
    .filter((s) => {
      if (filter && !s.symbol.toLowerCase().includes(filter.toLowerCase())) return false;
      if (sectorFilter !== "All" && s.sector !== sectorFilter) return false;
      return true;
    })
    .sort((a, b) => {
      const dir = sortDir === "desc" ? -1 : 1;
      if (sortBy === "symbol" || sortBy === "sector")
        return dir * (a[sortBy] || "").localeCompare(b[sortBy] || "");
      return dir * ((a[sortBy] || 0) - (b[sortBy] || 0));
    });

  function toggleSort(col: SortField) {
    if (sortBy === col) setSortDir(sortDir === "desc" ? "asc" : "desc");
    else { setSortBy(col); setSortDir("desc"); }
  }

  const sortIndicator = (col: SortField) =>
    sortBy === col ? (sortDir === "asc" ? " +" : " -") : "";

  const gainers = stocks.filter((s) => s.changePercent > 0).length;
  const losers = stocks.filter((s) => s.changePercent < 0).length;
  const unchanged = stocks.length - gainers - losers;
  const avgChange = stocks.length
    ? stocks.reduce((sum, s) => sum + s.changePercent, 0) / stocks.length
    : 0;

  // CPR levels from chart data
  const cprLevels = chartData.length > 20 ? (() => {
    const lastBar = chartData[chartData.length - 1];
    const lastMonth = new Date(lastBar.date).getMonth();
    const prevMonthBars = chartData.filter((d) => {
      const m = new Date(d.date).getMonth();
      return m === (lastMonth === 0 ? 11 : lastMonth - 1);
    });
    if (prevMonthBars.length === 0) return undefined;
    const h = Math.max(...prevMonthBars.map((b) => b.high));
    const l = Math.min(...prevMonthBars.map((b) => b.low));
    const c = prevMonthBars[prevMonthBars.length - 1].close;
    const bc = (h + l) / 2;
    const pivot = (h + l + c) / 3;
    const tc = pivot + (pivot - bc);
    const r1 = 2 * pivot - l;
    const s1 = 2 * pivot - h;
    return { pivot: +pivot.toFixed(2), bc: +bc.toFixed(2), tc: +tc.toFixed(2), r1: +r1.toFixed(2), s1: +s1.toFixed(2) };
  })() : undefined;

  return (
    <div className="max-w-[1400px] mx-auto space-y-4">
      <PageHeader eyebrow="Discover" title="Stock screener" description="Explore price, volume, sector peers and chart structure across the market." />
      <SubTabs tabs={(Object.keys(UNIVERSE_META) as UniverseKey[]).map(key => ({ key, label: UNIVERSE_META[key].label }))} active={universe} onChange={setUniverse} />
      {universe !== "all" && quotesError && <div role="status" className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-warning/30 bg-warning/5 p-4 text-sm"><span>{quotesError}{stocks.length > 0 ? " Previously loaded quotes remain visible." : ""}</span><button className="workspace-button" disabled={loading} onClick={loadQuotes}>Retry quotes</button></div>}

      {/* Row 2: Stats + Sector dropdown + Search (for non-all universes) */}
      {universe !== "all" && stocks.length > 0 && (
        <div className="flex items-center justify-between flex-wrap gap-3">
          {/* Left: Stats badges */}
          <div className="flex gap-2 text-xs flex-wrap">
            <div className="bg-card border border-card-border rounded px-3 py-1.5">
              <span className="text-muted">Loaded: </span><span className="font-medium">{stocks.length}</span>
            </div>
            <div className="bg-card border border-card-border rounded px-3 py-1.5">
              <span className="text-profit font-medium">{gainers}</span><span className="text-muted"> up</span>
            </div>
            <div className="bg-card border border-card-border rounded px-3 py-1.5">
              <span className="text-loss font-medium">{losers}</span><span className="text-muted"> down</span>
            </div>
            <div className="bg-card border border-card-border rounded px-3 py-1.5">
              <span className="text-muted">{unchanged} flat</span>
            </div>
            <div className="bg-card border border-card-border rounded px-3 py-1.5">
              <span className="text-muted">Avg: </span>
              <span className={cn("font-medium", profitLossColor(avgChange))}>
                {avgChange >= 0 ? "+" : ""}{avgChange.toFixed(2)}%
              </span>
            </div>
          </div>

          {/* Right: Sector dropdown + Search */}
          <div className="flex items-center gap-2">
            <select
              aria-label="Filter by sector"
              value={sectorFilter}
              onChange={(e) => setSectorFilter(e.target.value)}
              className="bg-card border border-card-border rounded px-3 py-1.5 text-sm text-foreground focus:border-accent focus:outline-none appearance-none cursor-pointer pr-8"
              style={{ backgroundImage: `url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='12' height='12' viewBox='0 0 24 24' fill='none' stroke='%236b7280' stroke-width='2' stroke-linecap='round' stroke-linejoin='round'%3E%3Cpolyline points='6 9 12 15 18 9'%3E%3C/polyline%3E%3C/svg%3E")`, backgroundRepeat: 'no-repeat', backgroundPosition: 'right 8px center' }}
            >
              <option value="All">All Sectors</option>
              {sectors.filter((s) => s !== "All").map((s) => (
                <option key={s} value={s}>
                  {s} ({sectorCounts[s] || 0})
                </option>
              ))}
            </select>
            <div className="relative">
              <input
                type="text"
                aria-label="Filter symbols"
                placeholder="Search symbol..."
                value={filter}
                onChange={(e) => setFilter(e.target.value)}
                className="bg-card border border-card-border rounded pl-8 pr-3 py-1.5 text-sm text-foreground placeholder:text-muted focus:border-accent focus:outline-none w-48"
              />
              <svg className="absolute left-2.5 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-muted" xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" strokeWidth={2} stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" d="M21 21l-5.197-5.197m0 0A7.5 7.5 0 105.196 5.196a7.5 7.5 0 0010.607 10.607z" />
              </svg>
            </div>
          </div>
        </div>
      )}

      {/* Row 2 for "All" tab: Search bar on the right */}
      {universe === "all" && (
        <div className="flex items-center justify-end">
          <div className="relative">
            <form
              onSubmit={(e) => { e.preventDefault(); setShowSuggestions(false); handleAllSearch(); }}
              className="flex gap-2"
            >
              <div className="relative">
                <input
                  type="text"
                  aria-label="Search all stocks"
                  placeholder="Search by symbol or company name..."
                  value={allSearchQuery}
                  onChange={(e) => setAllSearchQuery(e.target.value)}
                  onFocus={() => suggestions.length > 0 && setShowSuggestions(true)}
                  onBlur={() => setTimeout(() => setShowSuggestions(false), 200)}
                  className="bg-card border border-card-border rounded-lg pl-9 pr-4 py-2 text-sm text-foreground placeholder:text-muted focus:border-accent focus:outline-none w-[min(70vw,360px)]"
                />
                <svg className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted" xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" strokeWidth={2} stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" d="M21 21l-5.197-5.197m0 0A7.5 7.5 0 105.196 5.196a7.5 7.5 0 0010.607 10.607z" />
                </svg>
                {/* Suggestions dropdown */}
                {showSuggestions && (
                  <div className="absolute top-full left-0 right-0 mt-1 bg-card border border-card-border rounded-lg shadow-xl z-50 max-h-[300px] overflow-y-auto">
                    {suggestions.map((s) => (
                      <button
                        key={s.symbol}
                        type="button"
                        onMouseDown={event => event.preventDefault()}
                        onClick={() => {
                          setAllSearchQuery(s.symbol);
                          setShowSuggestions(false);
                          handleAllSearch(s.symbol);
                        }}
                        className="w-full text-left px-4 py-2.5 hover:bg-surface-hover transition-colors flex items-center justify-between border-b border-card-border/50 last:border-0"
                      >
                        <div>
                          <span className="text-sm font-semibold text-foreground font-mono">{s.symbol}</span>
                          {s.name && <span className="text-xs text-muted ml-2">{s.name}</span>}
                        </div>
                        <span className="text-[10px] text-muted">{getSector(s.symbol)}</span>
                      </button>
                    ))}
                  </div>
                )}
              </div>
              <button
                type="submit"
                disabled={allSearchLoading || !allSearchQuery.trim()}
                className="px-4 py-2 bg-accent text-white rounded-lg text-sm font-medium hover:bg-accent/90 disabled:opacity-50 transition-colors whitespace-nowrap"
              >
                {allSearchLoading ? "..." : "Go"}
              </button>
            </form>
          </div>
        </div>
      )}

      {/* Chart Section - shown when a stock is selected */}
      {chartSymbol && (
        <div id="stock-chart-section" className="grid grid-cols-1 lg:grid-cols-[1fr_280px] gap-4">
          {/* Left: Chart */}
          <div className="bg-card border border-card-border rounded-xl overflow-hidden">
            <div className="flex items-center justify-between px-4 py-3 border-b border-card-border">
              <div className="flex items-center gap-3">
                <span className="font-medium font-mono text-lg">{chartSymbol}</span>
                {chartData.length > 0 && (
                  <>
                    <span className="text-sm font-mono">{formatNumber(chartData[chartData.length - 1].close)}</span>
                    {chartData.length >= 2 && (() => {
                      const last = chartData[chartData.length - 1].close;
                      const prev = chartData[chartData.length - 2].close;
                      const change = ((last - prev) / prev) * 100;
                      return (
                        <span className={cn("text-xs font-medium", change >= 0 ? "text-profit" : "text-loss")}>
                          {change >= 0 ? "+" : ""}{change.toFixed(2)}%
                        </span>
                      );
                    })()}
                  </>
                )}
              </div>
              <div className="flex items-center gap-2">
                <div className="flex gap-0.5 bg-background border border-card-border rounded p-0.5">
                  {[
                    { value: "15minute", label: "15m" },
                    { value: "60minute", label: "1H" },
                    { value: "day", label: "1D" },
                    { value: "week", label: "1W" },
                  ].map((tf) => (
                    <button key={tf.value} onClick={() => setChartInterval(tf.value)}
                      className={cn("px-2 py-1 rounded text-xs",
                        chartInterval === tf.value ? "bg-accent text-white" : "text-muted hover:text-foreground")}>
                      {tf.label}
                    </button>
                  ))}
                </div>
                <div className="hidden sm:flex gap-0.5 bg-background border border-card-border rounded p-0.5">
                  {[
                    { value: "30", label: "1M" },
                    { value: "90", label: "3M" },
                    { value: "180", label: "6M" },
                    { value: "365", label: "1Y" },
                  ].map((d) => (
                    <button key={d.value} onClick={() => setChartDays(d.value)}
                      className={cn("px-2 py-1 rounded text-xs",
                        chartDays === d.value ? "bg-accent text-white" : "text-muted hover:text-foreground")}>
                      {d.label}
                    </button>
                  ))}
                </div>
                <button onClick={() => setChartSymbol(null)}
                  className="text-xs font-bold text-loss bg-loss/10 hover:bg-loss/20 border border-loss/30 hover:border-loss/50 px-3 py-1.5 rounded-lg transition-colors">
                  Close
                </button>
              </div>
            </div>

            {chartError && (
              <div className="px-4 py-3 text-loss text-sm">{chartError}</div>
            )}

            {chartData.length > 0 && !chartLoading && (
              <CandlestickChart data={chartData} cprLevels={cprLevels} symbol={chartSymbol} height={450} />
            )}
            {chartLoading && (
              <div className="h-[450px] animate-pulse bg-card" />
            )}
          </div>

          {/* Right: Info Card */}
          <div className="bg-card border border-card-border rounded-xl overflow-hidden p-4 space-y-4">
            <div>
              <div className="text-lg font-bold font-mono text-foreground">{chartSymbol}</div>
              {chartData.length > 0 && (
                <div className="flex items-center gap-2 mt-1">
                  <span className="text-base font-mono font-medium">{formatNumber(chartData[chartData.length - 1].close)}</span>
                  {chartData.length >= 2 && (() => {
                    const last = chartData[chartData.length - 1].close;
                    const prev = chartData[chartData.length - 2].close;
                    const change = ((last - prev) / prev) * 100;
                    return (
                      <span className={cn("text-sm font-medium font-mono", change >= 0 ? "text-profit" : "text-loss")}>
                        {change >= 0 ? "+" : ""}{change.toFixed(2)}%
                      </span>
                    );
                  })()}
                </div>
              )}
            </div>

            <div>
              <span className="px-2.5 py-1 rounded-full text-xs font-medium bg-accent/10 text-accent border border-accent/20">
                {getSector(chartSymbol)}
              </span>
            </div>

            <div>
              <div className="text-[10px] text-muted uppercase tracking-wider mb-1.5">Index Membership</div>
              <div className="flex flex-wrap gap-1">
                {getIndexMembership(chartSymbol).map((tag) => (
                  <span key={tag} className="px-2 py-0.5 rounded text-[10px] bg-card-border/30 text-muted border border-card-border">
                    {tag}
                  </span>
                ))}
                {getIndexMembership(chartSymbol).length === 0 && (
                  <span className="text-[10px] text-muted">--</span>
                )}
              </div>
            </div>

            {cprLevels && (
              <div>
                <div className="text-[10px] text-muted uppercase tracking-wider mb-1.5">Key Levels</div>
                <div className="grid grid-cols-2 gap-x-3 gap-y-1 text-xs font-mono">
                  <div className="flex justify-between">
                    <span className="text-muted">Pivot</span>
                    <span className="text-accent">{formatNumber(cprLevels.pivot)}</span>
                  </div>
                  <div className="flex justify-between">
                    <span className="text-muted">TC</span>
                    <span className="text-profit">{formatNumber(cprLevels.tc)}</span>
                  </div>
                  <div className="flex justify-between">
                    <span className="text-muted">BC</span>
                    <span className="text-profit">{formatNumber(cprLevels.bc)}</span>
                  </div>
                  <div className="flex justify-between">
                    <span className="text-muted">R1</span>
                    <span className="text-loss">{formatNumber(cprLevels.r1)}</span>
                  </div>
                  <div className="flex justify-between">
                    <span className="text-muted">S1</span>
                    <span className="text-loss">{formatNumber(cprLevels.s1)}</span>
                  </div>
                </div>
              </div>
            )}

            <div>
              <div className="text-[10px] text-muted uppercase tracking-wider mb-1.5">Sector Peers</div>
              <div className="flex flex-wrap gap-1.5 max-h-[220px] overflow-y-auto">
                {chartPeers.map((s) => (
                  <button
                    key={s}
                    onClick={() => setChartSymbol(s)}
                    className={cn(
                      "px-2.5 py-1 rounded-lg text-xs font-medium transition-colors border whitespace-nowrap",
                      s === chartSymbol
                        ? "bg-accent text-white border-accent"
                        : "bg-background text-foreground border-card-border hover:border-accent/50 hover:text-accent"
                    )}
                  >
                    {s}
                  </button>
                ))}
              </div>
            </div>
          </div>
        </div>
      )}

      {/* All Stocks content area */}
      {universe === "all" && (
        <>
          {allSearchError && (
            <div className="text-center text-loss text-sm py-2">{allSearchError}</div>
          )}

          {/* Compact search result card */}
          {allSearchResult && (
            <div
              className="bg-card border border-card-border rounded-xl p-5 space-y-4 cursor-pointer hover:bg-hover-bg transition-colors"
              onClick={() => handleStockClick(allSearchResult.symbol)}
            >
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-3">
                  <span className="text-xl font-semibold font-mono text-foreground">{allSearchResult.symbol}</span>
                  <span className={cn("text-sm font-medium font-mono", profitLossColor(allSearchResult.changePercent))}>
                    {allSearchResult.changePercent >= 0 ? "+" : ""}{formatNumber(allSearchResult.changePercent)}%
                  </span>
                </div>
                <span className="text-xl font-mono font-medium">{formatNumber(allSearchResult.last)}</span>
              </div>

              <div className="flex flex-wrap gap-1.5">
                <span className="px-2 py-0.5 rounded text-xs bg-accent/10 text-accent border border-accent/20">
                  {allSearchResult.sector}
                </span>
                {getIndexMembership(allSearchResult.symbol).map((tag) => (
                  <span key={tag} className="px-2 py-0.5 rounded text-xs bg-card border border-card-border text-muted">
                    {tag}
                  </span>
                ))}
              </div>

              <div className="grid grid-cols-2 sm:grid-cols-5 gap-3 text-sm font-mono">
                <div className="space-y-0.5">
                  <div className="text-xs text-muted">Open</div>
                  <div>{formatNumber(allSearchResult.open)}</div>
                </div>
                <div className="space-y-0.5">
                  <div className="text-xs text-muted">High</div>
                  <div className="text-profit">{formatNumber(allSearchResult.high)}</div>
                </div>
                <div className="space-y-0.5">
                  <div className="text-xs text-muted">Low</div>
                  <div className="text-loss">{formatNumber(allSearchResult.low)}</div>
                </div>
                <div className="space-y-0.5">
                  <div className="text-xs text-muted">Change</div>
                  <div className={profitLossColor(allSearchResult.change)}>
                    {allSearchResult.change >= 0 ? "+" : ""}{formatNumber(allSearchResult.change)}
                  </div>
                </div>
                <div className="space-y-0.5">
                  <div className="text-xs text-muted">Volume</div>
                  <div>
                    {allSearchResult.volume > 10000000
                      ? `${(allSearchResult.volume / 10000000).toFixed(1)}Cr`
                      : `${(allSearchResult.volume / 100000).toFixed(1)}L`}
                  </div>
                </div>
              </div>

              <div className="text-xs text-muted text-center pt-1">Click to open chart</div>
            </div>
          )}

          {/* Full-page prompt only when no chart and no search result */}
          {!chartSymbol && !allSearchResult && !allSearchError && (
            <div className="bg-card border border-card-border rounded-xl p-12 text-center space-y-3">
              <h2 className="text-lg font-medium text-text-heading">Search Any Stock</h2>
              <p className="text-sm text-muted max-w-md mx-auto">
                Use the search bar above to look up any NSE stock by symbol or company name.
              </p>
            </div>
          )}
        </>
      )}

      {/* Table for non-all universes */}
      {universe !== "all" && (
        <div className="bg-card border border-card-border rounded-xl overflow-hidden">
          <div className="max-h-[70vh] overflow-auto">
            <table className="w-full text-sm">
              <thead className="sticky top-0 z-10">
                <tr className="border-b border-card-border bg-card-border/30 text-sm font-semibold text-foreground">
                  <th className="text-left px-4 py-2.5 cursor-pointer hover:text-accent transition-colors" onClick={() => toggleSort("symbol")}>
                    Symbol{sortIndicator("symbol")}
                  </th>
                  <th className="text-left px-2 py-2.5 cursor-pointer hover:text-accent transition-colors" onClick={() => toggleSort("sector")}>
                    Sector{sortIndicator("sector")}
                  </th>
                  <th className="text-right px-3 py-2.5 cursor-pointer hover:text-accent transition-colors" onClick={() => toggleSort("last")}>
                    LTP{sortIndicator("last")}
                  </th>
                  <th className="text-right px-3 py-2.5 cursor-pointer hover:text-accent transition-colors" onClick={() => toggleSort("changePercent")}>
                    Change %{sortIndicator("changePercent")}
                  </th>
                  <th className="text-right px-3 py-2.5">Open</th>
                  <th className="text-right px-3 py-2.5">High</th>
                  <th className="text-right px-3 py-2.5">Low</th>
                  <th className="text-right px-3 py-2.5 cursor-pointer hover:text-accent transition-colors" onClick={() => toggleSort("volume")}>
                    Volume{sortIndicator("volume")}
                  </th>
                </tr>
              </thead>
              <tbody className="font-mono">
                {loading
                  ? [...Array(15)].map((_, i) => (
                      <tr key={i} className="border-b border-card-border/50">
                        <td colSpan={8} className="px-4 py-3">
                          <div className="h-4 bg-card-border/30 rounded animate-pulse" />
                        </td>
                      </tr>
                    ))
                  : filtered.map((s) => (
                      <tr
                        key={s.symbol}
                        className={cn(
                          "border-b border-card-border/50 hover:bg-hover-bg cursor-pointer transition-colors",
                          chartSymbol === s.symbol && "bg-accent-bg/30"
                        )}
                        onClick={() => handleStockClick(s.symbol)}
                      >
                        <td className="px-4 py-2 font-medium text-foreground">{s.symbol}</td>
                        <td className="px-2 py-2 text-xs text-muted">{s.sector}</td>
                        <td className="text-right px-3 py-2">{formatNumber(s.last)}</td>
                        <td className={cn("text-right px-3 py-2 font-medium", profitLossColor(s.changePercent))}>
                          {s.changePercent >= 0 ? "+" : ""}{formatNumber(s.changePercent)}%
                        </td>
                        <td className="text-right px-3 py-2 text-muted">{formatNumber(s.open)}</td>
                        <td className="text-right px-3 py-2 text-profit">{formatNumber(s.high)}</td>
                        <td className="text-right px-3 py-2 text-loss">{formatNumber(s.low)}</td>
                        <td className="text-right px-3 py-2 text-muted">
                          {s.volume > 10000000 ? `${(s.volume / 10000000).toFixed(1)}Cr` : `${(s.volume / 100000).toFixed(1)}L`}
                        </td>
                      </tr>
                    ))}
              </tbody>
            </table>
            {!loading && filtered.length === 0 && (
              <div className="text-center py-8 text-muted">{stocks.length === 0 ? "No quotes available for this universe" : "No stocks match your filters"}</div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
