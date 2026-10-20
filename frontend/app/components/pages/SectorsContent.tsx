"use client";

import { PageHeader } from "../layout/PageHeader";

import { useEffect, useState, useCallback } from "react";
import Link from "next/link";
import { fetchAPI } from "../../lib/api";
import { formatNumber, cn, profitLossColor } from "../../lib/utils";
import { SECTOR_INDICES, type SectorIndex } from "../../lib/sector-indices";

interface SectorQuote {
  name: string;
  last: number;
  changePct: number;
  change: number;
}

interface StockData {
  symbol: string;
  last: number | null;
  prevClose: number | null;
  open: number | null;
  changePct: number | null;
  change: number | null;
  volume: number | null;
  avgVolume: number | null;
  volRatio: number | null;
  high: number | null;
  low: number | null;
  pdh: number | null;
  pdl: number | null;
  delivery: number | null;
  buyingScore: number | null;
  bearScore: number | null;
  vwap: number | null;
  orb: {
    high5?: number | null;
    low5?: number | null;
    high15?: number | null;
    low15?: number | null;
    high30?: number | null;
    low30?: number | null;
  } | null;
  orb5: ORBRead;
}

interface SectorWithStocks {
  index: SectorIndex;
  quote: SectorQuote | null;
  stocks: StockData[];
  advancing: number;
  declining: number;
}

function formatVol(v: number): string {
  if (v >= 10000000) return `${(v / 10000000).toFixed(1)}Cr`;
  if (v >= 100000) return `${(v / 100000).toFixed(1)}L`;
  return `${(v / 1000).toFixed(0)}K`;
}

function formatNullableVol(v: number | null): string {
  if (v == null || !Number.isFinite(v) || v <= 0) return "-";
  return formatVol(v);
}

type ORBRead = {
  label: string;
  tone: "profit" | "loss" | "warning" | "muted";
  exact: boolean;
};

function formatMaybeNumber(value?: number | null): string {
  if (value == null || !Number.isFinite(value)) return "-";
  return formatNumber(value);
}

function formatRatio(value?: number | null): string {
  if (value == null || !Number.isFinite(value) || value <= 0) return "-";
  return `${value.toFixed(1)}x`;
}

function rangePosition(stock: Pick<StockData, "last" | "high" | "low">): number | null {
  if (stock.last == null || stock.high == null || stock.low == null) return null;
  const range = stock.high - stock.low;
  if (range <= 0) return 0.5;
  return Math.max(0, Math.min(1, (stock.last - stock.low) / range));
}

function orbRead(stock: {
  last: number | null;
  open: number | null;
  high: number | null;
  low: number | null;
  orb?: StockData["orb"];
}): ORBRead {
  if (stock.last == null || stock.open == null) return { label: "-", tone: "muted", exact: false };
  const high5 = stock.orb?.high5 ?? null;
  const low5 = stock.orb?.low5 ?? null;

  if (high5 && low5) {
    if (stock.last > high5) return { label: "5m BO", tone: "profit", exact: true };
    if (stock.last < low5) return { label: "5m BD", tone: "loss", exact: true };
    return { label: "Inside 5m", tone: "warning", exact: true };
  }

  const pos = rangePosition(stock);
  if (pos != null && stock.last > stock.open && pos >= 0.68) return { label: "5m proxy up", tone: "profit", exact: false };
  if (pos != null && stock.last < stock.open && pos <= 0.32) return { label: "5m proxy down", tone: "loss", exact: false };
  return { label: "Wait", tone: "muted", exact: false };
}

function orb15Read(stock: StockData): ORBRead {
  const high15 = stock.orb?.high15 ?? null;
  const low15 = stock.orb?.low15 ?? null;
  if (stock.last == null) return { label: "-", tone: "muted", exact: false };
  if (!high15 || !low15) return { label: "-", tone: "muted", exact: false };
  if (stock.last > high15) return { label: "15m BO", tone: "profit", exact: true };
  if (stock.last < low15) return { label: "15m BD", tone: "loss", exact: true };
  return { label: "Inside 15m", tone: "warning", exact: true };
}

function strengthScore(stock: StockData): number {
  const pos = rangePosition(stock);
  const direction = Math.min(30, Math.abs(stock.changePct || 0) * 8);
  const range = pos == null ? 0 : pos > 0.7 || pos < 0.3 ? 18 : pos > 0.55 || pos < 0.45 ? 9 : 3;
  const volume = Math.min(18, (stock.volRatio || 0) * 5);
  const scoreBase = (stock.changePct || 0) >= 0 ? stock.buyingScore : stock.bearScore;
  return Math.round(Math.max(scoreBase || 0, direction + range + volume));
}

function intradayRead(stock: StockData): ORBRead {
  const move = stock.changePct ?? 0;
  const pos = rangePosition(stock);
  const volumeOk = (stock.volRatio || 0) >= 1.2;
  const orb = stock.orb5;
  const reclaimedShort =
    move < 0 &&
    stock.last != null &&
    (
      (stock.vwap != null && stock.vwap > 0 && stock.last > stock.vwap) ||
      (stock.open != null && stock.open > 0 && stock.last > stock.open)
    );
  const stretchedShort = move <= -1.6 && (stock.volRatio || 0) < 1.2;
  const shortIntoSupport = move <= -2 && pos != null && pos <= 0.18;

  if (reclaimedShort) return { label: "Bounce risk", tone: "warning", exact: false };
  if (stretchedShort || shortIntoSupport) return { label: "Late short", tone: "warning", exact: false };

  if (orb.tone === "profit" && move > 0 && volumeOk) return { label: "Long trigger", tone: "profit", exact: orb.exact };
  if (orb.tone === "loss" && move < 0 && volumeOk) return { label: "Short trigger", tone: "loss", exact: orb.exact };
  if (move > 0.6 && pos != null && pos >= 0.65) return { label: "Upside bias", tone: "profit", exact: false };
  if (move < -0.6 && pos != null && pos <= 0.35) return { label: "Downside bias", tone: "loss", exact: false };
  if (Math.abs(move) < 0.25 || (stock.volRatio || 0) < 0.8) return { label: "Wait", tone: "muted", exact: false };
  return { label: "Watch", tone: "warning", exact: false };
}

function toneClass(tone: ORBRead["tone"]) {
  if (tone === "profit") return "bg-profit-bg text-profit";
  if (tone === "loss") return "bg-loss-bg text-loss";
  if (tone === "warning") return "bg-warning/10 text-warning";
  return "bg-surface-subtle text-muted";
}

function buildPlaceholderStock(symbol: string): StockData {
  const raw: Omit<StockData, "orb5"> = {
    symbol,
    last: null,
    prevClose: null,
    open: null,
    changePct: null,
    change: null,
    volume: null,
    avgVolume: null,
    volRatio: null,
    high: null,
    low: null,
    pdh: null,
    pdl: null,
    delivery: null,
    buyingScore: null,
    bearScore: null,
    vwap: null,
    orb: null,
  };

  return {
    ...raw,
    orb5: orbRead(raw),
  };
}

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const id = window.setTimeout(() => reject(new Error("request timed out")), ms);
    promise.then(
      (value) => {
        window.clearTimeout(id);
        resolve(value);
      },
      (error) => {
        window.clearTimeout(id);
        reject(error);
      },
    );
  });
}

function emptySectorRows(): SectorWithStocks[] {
  return SECTOR_INDICES.map((index) => ({
    index,
    quote: null,
    stocks: index.constituents.map(buildPlaceholderStock),
    advancing: 0,
    declining: 0,
  }));
}

export default function SectorsContent() {
  const [sectors, setSectors] = useState<SectorWithStocks[]>([]);
  const [loading, setLoading] = useState(true);
  const [sortBy, setSortBy] = useState<"performance" | "name">("performance");
  const [lastUpdated, setLastUpdated] = useState(0);
  const [searchFilter, setSearchFilter] = useState("");
  const [moveFilter, setMoveFilter] = useState<"all" | "gainers" | "losers">("all");

  const loadData = useCallback(async () => {
    setSectors((current) => current.length > 0 ? current : emptySectorRows());
    setLoading(false);

    try {
      const sectorRes = await withTimeout(fetchAPI("/api/quotes/sectors"), 4000);
      const sectorQuotes: Record<string, SectorQuote> = {};
      // Normalize function: strips to bare letters for fuzzy matching
      const normalize = (s: string) =>
        s.toUpperCase().replace(/NIFTY\s*/g, "").replace(/INDIA\s*/g, "")
         .replace(/INDEX/g, "").replace(/&/g, "AND").replace(/MKT/g, "MARKETS")
         .replace(/PVT/g, "PRIVATE").replace(/FIN SERVICE/g, "FINANCE")
         .replace(/CONSR DURBL/g, "CONSUMER")
         .replace(/\bINFRA\b/g, "INFRASTRUCTURE")
         .replace(/\s+/g, " ").trim();

      const rawSectors = sectorRes.sectors || sectorRes.data || [];
      const normalizedMap: Record<string, SectorQuote> = {};
      for (const sq of rawSectors) {
        const name = sq.name || sq.symbol?.replace("NIFTY ", "") || "";
        const q: SectorQuote = {
          name: name,
          last: sq.last ?? 0,
          changePct: sq.changePct ?? sq.changePercent ?? 0,
          change: sq.change ?? 0,
        };
        // Store with normalized key
        normalizedMap[normalize(name)] = q;
        if (sq.symbol) normalizedMap[normalize(sq.symbol)] = q;
        // Also store raw
        sectorQuotes[name] = q;
        if (sq.symbol) sectorQuotes[sq.symbol] = q;
      }

      const allSymbols = new Set<string>();
      for (const si of SECTOR_INDICES) {
        for (const sym of si.constituents) allSymbols.add(sym);
      }
      const symbolList = Array.from(allSymbols);

      const stockData: Record<string, any> = {};
      for (let i = 0; i < symbolList.length; i += 30) {
        const chunk = symbolList.slice(i, i + 30);
        const joined = chunk.join(",");
        const [quoteResult, enrichedResult] = await Promise.allSettled([
          withTimeout(fetchAPI(`/api/quotes?symbols=${joined}`), 2500),
          withTimeout(fetchAPI(`/api/quotes-batch?symbols=${joined}`), 2500),
        ]);

        if (quoteResult.status === "fulfilled") {
          const res = quoteResult.value as any;
          if (res.success) Object.assign(stockData, res.data);
        }

        if (enrichedResult.status === "fulfilled") {
          const enriched = enrichedResult.value as any;
          for (const stock of enriched.stocks || []) {
            const key = `NSE:${stock.symbol}`;
            const existing = stockData[key] || {};
            stockData[key] = {
              ...existing,
              ...stock,
              last_price: stock.ltp ?? existing.last_price,
              ohlc: {
                ...(existing.ohlc || {}),
                open: stock.open ?? existing.ohlc?.open,
                high: stock.high ?? existing.ohlc?.high,
                low: stock.low ?? existing.ohlc?.low,
                close: stock.prevClose ?? existing.ohlc?.close,
              },
            };
          }
        }
      }

      const result: SectorWithStocks[] = SECTOR_INDICES.map((si) => {
        // Use normalized fuzzy matching — handles all name variations
        const normKey = normalize(si.kiteSymbol);
        const normName = normalize(si.name);
        const quote = normalizedMap[normKey] || normalizedMap[normName] || sectorQuotes[si.kiteSymbol.replace("NSE:", "")] || null;

        const stocks: StockData[] = si.constituents.map((sym) => {
          const q = stockData[`NSE:${sym}`];
          if (!q) return buildPlaceholderStock(sym);
          const last = Number(q.last_price ?? q.ltp);
          const prevClose = Number(q.ohlc?.close ?? q.prevClose);
          const open = Number(q.ohlc?.open ?? q.open);
          const high = Number(q.ohlc?.high ?? q.high);
          const low = Number(q.ohlc?.low ?? q.low);
          const safeLast = Number.isFinite(last) && last > 0 ? last : null;
          const safePrevClose = Number.isFinite(prevClose) && prevClose > 0 ? prevClose : safeLast;
          const safeOpen = Number.isFinite(open) && open > 0 ? open : safeLast;
          const safeHigh = Number.isFinite(high) && high > 0 ? high : safeLast;
          const safeLow = Number.isFinite(low) && low > 0 ? low : safeLast;
          const computedChangePct = safeLast != null && safePrevClose != null && safePrevClose > 0
            ? ((safeLast - safePrevClose) / safePrevClose) * 100
            : null;
          const raw: Omit<StockData, "orb5"> = {
            symbol: sym,
            last: safeLast,
            prevClose: safePrevClose,
            open: safeOpen,
            changePct: q.changePct ?? computedChangePct,
            change: q.change ?? (safeLast != null && safePrevClose != null ? safeLast - safePrevClose : null),
            volume: Number.isFinite(Number(q.volume)) && Number(q.volume) > 0 ? Number(q.volume) : null,
            avgVolume: q.avgVolume ?? null,
            volRatio: q.volRatio ?? null,
            high: safeHigh,
            low: safeLow,
            pdh: q.pdh ?? null,
            pdl: q.pdl ?? null,
            delivery: q.delivery ?? null,
            buyingScore: q.buyingScore ?? null,
            bearScore: q.bearScore ?? null,
            vwap: Number.isFinite(Number(q.vwap ?? q.average_price ?? q.averagePrice)) && Number(q.vwap ?? q.average_price ?? q.averagePrice) > 0
              ? Number(q.vwap ?? q.average_price ?? q.averagePrice)
              : null,
            orb: q.orb ?? null,
          };
          return {
            ...raw,
            orb5: orbRead(raw),
          };
        });

        stocks.sort((a, b) => strengthScore(b) - strengthScore(a) || Math.abs(b.changePct || 0) - Math.abs(a.changePct || 0));

        return {
          index: si,
          quote,
          stocks,
          advancing: stocks.filter((s) => (s.changePct || 0) > 0).length,
          declining: stocks.filter((s) => (s.changePct || 0) < 0).length,
        };
      });

      if (sortBy === "performance") {
        result.sort((a, b) => (b.quote?.changePct || 0) - (a.quote?.changePct || 0));
      } else {
        result.sort((a, b) => a.index.name.localeCompare(b.index.name));
      }

      setSectors(result);
      setLastUpdated(Date.now());
    } catch {
      setSectors(emptySectorRows());
      setLastUpdated(Date.now());
    } finally {
      setLoading(false);
    }
  }, [sortBy]);

  useEffect(() => {
    setLoading(true);
    loadData();
    const interval = setInterval(loadData, 15000);
    return () => clearInterval(interval);
  }, [loadData]);

  function scrollToSector(name: string) {
    const el = document.getElementById(`sector-${name.replace(/[^a-zA-Z0-9]/g, "")}`);
    if (el) {
      el.scrollIntoView({ behavior: "smooth", block: "center" });
      el.classList.add("ring-2", "ring-accent");
      setTimeout(() => el.classList.remove("ring-2", "ring-accent"), 2000);
    }
  }

  const maxAbsChange = Math.max(...sectors.map((s) => Math.abs(s.quote?.changePct || 0)), 0.5);
  const normalizedSearch = searchFilter.trim().toLowerCase();
  const visibleStockCount = sectors.reduce((count, sector) => {
    return count + sector.stocks.filter((stock) => {
      const move = stock.changePct ?? 0;
      if (normalizedSearch && !stock.symbol.toLowerCase().includes(normalizedSearch)) return false;
      if (moveFilter === "gainers" && move <= 0) return false;
      if (moveFilter === "losers" && move >= 0) return false;
      return true;
    }).length;
  }, 0);

  return (
    <div className="space-y-4">
      <PageHeader eyebrow="Market structure" title="Sector rotation" description="Find relative strength, then inspect the stocks driving each sector." actions={lastUpdated > 0 ? <span className="text-xs text-muted">Checked {new Date(lastUpdated).toLocaleTimeString("en-IN")} IST</span> : undefined} />

      {/* Header controls */}
      <div className="flex items-center justify-between flex-wrap gap-3">
        <div className="flex items-center gap-2 flex-wrap justify-end">
          <input
            type="text"
            aria-label="Filter sector stocks"
            placeholder="Search symbol..."
            value={searchFilter}
            onChange={(e) => setSearchFilter(e.target.value)}
            className="bg-card border border-card-border rounded px-3 py-1.5 text-xs text-foreground placeholder:text-muted focus:border-accent focus:outline-none w-44"
          />
          <div className="flex gap-0.5 bg-card border border-card-border rounded p-0.5">
            {([
              ["all", "All"],
              ["gainers", "Gainers"],
              ["losers", "Losers"],
            ] as const).map(([key, label]) => (
              <button
                key={key}
                aria-pressed={moveFilter === key}
                onClick={() => setMoveFilter(key)}
                className={cn(
                  "px-2.5 py-1 rounded text-xs font-medium transition-colors",
                  moveFilter === key
                    ? key === "gainers"
                      ? "bg-profit text-white"
                      : key === "losers"
                        ? "bg-loss text-white"
                        : "bg-accent text-white"
                    : "text-muted hover:text-foreground"
                )}
              >
                {label}
              </button>
            ))}
          </div>
          <div className="flex gap-0.5 bg-card border border-card-border rounded p-0.5">
            {(["performance", "name"] as const).map((s) => (
              <button key={s} onClick={() => setSortBy(s)}
                className={cn("px-2.5 py-1 rounded text-xs font-medium transition-colors",
                  sortBy === s ? "bg-accent text-white" : "text-muted hover:text-foreground")}>
                {s === "performance" ? "By Performance" : "A-Z"}
              </button>
            ))}
          </div>
        </div>
      </div>

      {/* Bar Chart */}
      {!loading && sectors.length > 0 && (
        <div className="bg-card border border-card-border rounded-xl p-4 overflow-x-auto">
          <div className="flex items-end gap-2 min-w-[1000px]" style={{ height: "180px" }}>
            {sectors.map((sector) => {
              const pct = sector.quote?.changePct || 0;
              const barHeight = Math.abs(pct) / maxAbsChange;
              const isPositive = pct >= 0;
              return (
                <div key={sector.index.name} className="flex-1 flex flex-col items-center justify-end h-full group cursor-pointer"
                  onClick={() => scrollToSector(sector.index.name)}>
                  <span className={cn("text-[10px] font-mono font-medium mb-1", isPositive ? "text-profit" : "text-loss")}>
                    {isPositive ? "+" : ""}{pct.toFixed(1)}%
                  </span>
                  <div className="relative w-full flex flex-col items-center" style={{ height: "120px" }}>
                    <div className="h-[60px] w-full flex items-end justify-center">
                      {isPositive && (
                        <div className="w-[65%] max-w-[40px] rounded-t group-hover:opacity-80"
                          style={{ height: `${Math.max(4, barHeight * 55)}px`, background: "linear-gradient(to top, rgba(0,200,83,0.3), rgba(0,200,83,0.85))" }} />
                      )}
                    </div>
                    <div className="w-full h-[1px] bg-card-border" />
                    <div className="h-[60px] w-full flex items-start justify-center">
                      {!isPositive && (
                        <div className="w-[65%] max-w-[40px] rounded-b group-hover:opacity-80"
                          style={{ height: `${Math.max(4, barHeight * 55)}px`, background: "linear-gradient(to bottom, rgba(255,23,68,0.3), rgba(255,23,68,0.85))" }} />
                      )}
                    </div>
                  </div>
                  <span className="text-[8px] text-muted mt-1 text-center leading-tight w-full group-hover:text-foreground">
                    {sector.index.name.replace("Nifty ", "")}
                  </span>
                </div>
              );
            })}
          </div>
        </div>
      )}

      {loading && (
        <div className="flex h-[200px] items-center justify-center rounded-xl border border-card-border bg-card text-sm text-muted">
          Loading sector rotation and constituent quotes...
        </div>
      )}

      {/* Summary */}
      {!loading && sectors.length > 0 && (
        <div className="flex flex-wrap items-center gap-3 text-xs">
          <div className="bg-card border border-card-border rounded px-3 py-1.5">
            <span className="text-muted">{sectors.length} Sectors</span>
          </div>
          <div className="bg-profit-bg border border-card-border rounded px-3 py-1.5">
            <span className="text-profit font-medium">{sectors.filter((s) => (s.quote?.changePct || 0) > 0).length}</span>
            <span className="text-profit/70 ml-1">advancing</span>
          </div>
          <div className="bg-loss-bg border border-card-border rounded px-3 py-1.5">
            <span className="text-loss font-medium">{sectors.filter((s) => (s.quote?.changePct || 0) < 0).length}</span>
            <span className="text-loss/70 ml-1">declining</span>
          </div>
          <span className="text-muted ml-auto">
            {searchFilter || moveFilter !== "all" ? `${visibleStockCount} matching names | ` : ""}
            Updated {lastUpdated > 0 ? new Date(lastUpdated).toLocaleTimeString("en-IN") : "--"}
          </span>
        </div>
      )}

      {/* Sector Cards */}
      {!loading && (
        <div className="grid grid-cols-1 min-[1400px]:grid-cols-2 gap-4">
          {sectors.map((sector) => {
            const pct = sector.quote?.changePct || 0;
            const totalStocks = sector.stocks.length;
            const advPct = totalStocks > 0 ? (sector.advancing / totalStocks) * 100 : 0;
            const decPct = totalStocks > 0 ? (sector.declining / totalStocks) * 100 : 0;
            const missingQuotes = sector.stocks.filter(stock => stock.changePct == null).length;

                const displayStocks = sector.stocks.filter((s) => {
                  const move = s.changePct ?? 0;
                  if (normalizedSearch && !s.symbol.toLowerCase().includes(normalizedSearch)) return false;
                  if (moveFilter === "gainers" && move <= 0) return false;
                  if (moveFilter === "losers" && move >= 0) return false;
                  return true;
                });

            if ((searchFilter || moveFilter !== "all") && displayStocks.length === 0) return null;

            return (
              <div key={sector.index.name} id={`sector-${sector.index.name.replace(/[^a-zA-Z0-9]/g, "")}`} className="bg-card border border-card-border rounded-xl overflow-hidden transition-all">
                <div className="px-4 py-2.5 flex flex-col gap-2 border-b border-card-border lg:flex-row lg:items-center lg:justify-between">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="font-semibold text-sm text-foreground">{sector.index.name}</span>
                    {sector.quote && (
                      <span className={cn("text-sm font-mono font-bold", profitLossColor(pct))}>
                        {pct >= 0 ? "+" : ""}{pct.toFixed(2)}%
                      </span>
                    )}
                    {sector.quote && (
                      <span className="text-xs font-mono text-muted">{formatNumber(sector.quote.last)}</span>
                    )}
                  </div>
                  <div className="flex flex-wrap items-center gap-2 text-xs">
                    <span className="text-profit font-medium">{sector.advancing} up</span>
                    <span className="text-loss font-medium">{sector.declining} dn</span>
                  </div>
                </div>

                <div className="px-4 py-3">
                  {missingQuotes > 0 && <p className="mb-2 text-xs text-muted">{missingQuotes} of {totalStocks} stock quotes unavailable</p>}
                  <div className="flex items-center gap-2 text-[10px]">
                    <span className="text-profit">{sector.advancing} ({advPct.toFixed(0)}% Up)</span>
                    <div className="flex-1 h-1 bg-card-border/30 rounded-full overflow-hidden flex">
                      <div className="h-full bg-profit" style={{ width: `${advPct}%` }} />
                      <div className="h-full bg-loss" style={{ width: `${decPct}%` }} />
                    </div>
                    <span className="text-loss">{sector.declining} ({decPct.toFixed(0)}% Down)</span>
                  </div>
                </div>

                <div className="flex flex-col gap-2 border-t border-card-border/40 bg-page-bg/40 px-4 py-2 sm:flex-row sm:items-center sm:justify-between">
                  <div className="text-[11px] font-semibold uppercase tracking-wide text-muted">
                    {displayStocks.length} of {totalStocks} names shown
                  </div>
                  <div className="flex w-full items-center gap-2 sm:w-auto">
                    <input
                      type="text"
                      placeholder={`Search ${sector.index.name.replace("Nifty ", "")} stocks...`}
                      value={searchFilter}
                      onChange={(e) => setSearchFilter(e.target.value)}
                      className="h-8 w-full rounded-lg border border-card-border bg-card px-3 text-xs font-medium text-foreground placeholder:text-muted focus:border-accent focus:outline-none sm:w-72"
                    />
                    {searchFilter && (
                      <button
                        type="button"
                        onClick={() => setSearchFilter("")}
                        className="h-8 rounded-lg border border-card-border px-3 text-xs font-bold text-muted transition hover:border-accent hover:text-accent"
                      >
                        Clear
                      </button>
                    )}
                  </div>
                </div>

                <div className="max-h-[320px] overflow-auto">
                  <table className="w-full min-w-[1180px] text-xs">
                    <thead className="sticky top-0 bg-card">
                      <tr className="border-b border-card-border/50 text-muted">
                        <th className="text-left px-4 py-1">Symbol</th>
                        <th className="text-right px-2 py-1">LTP</th>
                        <th className="text-right px-2 py-1">Move</th>
                        <th className="text-right px-2 py-1">Volume</th>
                        <th className="text-right px-2 py-1">RVOL</th>
                        <th className="text-center px-2 py-1">Read</th>
                        <th className="text-center px-2 py-1">5m ORB</th>
                        <th className="text-center px-2 py-1">15m ORB</th>
                        <th className="text-right px-2 py-1">Range</th>
                        <th className="text-right px-2 py-1">Open</th>
                        <th className="text-right px-2 py-1">PDH/PDL</th>
                        <th className="text-right px-2 py-1">Delivery</th>
                        <th className="text-right px-2 py-1">Score</th>
                      </tr>
                    </thead>
                    <tbody className="font-mono">
                      {displayStocks.map((s) => {
                        const rangePos = rangePosition(s);
                        const dayScore = strengthScore(s);
                        const orb15 = orb15Read(s);
                        const read = intradayRead(s);
                        const openMove = s.last != null && s.open != null && s.open > 0 ? ((s.last - s.open) / s.open) * 100 : null;
                        const move = s.changePct ?? null;
                        return (
                          <tr
                            key={s.symbol}
                            className="border-b border-card-border/20 hover:bg-hover-bg"
                          >
                            <td className="px-4 py-1.5 font-medium text-foreground">
                              <Link href={`/radar-trade?symbol=${encodeURIComponent(s.symbol)}`} className="hover:text-accent">
                                {s.symbol}
                              </Link>
                            </td>
                            <td className="text-right px-2 py-1.5">{formatMaybeNumber(s.last)}</td>
                            <td className="text-right px-2 py-1.5">
                              <span className={cn(
                                "px-1.5 py-0.5 rounded text-[11px] font-medium",
                                move == null ? "text-muted bg-surface-subtle" : move > 0 ? "text-profit bg-profit-bg" : move < 0 ? "text-loss bg-loss-bg" : "text-muted"
                              )}>
                                {move == null ? "-" : `${move >= 0 ? "+" : ""}${move.toFixed(2)}`}
                              </span>
                            </td>
                            <td className="text-right px-2 py-1.5 text-muted">{formatNullableVol(s.volume)}</td>
                            <td className="text-right px-2 py-1.5 text-muted">{formatRatio(s.volRatio)}</td>
                            <td className="text-center px-2 py-1.5">
                              <span className={cn("rounded px-1.5 py-0.5 text-[10px] font-bold", toneClass(read.tone))}>{read.label}</span>
                            </td>
                            <td className="text-center px-2 py-1.5">
                              <span className={cn("rounded px-1.5 py-0.5 text-[10px] font-bold", toneClass(s.orb5.tone))} title={s.orb5.exact ? "True 5-minute opening range" : "Proxy until true 5-minute ORB cache is available"}>
                                {s.orb5.label}
                              </span>
                            </td>
                            <td className="text-center px-2 py-1.5">
                              <span className={cn("rounded px-1.5 py-0.5 text-[10px] font-bold", toneClass(orb15.tone))}>{orb15.label}</span>
                            </td>
                            <td className={cn("text-right px-2 py-1.5", rangePos == null ? "text-muted" : rangePos > 0.65 ? "text-profit" : rangePos < 0.35 ? "text-loss" : "text-muted")}>
                              {rangePos == null ? "-" : `${Math.round(rangePos * 100)}%`}
                            </td>
                            <td className={cn("text-right px-2 py-1.5", openMove == null ? "text-muted" : openMove > 0 ? "text-profit" : openMove < 0 ? "text-loss" : "text-muted")}>
                              {openMove == null ? "-" : `${openMove >= 0 ? "+" : ""}${openMove.toFixed(2)}%`}
                            </td>
                            <td className="text-right px-2 py-1.5 text-muted">
                              <span title={`PDH ${formatMaybeNumber(s.pdh)} / PDL ${formatMaybeNumber(s.pdl)}`}>
                                {s.pdh && s.last != null && s.last >= s.pdh ? "PDH+" : s.pdl && s.last != null && s.last <= s.pdl ? "PDL-" : "-"}
                              </span>
                            </td>
                            <td className="text-right px-2 py-1.5 text-muted">{s.delivery == null ? "-" : `${s.delivery.toFixed(0)}%`}</td>
                            <td className={cn("text-right px-2 py-1.5 font-bold", dayScore >= 70 ? "text-profit" : dayScore >= 45 ? "text-warning" : "text-muted")}>{dayScore}</td>
                          </tr>
                        );
                      })}
                      {displayStocks.length === 0 && (
                        <tr>
                          <td colSpan={13} className="text-center py-4 text-muted">
                            {sector.stocks.length === 0 ? "Waiting for live constituent quotes" : "No matching stocks"}
                          </td>
                        </tr>
                      )}
                    </tbody>
                  </table>
                </div>
              </div>
            );
          })}
        </div>
      )}
      {!loading && sectors.length > 0 && visibleStockCount === 0 && (searchFilter || moveFilter !== "all") && (
        <div className="bg-card border border-card-border rounded-xl p-8 text-center text-sm text-muted">
          No stocks match the current search/filter.
        </div>
      )}
    </div>
  );
}
