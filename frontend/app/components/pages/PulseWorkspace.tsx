"use client";

import { PageHeader } from "../layout/PageHeader";
import { SubTabs } from "../layout/SubTabs";
import PulseContent from "./PulseContent";
import LiveSignalsContent from "./LiveSignalsContent";
import MarketBreadthContent from "./MarketBreadthContent";
import IntradayBreakoutsContent from "./IntradayBreakoutsContent";
import { DataReliabilityStrip } from "../data/DataReliabilityStrip";
import { NiftyPulseIndexCard } from "../dashboard/NiftyPulseIndexCard";
import { PremiumLocked } from "../premium/PremiumBadge";
import { useAuth } from "../../contexts/AuthContext";

export type PulseView = "pulse" | "intraday" | "signals" | "breadth";
const TABS = [
  { key: "pulse" as const, label: "Signal Queue", href: "/pulse" },
  { key: "intraday" as const, label: "Intraday", premium: true, href: "/pulse/intraday" },
  { key: "signals" as const, label: "Live Signals", href: "/pulse/live-signals" },
  { key: "breadth" as const, label: "Market Breadth", href: "/pulse/market-breadth" },
];

export default function PulseWorkspace({ active }: { active: PulseView }) {
  const { subscription } = useAuth();
  const isPremium = subscription?.tier === "premium" && subscription?.is_active;
  const title = active === "intraday" ? "Intraday Breakouts" : "Alpha Radar";
  const description = active === "intraday" ? "Confirmed 5M/15M bullish breakouts and F&O bearish breakdowns, with PDH/PDL." : "Ranked opportunities, with liquidity, market regime and execution context.";
  return <div className="mx-auto max-w-[1500px] space-y-5">
    <div className="space-y-3"><PageHeader eyebrow="Intraday intelligence" title={title} description={description} /><SubTabs tabs={TABS} active={active} /></div>
    {active === "pulse" && <><NiftyPulseIndexCard /><DataReliabilityStrip /></>}
    <div className="min-h-[400px]">
      {active === "pulse" && <PulseContent />}
      {active === "intraday" && !isPremium && <PremiumLocked title="Intraday signals are Premium" description="Upgrade to monitor 5M/15M breakouts and F&O breakdowns with PDH/PDL confirmation." />}
      {active === "intraday" && isPremium && <IntradayBreakoutsContent />}
      {active === "signals" && <LiveSignalsContent />}
      {active === "breadth" && <MarketBreadthContent />}
    </div>
  </div>;
}
