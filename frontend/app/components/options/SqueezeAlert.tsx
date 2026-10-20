"use client";

import { useEffect, useState, useCallback } from "react";
import { fetchAPI } from "../../lib/api";
import { cn, formatNumber } from "../../lib/utils";

interface Alert {
  type: string;
  severity: "HIGH" | "MEDIUM" | "LOW";
  direction: "BULLISH" | "BEARISH" | "NEUTRAL";
  message: string;
  value: number;
  threshold: number;
}

interface Snapshot {
  time: number;
  timeStr: string;
  spot: number;
  totalCallOI: number;
  totalPutOI: number;
  pcr: number;
  range: number;
}

interface SqueezeData {
  success: boolean;
  index: string;
  name: string;
  spot: number;
  alerts: Alert[];
  squeezeScore: number;
  squeezePhase: string;
  rangeCompression: number;
  oiBuildupRatio: number;
  pcrTrend: string;
  netOIDirection: string;
  snapshotCount: number;
  snapshots: Snapshot[];
  timestamp: number;
}

const phaseConfig: Record<string, { color: string; bg: string; label: string; icon: string }> = {
  calm: { color: "text-muted", bg: "bg-card", label: "CALM", icon: "😴" },
  building: { color: "text-warning", bg: "bg-[rgba(255,193,7,0.1)]", label: "BUILDING", icon: "🔨" },
  ready: { color: "text-accent", bg: "bg-accent-bg", label: "READY", icon: "⚡" },
  firing: { color: "text-profit", bg: "bg-profit-bg", label: "FIRING", icon: "🔥" },
};

const severityColors = {
  HIGH: "border-card-border bg-loss-bg",
  MEDIUM: "border-card-border bg-[rgba(255,193,7,0.05)]",
  LOW: "border-card-border bg-card",
};

const directionColors = {
  BULLISH: "text-profit",
  BEARISH: "text-loss",
  NEUTRAL: "text-muted",
};

function formatOI(v: number): string {
  if (Math.abs(v) >= 10000000) return `${(v / 10000000).toFixed(1)}Cr`;
  if (Math.abs(v) >= 100000) return `${(v / 100000).toFixed(1)}L`;
  if (Math.abs(v) >= 1000) return `${(v / 1000).toFixed(1)}K`;
  return String(Math.round(v));
}

interface Props {
  indexKey: string;
}

export function SqueezeAlert({ indexKey }: Props) {
  const [data, setData] = useState<SqueezeData | null>(null);
  const [loading, setLoading] = useState(true);

  const loadSqueeze = useCallback(async () => {
    try {
      const res = await fetchAPI<SqueezeData>(`/api/squeeze/${indexKey}`);
      if (res.success) setData(res);
    } catch {}
    setLoading(false);
  }, [indexKey]);

  useEffect(() => {
    setLoading(true);
    loadSqueeze();
    // Refresh every 2 minutes (matches snapshot interval)
    const interval = setInterval(loadSqueeze, 120000);
    return () => clearInterval(interval);
  }, [loadSqueeze]);

  if (loading && !data) {
    return (
      <div className="bg-card border border-card-border rounded-lg p-4 animate-pulse">
        <div className="h-6 w-48 bg-card-border/30 rounded mb-2" />
        <div className="h-4 w-32 bg-card-border/30 rounded" />
      </div>
    );
  }

  if (!data) return null;

  const phase = phaseConfig[data.squeezePhase] || phaseConfig.calm;

  return (
    <div className="min-w-0 overflow-hidden rounded-lg border border-card-border">
      {/* Header */}
      <div className={cn("flex flex-wrap items-center justify-between gap-3 px-4 py-3", phase.bg)}>
        <div className="flex min-w-0 items-center gap-3">
          <span className="text-lg">{phase.icon}</span>
          <div className="min-w-0">
            <div className="flex items-center gap-2">
              <span className="font-bold text-foreground">Squeeze Monitor</span>
              <span className={cn("text-xs font-bold px-2 py-0.5 rounded", phase.bg, phase.color)}>
                {phase.label}
              </span>
            </div>
            <span className="text-xs text-muted">
              {data.snapshotCount} snapshots | Bias: {" "}
              <span className={cn("font-medium", directionColors[data.netOIDirection === "bullish" ? "BULLISH" : data.netOIDirection === "bearish" ? "BEARISH" : "NEUTRAL"])}>
                {data.netOIDirection}
              </span>
            </span>
          </div>
        </div>

        {/* Score gauge */}
        <div className="flex shrink-0 items-center gap-3">
          <div className="text-right">
            <div className="text-xs text-muted">Squeeze Score</div>
            <div className={cn("text-xl font-bold font-mono", phase.color)}>{data.squeezeScore}</div>
          </div>
          <div className="w-16 h-16 relative">
            <svg viewBox="0 0 36 36" className="w-full h-full -rotate-90">
              <circle cx="18" cy="18" r="14" fill="none" stroke="var(--card-border)" strokeWidth="3" strokeOpacity="0.3" />
              <circle cx="18" cy="18" r="14" fill="none"
                stroke={data.squeezeScore >= 60 ? "var(--profit)" : data.squeezeScore >= 40 ? "var(--warning)" : data.squeezeScore >= 20 ? "var(--accent)" : "var(--muted)"}
                strokeWidth="3" strokeDasharray={`${data.squeezeScore * 0.88} ${88 - data.squeezeScore * 0.88}`}
                strokeLinecap="round" />
            </svg>
            <div className="absolute inset-0 flex items-center justify-center">
              <span className="text-[10px] text-muted">/100</span>
            </div>
          </div>
        </div>
      </div>

      {/* Metrics row */}
      <div className="px-4 py-2 flex flex-wrap gap-4 text-xs border-b border-card-border/50 bg-hover-bg">
        <span>
          <span className="text-muted">Range: </span>
          <span className={cn("font-mono font-medium",
            data.rangeCompression < 0.4 ? "text-profit" : data.rangeCompression < 0.6 ? "text-warning" : "text-foreground"
          )}>
            {(data.rangeCompression * 100).toFixed(0)}% of expected
          </span>
        </span>
        <span>
          <span className="text-muted">OI Near ATM: </span>
          <span className={cn("font-mono font-medium",
            data.oiBuildupRatio > 0.35 ? "text-profit" : data.oiBuildupRatio > 0.25 ? "text-warning" : "text-foreground"
          )}>
            {(data.oiBuildupRatio * 100).toFixed(0)}%
          </span>
        </span>
        <span>
          <span className="text-muted">PCR Trend: </span>
          <span className={cn("font-medium",
            data.pcrTrend === "rising" ? "text-profit" : data.pcrTrend === "falling" ? "text-loss" : "text-foreground"
          )}>
            {data.pcrTrend}
          </span>
        </span>
        <span>
          <span className="text-muted">Spot: </span>
          <span className="font-mono font-medium text-accent">{formatNumber(data.spot)}</span>
        </span>
      </div>

      {/* Alerts */}
      {data.alerts.length > 0 && (
        <div className="px-4 py-3 space-y-1.5">
          {data.alerts.slice(0, 6).map((alert, i) => (
            <div key={i} className={cn("flex items-start gap-2 text-xs px-2 py-1.5 rounded border", severityColors[alert.severity])}>
              <span className={cn("shrink-0 font-bold mt-0.5", directionColors[alert.direction])}>
                {alert.severity === "HIGH" ? "!!" : alert.severity === "MEDIUM" ? "!" : "-"}
              </span>
              <span className="text-muted">{alert.message}</span>
            </div>
          ))}
        </div>
      )}

      {/* PCR Timeline (mini chart) */}
      {data.snapshots.length >= 3 && (
        <div className="px-4 py-3 border-t border-card-border/50">
          <div className="text-[10px] text-muted mb-1.5">PCR Timeline</div>
          <div className="flex items-end gap-0.5 h-[40px]">
            {data.snapshots.map((s, i) => {
              const minPCR = Math.min(...data.snapshots.map((x) => x.pcr));
              const maxPCR = Math.max(...data.snapshots.map((x) => x.pcr));
              const range = maxPCR - minPCR || 0.1;
              const height = ((s.pcr - minPCR) / range) * 35 + 5;
              return (
                <div key={i} className="flex-1 flex flex-col items-center justify-end" title={`${s.timeStr}: PCR ${s.pcr}`}>
                  <div
                    className={cn("w-full max-w-[8px] rounded-t",
                      s.pcr > 1.2 ? "bg-profit/60" : s.pcr < 0.8 ? "bg-loss/60" : "bg-accent/40"
                    )}
                    style={{ height: `${height}px` }}
                  />
                </div>
              );
            })}
          </div>
          <div className="flex justify-between text-[9px] text-muted mt-0.5">
            <span>{data.snapshots[0]?.timeStr}</span>
            <span>{data.snapshots[data.snapshots.length - 1]?.timeStr}</span>
          </div>
        </div>
      )}
    </div>
  );
}
