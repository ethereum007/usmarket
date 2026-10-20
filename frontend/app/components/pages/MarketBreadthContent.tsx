"use client";

import { useCallback, useEffect, useState } from "react";
import { RefreshCw } from "lucide-react";
import { fetchAPI } from "../../lib/api";

const CACHE_KEY = "alpha-radar:market-breadth";

export default function MarketBreadthContent() {
  const [data, setData] = useState<any>(null);
  const [loading, setLoading] = useState(true);
  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetchAPI<any>("/api/breadth");
      setData(res);
      window.sessionStorage.setItem(CACHE_KEY, JSON.stringify(res));
    } catch {}
    setLoading(false);
  }, []);

  useEffect(() => {
    const cached = window.sessionStorage.getItem(CACHE_KEY);
    if (cached) {
      try { setData(JSON.parse(cached)); } catch {}
      setLoading(false);
      return;
    }
    void load();
  }, [load]);

  if (loading && !data) return <Loading label="Loading market breadth..." />;
  if (!data) return <div role="status" className="rounded-xl bg-card p-8 text-center text-muted shadow-sm">Market breadth is unavailable. Use Refresh to try again.</div>;

  const advances = data.advances || 0;
  const declines = data.declines || 0;
  const unchanged = data.unchanged || 0;
  const total = data.total || advances + declines + unchanged;
  const advPct = total > 0 ? ((advances / total) * 100).toFixed(1) : "0";
  const decPct = total > 0 ? ((declines / total) * 100).toFixed(1) : "0";

  return (
    <div className="space-y-4">
      <div className="flex justify-end"><button type="button" onClick={() => void load()} disabled={loading} className="workspace-button"><RefreshCw size={14} className={loading ? "animate-spin" : ""} /> Refresh</button></div>
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <Metric label="Advancing" value={advances} tone="text-profit" sub={`${advPct}%`} />
        <Metric label="Declining" value={declines} tone="text-loss" sub={`${decPct}%`} />
        <Metric label="Unchanged" value={unchanged} tone="text-muted" />
        <Metric label="Strong buy" value={data.strongBuy || 0} tone="text-accent" sub="Score ≥ 65" />
      </div>
      {total > 0 && <div className="rounded-xl bg-card p-5 shadow-sm"><div className="mb-3 text-xs font-semibold text-muted">Market breadth · {total} stocks</div><div className="flex h-3 overflow-hidden rounded-full bg-surface-hover"><div className="bg-profit" style={{ width: `${advPct}%` }} /><div className="bg-slate-400" style={{ width: `${(unchanged / total) * 100}%` }} /><div className="bg-loss" style={{ width: `${decPct}%` }} /></div><div className="mt-3 flex justify-between text-xs"><span className="text-profit">▲ {advances}</span><span className="text-muted">— {unchanged}</span><span className="text-loss">▼ {declines}</span></div></div>}
    </div>
  );
}

function Loading({ label }: { label: string }) { return <div className="rounded-xl bg-card p-12 text-center shadow-sm"><div className="mx-auto mb-4 h-8 w-8 animate-spin rounded-full border-2 border-accent border-t-transparent" /><p className="font-medium text-foreground">{label}</p></div>; }
function Metric({ label, value, tone, sub }: { label: string; value: number; tone: string; sub?: string }) { return <div className="rounded-xl bg-card p-5 text-center shadow-sm"><div className={`text-3xl font-black ${tone}`}>{value}</div><div className="mt-1 text-xs font-semibold text-muted">{label}</div>{sub && <div className={`mt-1 text-[10px] ${tone}`}>{sub}</div>}</div>; }
