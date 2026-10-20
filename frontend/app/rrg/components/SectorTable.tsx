"use client";

import { cn } from "../../lib/utils";

import { isBorderline, shortLabel } from "../lib/rrg";
import { SECTOR_COLOR } from "../lib/universe";
import type { RrgRow } from "../lib/types";

const QUADRANT_BG: Record<string, string> = {
  leading: "bg-emerald-500/5",
  weakening: "bg-amber-500/5",
  lagging: "bg-rose-500/5",
  improving: "bg-violet-500/5",
};

const QUADRANT_TEXT: Record<string, string> = {
  leading: "text-profit",
  weakening: "text-warning",
  lagging: "text-loss",
  improving: "text-violet-700 dark:text-violet-300",
};

type Props = {
  tails: Record<string, RrgRow[]>;
  visibleSet: Set<string>;
  benchmark: string;
  onToggle: (symbol: string) => void;
  onSolo: (symbol: string) => void;
};

export function SectorTable({
  tails,
  visibleSet,
  benchmark,
  onToggle,
  onSolo,
}: Props) {
  const rowSymbols = new Set<string>([
    ...visibleSet,
    ...Object.keys(tails),
  ]);
  rowSymbols.delete(benchmark);

  const rows = Array.from(rowSymbols)
    .map((symbol) => {
      const points = tails[symbol];
      const head = points?.[points.length - 1];
      return head ? { ...head, symbol, visible: visibleSet.has(symbol) } : null;
    })
    .filter(
      (r): r is RrgRow & { symbol: string; visible: boolean } => r !== null,
    )
    .sort((a, b) => {
      if (a.visible !== b.visible) return a.visible ? -1 : 1;
      return b.rs_ratio - a.rs_ratio;
    });

  return (
    <div className="text-sm">
      <div className="grid grid-cols-[1.5rem_1.25rem_minmax(7rem,1fr)_4rem_4rem_6rem_3rem] gap-2 px-3 py-2 text-[10px] uppercase tracking-wider text-muted border-b border-card-border">
        <span />
        <span />
        <span>Sector</span>
        <span className="text-right">Ratio</span>
        <span className="text-right">Mom.</span>
        <span className="text-right">Quadrant</span>
        <span className="text-right">Solo</span>
      </div>
      <div className="max-h-[28rem] overflow-y-auto">
        {rows.map((r) => (
          <div
            key={r.symbol}
            className={cn(
              "grid grid-cols-[1.5rem_1.25rem_minmax(7rem,1fr)_4rem_4rem_6rem_3rem] gap-2 items-center px-3 py-1.5 border-b border-card-border/50 transition-opacity",
              r.visible ? QUADRANT_BG[r.quadrant] : "opacity-40 hover:opacity-70",
            )}
            title={r.symbol}
          >
            <input
              type="checkbox"
              checked={r.visible}
              onChange={() => onToggle(r.symbol)}
              className="cursor-pointer"
              style={{ accentColor: "var(--accent)" }}
              aria-label={`toggle ${r.symbol}`}
            />
            <span
              className="h-2.5 w-2.5 rounded-full justify-self-center"
              style={{ background: SECTOR_COLOR[r.symbol] }}
            />
            <span className="truncate font-medium text-foreground">
              {shortLabel(r.symbol)}
            </span>
            <span className="text-right tabular-nums">{r.rs_ratio.toFixed(2)}</span>
            <span className="text-right tabular-nums">{r.rs_momentum.toFixed(2)}</span>
            <span
              className={cn(
                "text-right text-xs uppercase tracking-wide font-semibold",
                QUADRANT_TEXT[r.quadrant],
              )}
              title={
                isBorderline(r)
                  ? "Borderline — sitting on a centerline, quadrant call is uncertain"
                  : undefined
              }
            >
              {isBorderline(r) && (
                <span className="text-muted mr-0.5">~</span>
              )}
              {r.quadrant}
            </span>
            <button
              type="button"
              onClick={() => onSolo(r.symbol)}
              className="text-xs text-accent hover:underline justify-self-end"
              style={{ color: "var(--accent)" }}
              title="Show only this sector"
            >
              solo
            </button>
          </div>
        ))}
      </div>
    </div>
  );
}
