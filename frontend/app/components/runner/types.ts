export type RunnerQuality =
  | "GOOD"
  | "STALE"
  | "MISSING_BASELINE"
  | "MISSING_HISTORY"
  | "PARTIAL"
  | "PROVIDER_MISMATCH"
  | "VOLUME_RESET"
  | "CLOCK_ANOMALY";

export interface RunnerMarketContext {
  sourceTimestamp: string | null;
  symbolsSampled: number;
  advancing: number;
  declining: number;
  coverageSufficient: boolean;
  breadthPct: number | null;
  regime: string | null;
  sectorCount: number;
  niftyReturn: number | null;
  niftyAboveVwap: boolean | null;
}

export interface RunnerJobProgress {
  status?: string;
  completed?: number;
  total?: number;
  failed?: number;
  rowsPersisted?: number;
  currentSymbol?: string;
  [key: string]: unknown;
}

export interface RunnerStatus {
  enabled: boolean;
  running: boolean;
  provider: string | null;
  activeProvider: string | null;
  providerReady: boolean;
  providerLive: boolean;
  kiteStreamLive: boolean | null;
  providerDataAgeSeconds: number | null;
  providerSourceAgeSeconds: number | null;
  lastProviderDataAt: string | null;
  lastProviderSourceTimestamp: string | null;
  lastProviderErrorAt: string | null;
  lastProviderErrorType: string | null;
  universe: string;
  symbolsMonitored: number;
  symbolsConfigured: number;
  baselineCoverage: Record<string, number>;
  latestFeatureTime: string | null;
  staleCount: number;
  dataQuality: Record<string, number>;
  featureVersion: string;
  scoreVersion: string;
  processingLatencyMs: number;
  marketContext: RunnerMarketContext;
  metrics: Record<string, number>;
  persistenceRetryRows: number;
  persistenceRetryRowsDropped: number;
  baselineJob: RunnerJobProgress | null;
  baselineTaskActive: boolean;
  dailyContextCoverage: Record<string, number>;
  dailyContextJob: RunnerJobProgress | null;
  dailyContextTaskActive: boolean;
  liveRunId: string | null;
  lastRunCheckpoint: string | null;
}

export interface RunnerFeature {
  timestamp: string;
  source_timestamp: string;
  processing_timestamp: string;
  session_date: string;
  minute_timestamp: string;
  minute_of_session: number;
  symbol: string;
  exchange: string;
  ltp: number;
  ret_1m: number | null;
  ret_3m: number | null;
  ret_5m: number | null;
  ret_10m: number | null;
  ret_15m: number | null;
  ret_30m: number | null;
  ret_from_open: number | null;
  ret_from_prev_close: number | null;
  return_z_1m: number | null;
  return_z_5m: number | null;
  return_z_15m: number | null;
  rvol_tod_20d: number | null;
  rvol_tod_60d: number | null;
  rvol_tod_z_20d: number | null;
  rvol_tod_z_60d: number | null;
  volume_percentile_20d: number | null;
  volume_percentile_60d: number | null;
  rvol_1m: number | null;
  rvol_3m: number | null;
  rvol_5m: number | null;
  rvol_10m: number | null;
  rvol_15m: number | null;
  volume_velocity_1m: number | null;
  volume_velocity_3m: number | null;
  volume_velocity_5m: number | null;
  volume_acceleration: number | null;
  turnover: number | null;
  turnover_velocity: number | null;
  current_intraday_range: number | null;
  range_tod_ratio: number | null;
  range_expansion: number | null;
  atr_normalized_move: number | null;
  vwap: number | null;
  above_vwap: boolean | null;
  distance_vwap_pct: number | null;
  vwap_slope: number | null;
  pdh: number | null;
  pdl: number | null;
  distance_pdh_pct: number | null;
  distance_pdl_pct: number | null;
  pdh_break: boolean | null;
  pdl_break: boolean | null;
  orb15_break_high: boolean | null;
  orb15_break_low: boolean | null;
  orb30_break_high: boolean | null;
  orb30_break_low: boolean | null;
  distance_20d_high_pct: number | null;
  distance_50d_high_pct: number | null;
  at_20d_high: boolean | null;
  at_50d_high: boolean | null;
  day_range_location: number | null;
  close_location_value: number | null;
  sector: string | null;
  sector_return: number | null;
  sector_relative_strength: number | null;
  sector_rank: number | null;
  market_return: number | null;
  market_above_vwap: boolean | null;
  market_breadth: number | null;
  market_regime: string | null;
  spread_bps: number | null;
  abnormal_score: number | null;
  accumulation_score: number | null;
  institutional_score: number | null;
  market_pulse: string | null;
  data_source: string;
  data_quality: RunnerQuality[];
  freshness_seconds: number;
  feature_version: string;
}

export interface RunnerLatestResponse {
  timestamp: string;
  featureVersion: string;
  sort: RunnerSort;
  total: number;
  returned: number;
  features: RunnerFeature[];
}

export type ParticipationUniverse = "nifty100" | "nifty500" | "smallcap" | "broad";

export interface ParticipationCandidate {
  rank: number;
  symbol: string;
  direction: "UP" | "DOWN" | "MIXED";
  participationScore: number;
  ltp: number;
  rvolTod20d: number;
  rvolTod60d: number | null;
  rvol1m: number | null;
  rvol5m: number;
  volumeAcceleration: number | null;
  turnoverCrore: number;
  ret1m: number | null;
  ret5m: number | null;
  retFromOpen: number | null;
  returnZ5m: number | null;
  rangeTodRatio: number | null;
  aboveVwap: boolean | null;
  distanceVwapPct: number | null;
  pdhBreak: boolean | null;
  orb15BreakHigh: boolean | null;
  orb15BreakLow: boolean | null;
  sector: string | null;
  sectorRelativeStrength: number | null;
  freshnessSeconds: number;
  dataSource: string;
  dataQuality: RunnerQuality[];
  reasons: string[];
}

export interface ParticipationShortlistResponse {
  timestamp: string;
  universe: ParticipationUniverse;
  universeSize: number;
  featuresAvailable: number;
  status: "PARTICIPATION_FOUND" | "NO_PARTICIPATION";
  count: number;
  candidates: ParticipationCandidate[];
  thresholds: {
    rvolTod20d: number;
    rvol5m: number;
    acceleration: number;
    turnoverCrore: number;
  };
  entryReady: false;
}

export type RunnerRankingTier =
  | "HIGH_QUALITY"
  | "RUNNER_CANDIDATE"
  | "STATISTICALLY_UNUSUAL"
  | "OBSERVE";

export interface RunnerRankingCandidate {
  rank: number;
  symbol: string;
  direction: "UP" | "DOWN" | "MIXED";
  runnerScore: number;
  absoluteScore: number;
  crossSectionPercentile: number;
  tier: RunnerRankingTier;
  evidenceCompleteness: number;
  components: {
    participation: number;
    velocity: number;
    price: number;
    range: number;
    structure: number;
    context: number;
  };
  ltp: number;
  rvolTod20d: number;
  rvolTod60d: number | null;
  rvol1m: number | null;
  rvol5m: number;
  volumeAcceleration: number | null;
  turnoverCrore: number;
  ret5m: number | null;
  retFromOpen: number | null;
  rangeTodRatio: number | null;
  aboveVwap: boolean | null;
  pdhBreak: boolean | null;
  pdlBreak: boolean | null;
  sector: string | null;
  sectorRelativeStrength: number | null;
  freshnessSeconds: number;
  dataSource: string;
  dataQuality: RunnerQuality[];
  scoreVersion: string;
  entryReady: false;
  reasons: string[];
}

export interface RunnerRankingResponse {
  timestamp: string;
  universe: ParticipationUniverse;
  universeSize: number;
  featuresAvailable: number;
  eligible: number;
  scoreVersion: string;
  status: "CANDIDATES_FOUND" | "NO_HIGH_QUALITY_CANDIDATE";
  candidateCount: number;
  highQualityCount: number;
  rankings: RunnerRankingCandidate[];
  entryReady: false;
  notice: string;
}

export type RunnerSort =
  | "rvol_tod_20d"
  | "rvol_tod_60d"
  | "rvol_5m"
  | "volume_acceleration"
  | "ret_5m"
  | "range_tod_ratio"
  | "freshness_seconds";

export interface BaselineStat {
  symbol: string;
  minute_of_session: number;
  lookback_sessions: number;
  metric: string;
  median: number | null;
  mean: number | null;
  std: number | null;
  percentiles: Record<string, number>;
  as_of_date: string;
  baseline_version: string;
  sample_count: number;
}

export interface RunnerBaselineResponse {
  symbol: string;
  minuteOfSession: number;
  baselineVersion: string;
  source: string;
  count: number;
  baselines: BaselineStat[];
}
