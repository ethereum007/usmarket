"use client";

import { formatNumber, cn } from "../../lib/utils";

interface CPRLevel {
  label: string;
  value: number;
  type: "resistance" | "pivot" | "support";
}

interface CPRLevelsCardProps {
  symbol: string;
  spot: number;
  levels: CPRLevel[];
}

const typeColors = {
  resistance: "text-loss",
  pivot: "text-accent",
  support: "text-profit",
};

const typeBg = {
  resistance: "bg-loss-bg",
  pivot: "bg-accent-bg",
  support: "bg-profit-bg",
};

export function CPRLevelsCard({ symbol, spot, levels }: CPRLevelsCardProps) {
  return (
    <div className="bg-card border border-card-border rounded-xl p-4">
      <div className="flex items-center justify-between mb-3">
        <h3 className="font-medium">{symbol} — CPR Levels</h3>
        <span className="text-sm font-mono text-accent">{formatNumber(spot)}</span>
      </div>

      <div className="space-y-1.5">
        {levels.map((level) => {
          const nearSpot = Math.abs(level.value - spot) / spot < 0.005;
          return (
            <div
              key={level.label}
              className={cn(
                "flex items-center justify-between px-2 py-1 rounded text-sm",
                nearSpot ? typeBg[level.type] : ""
              )}
            >
              <span className="text-muted text-xs">{level.label}</span>
              <span className={cn("font-mono", typeColors[level.type])}>
                {formatNumber(level.value)}
              </span>
            </div>
          );
        })}
      </div>
    </div>
  );
}

// Default NIFTY CPR levels from TradingView indicator
export function NiftyCPRCard() {
  const levels: CPRLevel[] = [
    { label: "Monthly R2", value: 25907.03, type: "resistance" },
    { label: "Monthly R1", value: 24119.22, type: "resistance" },
    { label: "Prev Month High", value: 24989.35, type: "resistance" },
    { label: "Monthly TC", value: 23636.60, type: "resistance" },
    { label: "Monthly Pivot", value: 23201.53, type: "pivot" },
    { label: "Monthly BC", value: 22766.47, type: "support" },
    { label: "Prev Month Low", value: 22283.85, type: "support" },
    { label: "Monthly S1", value: 21413.72, type: "support" },
    { label: "Monthly S2", value: 20496.03, type: "support" },
  ];

  return <CPRLevelsCard symbol="NIFTY" spot={23123.65} levels={levels} />;
}
