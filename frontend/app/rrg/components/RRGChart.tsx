"use client";

import dynamic from "next/dynamic";
import { useEffect, useMemo, useRef, useState } from "react";
import { useTheme } from "../../lib/theme";
import type { ComponentType } from "react";
import type { Data, Layout } from "plotly.js";
import type { PlotParams } from "react-plotly.js";

import { SECTOR_COLOR } from "../lib/universe";
import { shortLabel } from "../lib/rrg";
import type { RrgRow } from "../lib/types";

// Plotly is heavy (~3MB) — load client-side only to keep SSR bundles small.
const Plot = dynamic<PlotParams>(
  async () => {
    const [{ default: createPlotlyComponent }, plotlyModule] =
      await Promise.all([
        import("react-plotly.js/factory"),
        import("plotly.js"),
      ]);
    const plotly =
      (plotlyModule as { default?: object }).default ?? plotlyModule;
    return createPlotlyComponent(plotly) as ComponentType<PlotParams>;
  },
  { ssr: false, loading: () => <ChartSkeleton /> },
);

function ChartSkeleton() {
  return (
    <div className="flex items-center justify-center h-[540px] text-muted text-sm">
      Loading chart…
    </div>
  );
}

type Props = {
  tails: Record<string, RrgRow[]>;
};

export function RRGChart({ tails }: Props) {
  const { isDark } = useTheme();
  const container = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(600);
  useEffect(() => {
    if (!container.current) return;
    const observer = new ResizeObserver(([entry]) => setWidth(Math.max(600, Math.floor(entry.contentRect.width))));
    observer.observe(container.current);
    return () => observer.disconnect();
  }, []);
  const { data, layout } = useMemo(() => {
    const colors = { card: isDark ? "#131a24" : "#ffffff", muted: isDark ? "#96a3b5" : "#637084", border: isDark ? "#263140" : "#e0e5eb", text: isDark ? "#e5edf7" : "#354154" };
    const traces: Data[] = [];

    let xMin = 95, xMax = 105, yMin = 95, yMax = 105;

    for (const [symbol, points] of Object.entries(tails)) {
      if (points.length === 0) continue;
      const xs = points.map((p) => p.rs_ratio);
      const ys = points.map((p) => p.rs_momentum);
      xMin = Math.min(xMin, ...xs);
      xMax = Math.max(xMax, ...xs);
      yMin = Math.min(yMin, ...ys);
      yMax = Math.max(yMax, ...ys);

      const color = SECTOR_COLOR[symbol] ?? "#888";
      const head = points[points.length - 1];

      // Tail dots fade 25% (oldest) -> 80% (newest) to show direction at a glance.
      const tailOpacity = points.map((_, i) =>
        points.length === 1 ? 1 : 0.25 + (i / (points.length - 1)) * 0.55,
      );

      traces.push({
        x: xs,
        y: ys,
        mode: "lines+markers",
        name: symbol,
        legendgroup: symbol,
        showlegend: false,
        line: { color, width: 1.2 },
        marker: { size: 5, color, opacity: tailOpacity },
        hovertemplate: `<b>${shortLabel(symbol)}</b><br>%{text}<br>ratio %{x:.2f}<br>momentum %{y:.2f}<extra></extra>`,
        text: points.map((p) => p.as_of_date),
      });

      // Fan-out label position based on which quadrant the head sits in —
      // keeps labels away from the cluster around (100, 100).
      const right = head.rs_ratio >= 100;
      const top = head.rs_momentum >= 100;
      const textposition = right
        ? top ? "top right" : "bottom right"
        : top ? "top left" : "bottom left";

      traces.push({
        x: [head.rs_ratio],
        y: [head.rs_momentum],
        mode: "text+markers",
        name: symbol,
        legendgroup: symbol,
        showlegend: false,
        marker: { size: 14, color, line: { color: colors.card, width: 2 } },
        text: [shortLabel(symbol)],
        textposition,
        textfont: { size: 11, family: "Inter, system-ui, sans-serif" },
        hovertemplate: `<b>${shortLabel(symbol)}</b><br>${head.as_of_date}<br>ratio %{x:.2f}<br>momentum %{y:.2f}<extra></extra>`,
      });
    }

    const pad = 1.5;
    const xRange = [xMin - pad, xMax + pad];
    const yRange = [yMin - pad, yMax + pad];

    const layout: Partial<Layout> = {
      autosize: true,
      height: 540,
      margin: { l: 60, r: 30, t: 40, b: 55 },
      xaxis: {
        title: { text: "JdK RS-Ratio →", font: { size: 12, color: colors.muted } },
        range: xRange,
        zeroline: false,
        gridcolor: colors.border,
        color: colors.muted,
      },
      yaxis: {
        title: { text: "JdK RS-Momentum →", font: { size: 12, color: colors.muted } },
        range: yRange,
        zeroline: false,
        gridcolor: colors.border,
        color: colors.muted,
      },
      shapes: [
        // Improving (top-left) — purple
        { type: "rect", xref: "x", yref: "y", x0: xRange[0], x1: 100, y0: 100, y1: yRange[1], fillcolor: "rgba(168, 85, 247, 0.06)", line: { width: 0 }, layer: "below" },
        // Leading (top-right) — green
        { type: "rect", xref: "x", yref: "y", x0: 100, x1: xRange[1], y0: 100, y1: yRange[1], fillcolor: "rgba(16, 185, 129, 0.08)", line: { width: 0 }, layer: "below" },
        // Lagging (bottom-left) — red
        { type: "rect", xref: "x", yref: "y", x0: xRange[0], x1: 100, y0: yRange[0], y1: 100, fillcolor: "rgba(244, 63, 94, 0.06)", line: { width: 0 }, layer: "below" },
        // Weakening (bottom-right) — amber
        { type: "rect", xref: "x", yref: "y", x0: 100, x1: xRange[1], y0: yRange[0], y1: 100, fillcolor: "rgba(245, 158, 11, 0.07)", line: { width: 0 }, layer: "below" },
        { type: "line", x0: 100, x1: 100, y0: yRange[0], y1: yRange[1], line: { color: colors.text, width: 1.2 } },
        { type: "line", x0: xRange[0], x1: xRange[1], y0: 100, y1: 100, line: { color: colors.text, width: 1.2 } },
      ],
      annotations: [
        { x: xRange[1] - 0.3, y: yRange[1] - 0.3, text: "<b>LEADING</b> ↗", showarrow: false, font: { color: "#10b981", size: 14 }, xanchor: "right", yanchor: "top" },
        { x: xRange[0] + 0.3, y: yRange[1] - 0.3, text: "↑ <b>IMPROVING</b>", showarrow: false, font: { color: "#a855f7", size: 14 }, xanchor: "left", yanchor: "top" },
        { x: xRange[0] + 0.3, y: yRange[0] + 0.3, text: "<b>LAGGING</b> ↙", showarrow: false, font: { color: "#f43f5e", size: 14 }, xanchor: "left", yanchor: "bottom" },
        { x: xRange[1] - 0.3, y: yRange[0] + 0.3, text: "↓ <b>WEAKENING</b>", showarrow: false, font: { color: "#f59e0b", size: 14 }, xanchor: "right", yanchor: "bottom" },
        { x: 100, y: 100, text: "100", showarrow: false, font: { color: colors.muted, size: 10 }, xanchor: "left", yanchor: "top", xshift: 4, yshift: -2 },
      ],
      plot_bgcolor: colors.card,
      paper_bgcolor: colors.card,
      font: { color: colors.text, family: "Inter, system-ui, sans-serif" },
      hoverlabel: { bgcolor: colors.card, font: { family: "Inter, system-ui, sans-serif" } },
      showlegend: false,
    };

    return { data: traces, layout };
  }, [tails, isDark]);

  return (
    <div ref={container} className="min-w-0 overflow-x-auto" tabIndex={0} aria-label="Relative rotation chart. Scroll horizontally on smaller screens."><Plot
      data={data}
      layout={{ ...layout, width }}
      config={{ displayModeBar: false, responsive: true }}
      useResizeHandler
      style={{ width, height: "100%" }}
    /></div>
  );
}
