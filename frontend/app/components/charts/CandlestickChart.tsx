"use client";

import { useEffect, useRef } from "react";
import {
  createChart,
  ColorType,
  CrosshairMode,
  CandlestickSeries,
  HistogramSeries,
  LineStyle,
} from "lightweight-charts";
import type { IChartApi, Time } from "lightweight-charts";

interface CPROverlay {
  pivot: number;
  bc: number;
  tc: number;
  r1?: number;
  s1?: number;
}

interface Props {
  appearance?: "light" | "dark";
  data: { date: string; open: number; high: number; low: number; close: number; volume: number }[];
  cprLevels?: CPROverlay;
  symbol?: string;
  height?: number;
  priceLevels?: { price: number; title: string; color: string }[];
}

export function CandlestickChart({ appearance, data, cprLevels, priceLevels, symbol = "", height = 450 }: Props) {
  const chartRef = useRef<HTMLDivElement>(null);
  const chartApi = useRef<IChartApi | null>(null);

  useEffect(() => {
    if (!chartRef.current || !data.length) return;

    const styles = getComputedStyle(document.documentElement);
    const chartBg = appearance ? (appearance === "light" ? "#ffffff" : "#131a24") : styles.getPropertyValue("--chart-bg").trim() || "#111620";
    const textColor = appearance ? (appearance === "light" ? "#637084" : "#96a3b5") : styles.getPropertyValue("--muted").trim() || "#8b95a5";
    const isLight = appearance ? appearance === "light" : document.documentElement.getAttribute("data-theme") === "light";
    const gridColor = isLight ? "rgba(0,0,0,0.06)" : "rgba(255,255,255,0.04)";

    const chart = createChart(chartRef.current, {
      layout: {
        background: { type: ColorType.Solid, color: chartBg },
        textColor,
        fontSize: 11,
      },
      grid: {
        vertLines: { color: gridColor },
        horzLines: { color: gridColor },
      },
      crosshair: {
        mode: CrosshairMode.Normal,
        vertLine: { color: "rgba(68,138,255,0.3)", width: 1, style: 2 },
        horzLine: { color: "rgba(68,138,255,0.3)", width: 1, style: 2 },
      },
      rightPriceScale: {
        borderColor: "#1e2736",
        scaleMargins: { top: 0.1, bottom: 0.25 },
      },
      timeScale: {
        borderColor: "#1e2736",
        timeVisible: false,
      },
      width: chartRef.current.clientWidth,
      height,
    });
    chartApi.current = chart;

    // Candlestick series (v5 API)
    const candles = chart.addSeries(CandlestickSeries, {
      upColor: "#00c853",
      downColor: "#ff1744",
      borderUpColor: "#00c853",
      borderDownColor: "#ff1744",
      wickUpColor: "#00c853",
      wickDownColor: "#ff1744",
    });

    candles.setData(
      data.map((d) => ({
        time: d.date as Time,
        open: d.open,
        high: d.high,
        low: d.low,
        close: d.close,
      }))
    );

    // Volume histogram (v5 API)
    const volumes = chart.addSeries(HistogramSeries, {
      priceFormat: { type: "volume" },
      priceScaleId: "volume",
    });

    chart.priceScale("volume").applyOptions({
      scaleMargins: { top: 0.8, bottom: 0 },
    });

    volumes.setData(
      data.map((d) => ({
        time: d.date as Time,
        value: d.volume,
        color: d.close >= d.open ? "rgba(0,200,83,0.2)" : "rgba(255,23,68,0.2)",
      }))
    );

    // CPR horizontal price lines
    // Colors: Pivot = blue, TC/BC = green, R1/S1 = red
    // All lines dashed for clear distinction from candlesticks
    if (cprLevels) {
      const cprLines: { price: number; color: string; title: string; lineWidth: number; lineStyle: number }[] = [
        { price: cprLevels.pivot, color: "#448aff", title: "Pivot", lineWidth: 2, lineStyle: LineStyle.Dashed },
        { price: cprLevels.tc, color: "#00c853", title: "TC", lineWidth: 1, lineStyle: LineStyle.Dashed },
        { price: cprLevels.bc, color: "#00c853", title: "BC", lineWidth: 1, lineStyle: LineStyle.Dashed },
      ];
      if (cprLevels.r1) {
        cprLines.push({ price: cprLevels.r1, color: "#ff5252", title: "R1", lineWidth: 1, lineStyle: LineStyle.Dashed });
      }
      if (cprLevels.s1) {
        cprLines.push({ price: cprLevels.s1, color: "#ff5252", title: "S1", lineWidth: 1, lineStyle: LineStyle.Dashed });
      }

      for (const line of cprLines) {
        candles.createPriceLine({
          price: line.price,
          color: line.color,
          lineWidth: line.lineWidth as 1 | 2 | 3 | 4,
          lineStyle: line.lineStyle,
          axisLabelVisible: true,
          title: line.title,
        });
      }
    }

    for (const level of priceLevels || []) {
      if (Number.isFinite(level.price) && level.price > 0) candles.createPriceLine({ price: level.price, title: level.title, color: level.color, lineWidth: 1, lineStyle: LineStyle.Dashed, axisLabelVisible: true });
    }
    chart.timeScale().fitContent();

    const handleResize = () => {
      if (chartRef.current) {
        chart.applyOptions({ width: chartRef.current.clientWidth });
      }
    };
    window.addEventListener("resize", handleResize);

    return () => {
      window.removeEventListener("resize", handleResize);
      chart.remove();
    };
  }, [data, cprLevels, priceLevels, height, appearance]);

  return (
    <div className="relative">
      {symbol && (
        <div className="absolute top-2 left-3 z-10 text-xs text-muted font-mono">
          {symbol}
        </div>
      )}
      {cprLevels && (
        <div className="absolute top-2 right-3 z-10 flex items-center gap-2 text-[10px] font-mono">
          <span className="flex items-center gap-1">
            <span className="w-3 h-px bg-[#448aff] inline-block" style={{ borderTop: "2px dashed #448aff" }} />
            <span className="text-[#448aff]">Pivot</span>
          </span>
          <span className="flex items-center gap-1">
            <span className="w-3 h-px inline-block" style={{ borderTop: "1px dashed #00c853" }} />
            <span className="text-[#00c853]">TC/BC</span>
          </span>
          <span className="flex items-center gap-1">
            <span className="w-3 h-px inline-block" style={{ borderTop: "1px dashed #ff5252" }} />
            <span className="text-[#ff5252]">R1/S1</span>
          </span>
        </div>
      )}
      <div ref={chartRef} />
    </div>
  );
}
