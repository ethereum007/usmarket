"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { treemap, hierarchy, treemapSquarify } from "d3-hierarchy";
import { cn, formatNumber } from "../../lib/utils";

interface StockData {
  symbol: string;
  sector: string;
  last: number;
  changePercent: number;
  volume: number;
  marketCap?: number;
}

interface Props {
  stocks: StockData[];
  sizeBy?: "volume" | "equal";
  onStockClick?: (symbol: string) => void;
  height?: number;
}

function getColorForChange(pct: number): string {
  if (pct >= 3) return "#00a63e";
  if (pct >= 2) return "#00873a";
  if (pct >= 1) return "#006b30";
  if (pct >= 0.5) return "#005226";
  if (pct >= 0) return "#003d1c";
  if (pct >= -0.5) return "#3d0000";
  if (pct >= -1) return "#5c0000";
  if (pct >= -2) return "#870000";
  if (pct >= -3) return "#a60000";
  return "#cc0000";
}

function getTextColor(pct: number): string {
  if (Math.abs(pct) >= 1) return "#ffffff";
  return "#c0c0c0";
}

export function SectorHeatmap({ stocks, sizeBy = "equal", onStockClick, height = 600 }: Props) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [dimensions, setDimensions] = useState({ width: 1000, height });
  const [tooltip, setTooltip] = useState<{
    x: number;
    y: number;
    stock: StockData;
  } | null>(null);

  useEffect(() => {
    const container = containerRef.current;
    if (!container || stocks.length === 0) return;

    const updateDimensions = (width: number, measuredHeight: number) => {
      const next = {
        width: Math.max(320, Math.round(width)),
        height: Math.max(420, Math.round(measuredHeight || height)),
      };
      setDimensions((current) => (
        current.width === next.width && current.height === next.height ? current : next
      ));
    };

    const bounds = container.getBoundingClientRect();
    updateDimensions(bounds.width, bounds.height);

    const observer = new ResizeObserver((entries) => {
      const { width, height } = entries[0].contentRect;
      updateDimensions(width, height);
    });
    observer.observe(container);
    return () => observer.disconnect();
  }, [height, stocks.length]);

  const { root, leaves } = useMemo(() => {
    const sectorMap = new Map<string, StockData[]>();
    for (const stock of stocks) {
      const list = sectorMap.get(stock.sector) || [];
      list.push(stock);
      sectorMap.set(stock.sector, list);
    }

    const rootData = {
      name: "market",
      children: Array.from(sectorMap.entries()).map(([sector, items]) => ({
        name: sector,
        children: items.map((stock) => ({
          name: stock.symbol,
          symbol: stock.symbol,
          sector: stock.sector,
          changePercent: stock.changePercent,
          last: stock.last,
          volume: stock.volume,
          // Compress extreme volume differences so liquid names remain prominent
          // without turning the rest of the market into unreadable slivers.
          value: sizeBy === "volume" ? Math.sqrt(Math.max(stock.volume, 1)) : 1,
        })),
      })),
    };

    const nextRoot = hierarchy(rootData)
      .sum((d: any) => d.value || 0)
      .sort((a, b) => (b.value || 0) - (a.value || 0));

    treemap<any>()
      .size([dimensions.width, dimensions.height])
      .paddingInner(3)
      .paddingOuter(4)
      .paddingTop((node: any) => {
        if (node.depth !== 1) return 0;
        const width = node.x1 - node.x0;
        const nodeHeight = node.y1 - node.y0;
        return width >= 110 && nodeHeight >= 64 ? 20 : 3;
      })
      .tile(treemapSquarify.ratio(1.35))(nextRoot);

    return { root: nextRoot, leaves: nextRoot.leaves() };
  }, [dimensions.height, dimensions.width, sizeBy, stocks]);

  if (!stocks.length) return null;

  return (
    <div
      ref={containerRef}
      data-testid="sector-heatmap"
      className="relative w-full overflow-hidden rounded-xl border border-card-border bg-surface-subtle select-none"
      style={{ height }}
    >
      <svg
        width="100%"
        height="100%"
        viewBox={`0 0 ${dimensions.width} ${dimensions.height}`}
        preserveAspectRatio="none"
        className="block h-full w-full"
        role="img"
        aria-label={`Market heatmap showing ${stocks.length} stocks`}
      >
        {/* Sector group labels */}
        {root.children?.map((sectorNode: any) => {
          const x = sectorNode.x0;
          const y = sectorNode.y0;
          const w = sectorNode.x1 - sectorNode.x0;
          const h = sectorNode.y1 - sectorNode.y0;
          if (w < 110 || h < 64) return null;
          return (
            <text
              key={`label-${sectorNode.data.name}`}
              x={x + 6}
              y={y + 14}
              fontSize={9}
              fill="#8b95a5"
              fontWeight={700}
              pointerEvents="none"
            >
              {String(sectorNode.data.name).toUpperCase()}
            </text>
          );
        })}

        {/* Stock cells */}
        {leaves.map((leaf: any) => {
          const d = leaf.data;
          const x = leaf.x0;
          const y = leaf.y0;
          const w = leaf.x1 - leaf.x0;
          const h = leaf.y1 - leaf.y0;

          if (w < 2 || h < 2) return null;

          const area = w * h;
          const showSymbol = w >= 58 && h >= 34 && area >= 2200;
          const showChange = w >= 68 && h >= 48 && area >= 3600;
          const showPrice = w >= 92 && h >= 72 && area >= 7200;

          return (
            <g
              key={d.symbol}
              onClick={() => onStockClick?.(d.symbol)}
              onMouseEnter={(e) =>
                setTooltip({
                  x: e.clientX,
                  y: e.clientY,
                  stock: {
                    symbol: d.symbol,
                    sector: d.sector,
                    last: d.last,
                    changePercent: d.changePercent,
                    volume: d.volume,
                  },
                })
              }
              onMouseLeave={() => setTooltip(null)}
              className="cursor-pointer"
            >
              <rect
                x={x}
                y={y}
                width={w}
                height={h}
                fill={getColorForChange(d.changePercent)}
                stroke="var(--heatmap-stroke)"
                strokeWidth={1.5}
                rx={1}
                vectorEffect="non-scaling-stroke"
                className="transition-opacity hover:opacity-85"
              />
              {showSymbol && (
                <text
                  x={x + w / 2}
                  y={y + h / 2 - (showChange ? 6 : 0)}
                  textAnchor="middle"
                  dominantBaseline="middle"
                  fontSize={w >= 100 && h >= 70 ? 12 : 10}
                  fontWeight={700}
                  fill={getTextColor(d.changePercent)}
                  pointerEvents="none"
                >
                  {d.symbol}
                </text>
              )}
              {showChange && (
                <text
                  x={x + w / 2}
                  y={y + h / 2 + 8}
                  textAnchor="middle"
                  dominantBaseline="middle"
                  fontSize={10}
                  fill={getTextColor(d.changePercent)}
                  pointerEvents="none"
                  opacity={0.9}
                >
                  {d.changePercent >= 0 ? "+" : ""}
                  {d.changePercent.toFixed(1)}%
                </text>
              )}
              {showPrice && (
                <text
                  x={x + w / 2}
                  y={y + h / 2 + 20}
                  textAnchor="middle"
                  dominantBaseline="middle"
                  fontSize={9}
                  fill={getTextColor(d.changePercent)}
                  pointerEvents="none"
                  opacity={0.6}
                >
                  {formatNumber(d.last)}
                </text>
              )}
            </g>
          );
        })}
      </svg>

      {/* Tooltip */}
      {tooltip && (
        <div
          className="fixed z-50 bg-card border border-card-border rounded-lg px-3 py-2 shadow-xl pointer-events-none"
          style={{ left: tooltip.x + 12, top: tooltip.y - 10 }}
        >
          <div className="flex items-center gap-2 mb-1">
            <span className="font-bold text-sm">{tooltip.stock.symbol}</span>
            <span className="text-xs text-muted">{tooltip.stock.sector}</span>
          </div>
          <div className="flex items-center gap-3 text-xs">
            <span className="font-mono">{formatNumber(tooltip.stock.last)}</span>
            <span
              className={cn(
                "font-medium",
                tooltip.stock.changePercent >= 0 ? "text-profit" : "text-loss"
              )}
            >
              {tooltip.stock.changePercent >= 0 ? "+" : ""}
              {tooltip.stock.changePercent.toFixed(2)}%
            </span>
            <span className="text-muted">
              Vol: {(tooltip.stock.volume / 100000).toFixed(1)}L
            </span>
          </div>
        </div>
      )}
    </div>
  );
}
