"use client";

import { formatNumber, profitLossColor, cn } from "../../lib/utils";

interface IndexCardProps {
  name: string;
  last: number;
  change: number;
  changePercent: number;
  open: number;
  high: number;
  low: number;
  close: number;
}

export function IndexCard({
  name,
  last,
  change,
  changePercent,
  open,
  high,
  low,
  close,
}: IndexCardProps) {
  const isUp = change >= 0;

  return (
    <div className="bg-card border border-card-border rounded-lg p-4 transition-colors hover:bg-hover-bg">
      <div className="flex items-center justify-between mb-3">
        <h3 className="text-sm font-medium text-muted">{name}</h3>
        <span
          className={cn(
            "text-xs px-2 py-0.5 rounded-full font-medium",
            isUp ? "bg-profit-bg text-profit" : "bg-loss-bg text-loss"
          )}
        >
          {isUp ? "▲" : "▼"} {formatNumber(Math.abs(changePercent))}%
        </span>
      </div>

      <div className="flex items-baseline gap-3 mb-4">
        <span className="text-2xl font-bold tracking-tight">
          {formatNumber(last)}
        </span>
        <span className={cn("text-sm font-medium", profitLossColor(change))}>
          {isUp ? "+" : ""}
          {formatNumber(change)}
        </span>
      </div>

      <div className="grid grid-cols-2 gap-x-4 gap-y-1 text-xs">
        <div className="flex justify-between">
          <span className="text-muted">Open</span>
          <span>{formatNumber(open)}</span>
        </div>
        <div className="flex justify-between">
          <span className="text-muted">Prev Close</span>
          <span>{formatNumber(close)}</span>
        </div>
        <div className="flex justify-between">
          <span className="text-muted">High</span>
          <span className="text-profit">{formatNumber(high)}</span>
        </div>
        <div className="flex justify-between">
          <span className="text-muted">Low</span>
          <span className="text-loss">{formatNumber(low)}</span>
        </div>
      </div>

      {/* Day range bar */}
      <div className="mt-3">
        <div className="h-1.5 bg-card-border/30 rounded-full overflow-hidden">
          {high !== low && (
            <div
              className={cn("h-full rounded-full", isUp ? "bg-profit/60" : "bg-loss/60")}
              style={{
                width: `${((last - low) / (high - low)) * 100}%`,
              }}
            />
          )}
        </div>
      </div>
    </div>
  );
}
