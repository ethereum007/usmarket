"use client";

import dynamic from "next/dynamic";
import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import { Announcement, EVENT_TYPES, sourceLink } from "./model";
import { reviewPriority } from "./priority";
import type { Candle, MarketSetup } from "./market-setup";

const PriceChart = dynamic(() => import("../components/charts/CandlestickChart").then(module => module.CandlestickChart), { ssr: false, loading: () => <p className="p-8 text-sm text-muted">Loading chart…</p> });
type MarketData = { symbol: string; candles: Candle[]; setup: MarketSetup; source: string };
type Entry = { data?: MarketData; error?: string };
const price = (value?: number) => value == null ? "—" : new Intl.NumberFormat("en-IN", { maximumFractionDigits: 2 }).format(value);
const tone = (value?: MarketSetup["tone"]) => value === "up" ? "text-emerald-500" : value === "down" ? "text-red-400" : "text-muted";
const dateTime = (date: string) => new Intl.DateTimeFormat("en-IN", { timeZone: "Asia/Kolkata", day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" }).format(new Date(date));

export default function AnnouncementTable({ rows, date }: { rows: Announcement[]; date: string }) {
  const [selected, setSelected] = useState<string | null>(null);
  const [entries, setEntries] = useState<Record<string, Entry>>({});
  const [retry, setRetry] = useState(0);
  const symbol = rows.some(row => row.symbol === selected) ? selected! : rows[0]?.symbol;
  const symbolsKey = [...new Set(rows.map(row => row.symbol))].join(",");
  useEffect(() => {
    let cancelled = false;
    const queue = symbolsKey ? symbolsKey.split(",").filter(item => !entries[`${date}:${item}`]) : [];
    async function worker() {
      while (queue.length && !cancelled) {
        const item = queue.shift()!;
        let entry: Entry;
        try {
          const response = await fetch(`/latest-updates/market-data?symbol=${encodeURIComponent(item)}&date=${date}`, { signal: AbortSignal.timeout(16000) });
          if (!response.ok) throw new Error("Daily data unavailable");
          const data: MarketData = await response.json();
          if (data.symbol !== item || !Array.isArray(data.candles) || !data.setup) throw new Error("Invalid daily data");
          entry = { data };
        } catch { entry = { error: "Daily data unavailable" }; }
        if (!cancelled) setEntries(current => ({ ...current, [`${date}:${item}`]: entry }));
      }
    }
    void Promise.all([worker(), worker(), worker()]);
    return () => { cancelled = true; };
    // Entries are retained while filters change; completed requests must not restart the queue.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [symbolsKey, date, retry]);
  const selectedEntry = entries[`${date}:${symbol}`];
  const data = selectedEntry?.data;
  const levels = useMemo(() => data?.setup.resistance && data.setup.support ? [{ price: data.setup.resistance, title: "20D high", color: "#f59e0b" }, { price: data.setup.support, title: "20D low", color: "#ef4444" }] : [], [data]);
  return <div className="grid items-start gap-5 xl:grid-cols-[minmax(0,1fr)_390px]">
    <div className="min-w-0 overflow-x-auto rounded-xl border border-card-border bg-card">
      <table className="w-full min-w-[980px] border-collapse text-left text-xs">
        <caption className="sr-only">NSE announcements ranked by review priority, with completed daily price setups. Select Chart to inspect a stock.</caption>
        <thead className="bg-accent/5 text-muted"><tr>{["Priority", "Stock / time", "Announcement", "Daily setup", "Close / move", "Volume", "Chart / source"].map(label => <th key={label} scope="col" className="border-b border-card-border px-3 py-3 font-semibold">{label}</th>)}</tr></thead>
        <tbody>{rows.map(row => {
          const rating = reviewPriority(row), entry = entries[`${date}:${row.symbol}`], setup = entry?.data?.setup, href = sourceLink(row.source_url);
          return <tr key={row.id} className={`border-b border-card-border align-top last:border-0 hover:bg-hover-bg ${symbol === row.symbol ? "bg-accent/5" : ""}`}>
            <td className="px-3 py-4"><span className={`inline-block rounded border px-2 py-1 font-semibold capitalize ${rating.level === "high" ? "border-red-400/40 text-red-400" : rating.level === "medium" ? "border-amber-400/40 text-amber-500" : "border-card-border text-muted"}`}>{rating.level}</span><details className="mt-2 max-w-44 text-[11px] leading-5 text-muted"><summary className="cursor-pointer">Why this priority</summary><p className="mt-2">{rating.reason}</p><p className="mt-2"><b>Check next:</b> {rating.check}</p></details></td>
            <td className="px-3 py-4"><Link className="font-bold text-text-heading hover:text-accent" href={`/stocks?symbol=${encodeURIComponent(row.symbol)}&universe=all`}>{row.symbol}</Link><p className="mt-1 max-w-36 text-[11px] text-muted">{row.company_name}</p><time dateTime={row.event_date} className="mt-2 block whitespace-nowrap text-[10px] text-muted">{dateTime(row.event_date)} IST</time></td>
            <td className="min-w-64 max-w-sm px-3 py-4"><span className="text-[10px] font-semibold text-accent">{EVENT_TYPES[row.event_type].label}</span><p className="mt-1 font-medium leading-5 text-text-heading">{row.headline}</p>{row.order_value_text ? <p className="mt-2 text-muted">{row.order_value_text}</p> : null}<details className="mt-2 text-[11px] leading-5 text-muted"><summary className="cursor-pointer">Details & impact</summary><p className="mt-2">{row.metadata?.announcement_summary || row.why_it_matters || "Read the original filing for details."}</p>{row.why_it_matters ? <p className="mt-2">{row.why_it_matters}</p> : null}</details></td>
            <td className="min-w-36 px-3 py-4"><button onClick={() => setSelected(row.symbol)} title={setup?.reason} className={`text-left font-semibold ${tone(setup?.tone)}`}>{setup?.label || entry?.error || "Checking…"}</button>{setup?.asOf ? <p className="mt-1 text-[10px] text-muted">As of {setup.asOf}</p> : null}</td>
            <td className="whitespace-nowrap px-3 py-4 tabular-nums"><p className="font-semibold">{price(setup?.close)}</p><p className={`mt-1 ${setup?.changePct != null ? setup.changePct >= 0 ? "text-emerald-500" : "text-red-400" : "text-muted"}`}>{setup?.changePct == null ? "—" : `${setup.changePct >= 0 ? "+" : ""}${setup.changePct.toFixed(2)}%`}</p></td>
            <td className="px-3 py-4 tabular-nums">{setup?.volumeRatio == null ? "—" : `${setup.volumeRatio.toFixed(2)}×`}<p className="mt-1 whitespace-nowrap text-[10px] text-muted">vs 20D avg</p></td>
            <td className="px-3 py-4"><button aria-pressed={symbol === row.symbol} onClick={() => setSelected(row.symbol)} className="rounded border border-accent/40 px-2 py-1.5 font-semibold text-accent">Chart</button>{href ? <a className="mt-3 block text-[11px] text-accent hover:underline" href={href} target="_blank" rel="noopener noreferrer">NSE filing ↗</a> : null}</td>
          </tr>;
        })}</tbody>
      </table>
    </div>
    <aside aria-label="Selected stock daily chart" className="min-w-0 rounded-xl border border-card-border bg-card p-4 xl:sticky xl:top-4">
      <div className="flex items-start justify-between gap-3"><div><h3 className="font-semibold text-text-heading">{symbol} · Daily chart</h3><p className="mt-1 text-[11px] text-muted">Completed candles · INR</p></div><a href={`https://www.tradingview.com/chart/?symbol=${encodeURIComponent(`NSE:${symbol}`)}`} target="_blank" rel="noopener noreferrer" className="text-xs text-accent">Full chart ↗</a></div>
      {!selectedEntry ? <p role="status" className="py-12 text-center text-sm text-muted">Loading daily candles…</p> : selectedEntry.error ? <div className="py-8 text-sm text-muted"><p>Daily price data is unavailable. Open the full chart or retry.</p><button onClick={() => { setEntries(current => { const copy = { ...current }; delete copy[`${date}:${symbol}`]; return copy; }); setRetry(value => value + 1); }} className="mt-4 rounded border border-card-border px-3 py-2">Retry price data</button></div> : data ? <><p className={`mt-4 text-sm font-semibold ${tone(data.setup.tone)}`}>{data.setup.label}</p><p className="mt-1 text-xs leading-5 text-muted">{data.setup.reason}</p><div className="mt-4"><PriceChart data={data.candles} symbol={symbol} priceLevels={levels} height={320} /></div><div className="mt-4 grid grid-cols-2 gap-3 text-xs"><p className="text-muted">20D resistance <b className="mt-1 block text-text-heading">{price(data.setup.resistance)}</b></p><p className="text-muted">20D support <b className="mt-1 block text-text-heading">{price(data.setup.support)}</b></p></div><p className="mt-4 text-[10px] leading-5 text-muted">{data.source}. Candle date: {data.setup.asOf || "unavailable"}. Daily close confirmation is assessed against the previous 20 sessions; volume confirmation uses 1.5× average. Prices may be delayed. The setup does not establish that the announcement caused the move.</p></> : null}
    </aside>
  </div>;
}
