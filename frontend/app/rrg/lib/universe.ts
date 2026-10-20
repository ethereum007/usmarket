// RRG universe — keep in sync with alpha-radar-backend/app/services/rrg_service.py
// The backend is the source of truth; this file mirrors it for filtering + color
// assignment on the frontend.

export const PRIMARY_BENCHMARK = "NIFTY 50";

export const BENCHMARKS = [
  "NIFTY 50",
  "NIFTY 500",
  "NIFTY MIDCAP 100",
  "NIFTY BANK",
] as const;
export type Benchmark = (typeof BENCHMARKS)[number];

export const TIMEFRAMES = ["daily", "weekly"] as const;
export type Timeframe = (typeof TIMEFRAMES)[number];

export const CLASSIC_SECTORS = [
  "NIFTY AUTO",
  "NIFTY BANK",
  "NIFTY FMCG",
  "NIFTY IT",
  "NIFTY MEDIA",
  "NIFTY METAL",
  "NIFTY PHARMA",
  "NIFTY PSU BANK",
  "NIFTY REALTY",
  "NIFTY ENERGY",
  "NIFTY FIN SERVICE",
] as const;

export const THEMATIC_SECTORS = [
  "NIFTY HEALTHCARE",
  "NIFTY PVT BANK",
  "NIFTY OIL AND GAS",
  "NIFTY CONSR DURBL",
  "NIFTY COMMODITIES",
  "NIFTY INFRA",
  "NIFTY MNC",
  "NIFTY PSE",
  "NIFTY CPSE",
  "NIFTY SERV SECTOR",
  "NIFTY INDIA CONSUMPTION",
  "NIFTY INDIA DIGITAL",
  "NIFTY INDIA DEFENCE",
  "NIFTY INDIA MFG",
  "NIFTY FIN SRV 25 50",
  "NIFTY HOUSING",
  "NIFTY ALPHA 50",
] as const;

export const SIZE_SECTORS = [
  "NIFTY 100",
  "NIFTY 200",
  "NIFTY NEXT 50",
  "NIFTY MIDCAP 50",
  "NIFTY MIDCAP 150",
  "NIFTY LARGEMID250",
  "NIFTY SMLCAP 50",
  "NIFTY SMLCAP 100",
  "NIFTY SMLCAP 250",
  "NIFTY MICROCAP250",
] as const;

export const SECTORS = [
  ...CLASSIC_SECTORS,
  ...THEMATIC_SECTORS,
  ...SIZE_SECTORS,
] as const;

export const SECTOR_GROUPS = {
  classic: { label: "Classic 11", symbols: CLASSIC_SECTORS },
  thematic: { label: "Thematic", symbols: THEMATIC_SECTORS },
  size: { label: "Size", symbols: SIZE_SECTORS },
  all: { label: "All", symbols: SECTORS },
} as const;

export type SectorGroup = keyof typeof SECTOR_GROUPS;

// 38-color palette derived from Plotly's qualitative D3 + Light24 sets.
const PALETTE = [
  "#1f77b4", "#ff7f0e", "#2ca02c", "#9467bd", "#8c564b",
  "#e377c2", "#17becf", "#bcbd22", "#d62728", "#7f7f7f",
  "#393b79", "#637939", "#8c6d31", "#843c39", "#7b4173",
  "#5254a3", "#8ca252", "#bd9e39", "#ad494a", "#a55194",
  "#6b6ecf", "#b5cf6b", "#e7ba52", "#d6616b", "#ce6dbd",
  "#9c9ede", "#cedb9c", "#e7cb94", "#e7969c", "#de9ed6",
  "#3182bd", "#e6550d", "#31a354", "#756bb1", "#636363",
  "#6baed6", "#fd8d3c", "#74c476", "#9e9ac8",
];

export const SECTOR_COLOR: Record<string, string> = Object.fromEntries(
  SECTORS.map((s, i) => [s, PALETTE[i % PALETTE.length]]),
);

export function sectorsFor(benchmark: Benchmark): readonly string[] {
  return SECTORS.filter((s) => s !== benchmark);
}
