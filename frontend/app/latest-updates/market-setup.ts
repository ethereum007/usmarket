export type Candle = { date: string; open: number; high: number; low: number; close: number; volume: number };
export type MarketSetup = { label: string; tone: "up" | "down" | "neutral"; reason: string; close?: number; changePct?: number; resistance?: number; support?: number; volumeRatio?: number | null; asOf?: string };
export function marketSetup(candles: Candle[], asOf: string): MarketSetup {
  if (candles.length < 51) return { label: "Insufficient data", tone: "neutral", reason: "At least 51 completed daily candles are required." };
  const last = candles.at(-1)!;
  const previous = candles.at(-2)!;
  const lookback = candles.slice(-21, -1);
  const resistance = Math.max(...lookback.map(c => c.high));
  const support = Math.min(...lookback.map(c => c.low));
  const averageVolume = lookback.reduce((sum, c) => sum + c.volume, 0) / 20;
  const volumeRatio = averageVolume > 0 && last.volume > 0 ? last.volume / averageVolume : null;
  const base = { close: last.close, changePct: (last.close / previous.close - 1) * 100, resistance, support, volumeRatio, asOf: last.date };
  const age = (Date.parse(asOf) - Date.parse(last.date)) / 86400000;
  if (age > 7 || age < 0) return { ...base, label: "Data stale", tone: "neutral", reason: "The last completed candle is outside the requested date window. Refresh data before evaluating the setup." };
  if (last.close > resistance * 1.002) return { ...base, label: "Breakout", tone: "up", reason: `Daily close is above the prior 20-session high (0.2% buffer). ${volumeRatio != null && volumeRatio >= 1.5 ? "Volume is at least 1.5× its prior 20-session average." : "Strong volume confirmation is absent or unavailable."}` };
  if (last.close < support * 0.998) return { ...base, label: "Breakdown", tone: "down", reason: "Daily close is below the prior 20-session low (0.2% buffer)." };
  if (last.close >= resistance * 0.98) return { ...base, label: "Near resistance", tone: "neutral", reason: "Within 2% of the prior 20-session high; a breakout is not confirmed." };
  if (last.close <= support * 1.02) return { ...base, label: "Near support", tone: "neutral", reason: "Within 2% of the prior 20-session low; a breakdown is not confirmed." };
  const recent = candles.slice(-10);
  if ((Math.max(...recent.map(c => c.high)) - Math.min(...recent.map(c => c.low))) / last.close <= 0.06) return { ...base, label: "Consolidating", tone: "neutral", reason: "The last 10-session high-to-low range is no more than 6% of the latest close." };
  const average = (n: number) => candles.slice(-n).reduce((sum, c) => sum + c.close, 0) / n;
  const ma20 = average(20), ma50 = average(50);
  if (last.close > ma20 && ma20 > ma50) return { ...base, label: "Uptrend", tone: "up", reason: "Close is above the 20-day average, which is above the 50-day average." };
  if (last.close < ma20 && ma20 < ma50) return { ...base, label: "Downtrend", tone: "down", reason: "Close is below the 20-day average, which is below the 50-day average." };
  return { ...base, label: "Range-bound", tone: "neutral", reason: "No 20-session range break or aligned 20/50-day trend is present." };
}
