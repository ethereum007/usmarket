import type { Benchmark, Timeframe } from "./universe";
import type { AlertRow, RrgRow } from "./types";

const API_URL = process.env.NEXT_PUBLIC_API_URL ?? "";

type LatestResponse = {
  as_of?: string | null;
  asOf?: string | null;
  tails?: Record<string, RrgRow[]>;
};

type DatesResponse = {
  dates?: string[];
};

type AlertsResponse = {
  alerts?: AlertRow[];
};

function apiUrl(path: string): string {
  return `${API_URL}${path}`;
}

async function fetchJson<T>(path: string): Promise<T> {
  const res = await fetch(apiUrl(path), { credentials: "include" });
  if (!res.ok) {
    throw new Error(`RRG API error: ${res.status}`);
  }
  return res.json() as Promise<T>;
}

export async function fetchTails(opts: {
  benchmark: Benchmark;
  timeframe: Timeframe;
  tail: number;
  asOf?: string | null;
}): Promise<{ asOf: string | null; tails: Record<string, RrgRow[]> }> {
  const params = new URLSearchParams({
    benchmark: opts.benchmark,
    timeframe: opts.timeframe,
    tail: String(opts.tail),
  });
  if (opts.asOf) params.set("as_of", opts.asOf);

  const data = await fetchJson<LatestResponse>(`/api/rrg/latest?${params}`);
  return {
    asOf: data.asOf ?? data.as_of ?? null,
    tails: data.tails ?? {},
  };
}

export async function fetchDates(opts: {
  benchmark: Benchmark;
  timeframe: Timeframe;
}): Promise<string[]> {
  const params = new URLSearchParams({
    benchmark: opts.benchmark,
    timeframe: opts.timeframe,
  });
  const data = await fetchJson<DatesResponse>(`/api/rrg/dates?${params}`);
  return data.dates ?? [];
}

export async function fetchAlerts(opts: {
  benchmark: Benchmark;
  timeframe: Timeframe;
  limit?: number;
}): Promise<AlertRow[]> {
  const params = new URLSearchParams({
    benchmark: opts.benchmark,
    timeframe: opts.timeframe,
    limit: String(opts.limit ?? 100),
  });
  const data = await fetchJson<AlertsResponse>(`/api/rrg/alerts?${params}`);
  return data.alerts ?? [];
}
