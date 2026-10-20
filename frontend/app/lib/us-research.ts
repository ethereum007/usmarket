import type { ResearchPackage } from "./swing-research";
export type USFeature = {
  available: boolean;
  close?: number;
  sessions?: number;
  return1?: number | null;
  return5?: number | null;
  rs20?: number | null;
  rs60?: number | null;
  rvol20?: number | null;
  turnover20?: number | null;
  ema50?: number | null;
  ema200?: number | null;
};
export type USPackage = ResearchPackage & {
  market: "US";
  currency: "USD";
  benchmark: string;
  feed: string;
  computed_at: string;
  warnings: string[];
  history_gaps?: Record<string, string[]>;
  instrument_exclusions?: Record<string, string>;
  instrument_snapshot?: { id: string; observed_at: string; basis: string; records: Record<string, { provider_asset_id?: string; exchange?: string; resolution: string; reason?: string | null }> };
  session_calendar?: { id: string; version: string; timezone: string; finalization_buffer_minutes: number; sessions: { date: string; close: string; close_at: string; finalized_at: string }[] };
  features: Record<string, USFeature>;
  benchmark_bars: ResearchPackage["source_bars"][string];
};
export type USSummary = Pick<
  USPackage,
  "id" | "session" | "state" | "benchmark" | "feed" | "computed_at" | "symbols"
>;
export const usd = (v: number | null | undefined) =>
  v == null || !Number.isFinite(v)
    ? "—"
    : new Intl.NumberFormat("en-US", {
        style: "currency",
        currency: "USD",
        maximumFractionDigits: 2,
      }).format(v);
export const metric = (v: number | null | undefined, digits = 2) =>
  v == null || !Number.isFinite(v)
    ? "—"
    : v.toLocaleString("en-US", { maximumFractionDigits: digits });
export const signed = (v: number | null | undefined) =>
  v == null ? "—" : `${v > 0 ? "+" : ""}${metric(v)}`;
