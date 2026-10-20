"use client";

import { useParams } from "next/navigation";
import IntradayChartContent from "../../../components/pages/IntradayChartContent";
import { PremiumLocked } from "../../../components/premium/PremiumBadge";
import { useAuth } from "../../../contexts/AuthContext";

export default function IntradayChartPage() {
  const params = useParams<{ symbol: string }>();
  const { subscription } = useAuth();
  const isPremium = subscription?.tier === "premium" && subscription?.is_active;
  const symbol = decodeURIComponent(params.symbol || "").toUpperCase();
  if (!isPremium) return <PremiumLocked title="Intraday charts are Premium" description="Upgrade to inspect the full session, 5M/15M confirmations and PDH/PDL levels." />;
  return <IntradayChartContent symbol={symbol} />;
}
