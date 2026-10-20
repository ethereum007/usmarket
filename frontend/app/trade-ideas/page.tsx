"use client";

import { Suspense, useEffect, useState } from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import {
  Activity,
  BarChart3,
  Bell,
  Gauge,
  LineChart,
  Search,
  ShieldAlert,
  Target,
  TrendingUp,
  Zap,
  type LucideIcon,
} from "lucide-react";
import SignalsContent from "../components/pages/SignalsContent";
import { CPRScanner } from "../scanner/components/cpr-scanner";
import { PatternScanner } from "../scanner/components/pattern-scanner";
import { VCPScanner } from "../scanner/components/vcp-scanner";
import { NRSqueezeScanner } from "../scanner/components/nr-squeeze-scanner";
import { VolumeProfileScanner } from "../scanner/components/volume-profile-scanner";
import { Bounce52WScanner } from "../scanner/components/bounce-52w-scanner";
import { InstitutionalBuyingScanner } from "../scanner/components/institutional-buying-scanner";
import SwingContent from "../components/pages/SwingContent";
import AbnormalMovesContent from "../components/pages/AbnormalMovesContent";
import PerformanceContent from "../components/pages/PerformanceContent";
import AlertsContent from "../components/pages/AlertsContent";
import AlgoStrategiesContent from "../components/pages/AlgoStrategiesContent";
import { PremiumLocked } from "../components/premium/PremiumBadge";
import { useAuth } from "../contexts/AuthContext";
import { DataReliabilityStrip } from "../components/data/DataReliabilityStrip";
import { cn } from "../lib/utils";
import { PageHeader } from "../components/layout/PageHeader";

type TradeIdeaTab = "signals" | "cpr" | "patterns" | "vcp" | "nr" | "volume" | "bounce52w" | "instbuy" | "swing" | "abnormal" | "performance" | "alerts" | "algos";
type ScannerGroup = "intraday" | "breakout" | "swing" | "ops";

type TradeIdeaTabMeta = {
  key: TradeIdeaTab;
  label: string;
  premium?: boolean;
  group: ScannerGroup;
  icon: LucideIcon;
  description: string;
  cadence: string;
};

const SCANNER_GROUPS: { key: ScannerGroup; label: string; description: string }[] = [
  { key: "intraday", label: "Intraday", description: "Options, CPR, and live flow" },
  { key: "breakout", label: "Breakout", description: "Pattern and participation scans" },
  { key: "swing", label: "Swing", description: "Carry trades and abnormal moves" },
  { key: "ops", label: "Track", description: "Alerts and validation loop" },
];

const TABS: TradeIdeaTabMeta[] = [
  {
    key: "signals",
    label: "OI Signals",
    group: "intraday",
    icon: Activity,
    description: "Options-chain bias, PCR, max pain, and OI-led trade ideas.",
    cadence: "Live during market hours",
  },
  {
    key: "cpr",
    label: "CPR Scanner",
    group: "intraday",
    icon: Target,
    description: "Pivot, CPR width, and daily level confluence for index and stock setups.",
    cadence: "Best before and during session",
  },
  {
    key: "patterns",
    label: "Pattern Scanner",
    group: "breakout",
    icon: Search,
    description: "Breakout, breakdown, consolidation, and price-action structure scans.",
    cadence: "Intraday refresh",
  },
  {
    key: "vcp",
    label: "VCP",
    premium: true,
    group: "breakout",
    icon: Gauge,
    description: "Volatility contraction setups where supply is drying up before expansion.",
    cadence: "End-of-day and pre-market",
  },
  {
    key: "nr",
    label: "NR Squeeze",
    premium: true,
    group: "breakout",
    icon: Zap,
    description: "Narrow-range compression candidates that can expand with volume.",
    cadence: "End-of-day and intraday watch",
  },
  {
    key: "volume",
    label: "Volume Profile",
    premium: true,
    group: "intraday",
    icon: BarChart3,
    description: "POC, VAH, VAL, and CPR confluence from volume distribution.",
    cadence: "Refresh after scan",
  },
  {
    key: "bounce52w",
    label: "52W Bounce",
    premium: true,
    group: "swing",
    icon: TrendingUp,
    description: "Names reacting from 52-week support or reclaiming key long-term zones.",
    cadence: "End-of-day scan",
  },
  {
    key: "instbuy",
    label: "Inst. Buying",
    premium: true,
    group: "swing",
    icon: ShieldAlert,
    description: "Delivery and volume behavior that hints at stronger hands accumulating.",
    cadence: "End-of-day scan",
  },
  {
    key: "swing",
    label: "Swing Spectrum",
    premium: true,
    group: "swing",
    icon: LineChart,
    description: "Ranked swing setups across momentum, risk, liquidity, and follow-through.",
    cadence: "Daily with cached fallback",
  },
  {
    key: "abnormal",
    label: "Abnormal Moves",
    premium: true,
    group: "swing",
    icon: Activity,
    description: "Price-volume-delivery dislocations with risk flags and surveillance context.",
    cadence: "Daily with cached fallback",
  },
  {
    key: "alerts",
    label: "Alerts",
    premium: true,
    group: "ops",
    icon: Bell,
    description: "Saved watch triggers for price, level, signal, and quality checks.",
    cadence: "Runs in the background",
  },
  {
    key: "algos",
    label: "Algo Lab",
    premium: true,
    group: "ops",
    icon: Zap,
    description: "Paper-mode strategy packs with risk gates, execution checks, and order preview.",
    cadence: "Preview first, execute later",
  },
  {
    key: "performance",
    label: "Performance",
    premium: true,
    group: "ops",
    icon: BarChart3,
    description: "Signal quality, hit rate, and strategy feedback loop.",
    cadence: "Review after market close",
  },
];

const PREMIUM_TABS = new Set<TradeIdeaTab>(["vcp", "nr", "volume", "bounce52w", "instbuy", "swing", "abnormal", "performance", "alerts", "algos"]);
const TAB_KEYS = new Set<TradeIdeaTab>(TABS.map((tab) => tab.key));

export default function TradeIdeasPage() {
  return (
    <Suspense fallback={<div className="max-w-[1400px] mx-auto text-sm text-muted">Loading trade ideas...</div>}>
      <TradeIdeasContent />
    </Suspense>
  );
}

function TradeIdeasContent() {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const [tab, setTab] = useState<TradeIdeaTab>(() => normalizeTab(searchParams.get("tab")));
  const { subscription } = useAuth();
  const isPremium = subscription?.tier === "premium" && subscription?.is_active;
  const isSignalWarRoom = tab === "signals";

  useEffect(() => {
    const nextTab = normalizeTab(searchParams.get("tab"));
    setTab(nextTab);
  }, [searchParams]);

  function handleTabChange(nextTab: TradeIdeaTab) {
    setTab(nextTab);
    const params = new URLSearchParams(searchParams.toString());
    if (nextTab === "signals") params.delete("tab");
    else params.set("tab", nextTab);
    const query = params.toString();
    router.replace(query ? `${pathname}?${query}` : pathname, { scroll: false });
  }

  return (
    <div className="mx-auto max-w-[1800px] space-y-5">
      <PageHeader eyebrow="Discover & validate" title={TABS.find(t => t.key === tab)?.label || "Scanners"} description={TABS.find(t => t.key === tab)?.description} />
      <SignalScannerDesk tabs={TABS} active={tab} onChange={handleTabChange} />

      {(tab === "swing" || tab === "abnormal") && <DataReliabilityStrip compact />}

      {/* Tab content */}
      <div className={cn(isSignalWarRoom ? "min-h-full" : "min-h-[400px]")}>
        {!isPremium && PREMIUM_TABS.has(tab) && (
          <PremiumLocked
            title={`${TABS.find((t) => t.key === tab)?.label} is Premium`}
            description="Unlock advanced scanners and premium setup discovery with Premium."
          />
        )}
        {tab === "signals" && <SignalsContent />}
        {tab === "cpr" && <CPRScanner />}
        {tab === "patterns" && <PatternScanner />}
        {isPremium && tab === "vcp" && <VCPScanner />}
        {isPremium && tab === "nr" && <NRSqueezeScanner />}
        {isPremium && tab === "volume" && <VolumeProfileScanner />}
        {isPremium && tab === "bounce52w" && <Bounce52WScanner />}
        {isPremium && tab === "instbuy" && <InstitutionalBuyingScanner />}
        {isPremium && tab === "swing" && <SwingContent />}
        {isPremium && tab === "abnormal" && <AbnormalMovesContent />}
        {isPremium && tab === "alerts" && <AlertsContent />}
        {isPremium && tab === "algos" && <AlgoStrategiesContent />}
        {isPremium && tab === "performance" && <PerformanceContent />}
      </div>
    </div>
  );
}

function normalizeTab(value: string | null): TradeIdeaTab {
  return value && TAB_KEYS.has(value as TradeIdeaTab) ? (value as TradeIdeaTab) : "signals";
}

function SignalScannerDesk({
  tabs,
  active,
  onChange,
}: {
  tabs: TradeIdeaTabMeta[];
  active: TradeIdeaTab;
  onChange: (tab: TradeIdeaTab) => void;
}) {
  return (
    <nav className="scanner-navigation" aria-label="Scanner and tracking tools">
      {SCANNER_GROUPS.map(group => (
        <div key={group.key} className="scanner-navigation-row">
          <span className="scanner-navigation-label">{group.label}</span>
          <div className="scanner-navigation-options" role="group" aria-label={group.label}>
            {tabs.filter(tab => tab.group === group.key).map(tab => (
              <button key={tab.key} type="button" className="scanner-link" aria-pressed={active === tab.key} onClick={() => onChange(tab.key)} title={`${tab.description} ${tab.cadence}`}>
                <tab.icon size={14} aria-hidden="true" /><span>{tab.label}</span>
                {tab.premium && <span className="text-[9px] text-muted" title="Premium">P</span>}
              </button>
            ))}
          </div>
        </div>
      ))}
    </nav>
  );
}
