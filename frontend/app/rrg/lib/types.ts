export type Quadrant = "leading" | "weakening" | "lagging" | "improving";

export type RrgRow = {
  as_of_date: string;
  symbol: string;
  benchmark: string;
  timeframe: "daily" | "weekly";
  rs_ratio: number;
  rs_momentum: number;
  quadrant: Quadrant;
};

export type AlertRow = {
  id: number;
  fired_at: string;
  as_of_date: string;
  symbol: string;
  benchmark: string;
  timeframe: "daily" | "weekly";
  from_quadrant: Quadrant;
  to_quadrant: Quadrant;
  dispatched_at: string | null;
};
