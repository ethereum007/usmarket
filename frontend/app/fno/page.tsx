"use client";

import { Suspense } from "react";
import { PageHeader } from "../components/layout/PageHeader";
import { useRouter, useSearchParams } from "next/navigation";
import FnoLeaderboard from "../components/pages/FnoLeaderboard";
import FnoStockApex from "../components/pages/FnoStockApex";
import { PremiumBadge, PremiumLocked } from "../components/premium/PremiumBadge";
import { useAuth } from "../contexts/AuthContext";

export default function FnoPage() {
  return <Suspense fallback={<div className="h-[420px] animate-pulse rounded-xl bg-card" />}><FnoPageContent /></Suspense>;
}

function FnoPageContent() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const selectedStock = searchParams.get("symbol")?.toUpperCase() || null;
  const selectedView = searchParams.get("view") === "chart" ? "chart" : "options";
  const { subscription } = useAuth();
  const isPremium = subscription?.tier === "premium" && subscription?.is_active;

  const openStock = (symbol: string, view: "chart" | "options" = "options") => {
    router.push(`/radar-trade?symbol=${encodeURIComponent(symbol)}&view=${view}`);
  };

  return (
    <div className="max-w-[1500px] mx-auto space-y-5">
      <PageHeader eyebrow="Derivatives" title="F&O radar" description="Compare futures positioning, filter OI buildup, and open a stock for its complete options analysis." actions={<PremiumBadge />} />

      {!isPremium ? (
        <PremiumLocked
          title="F&O Radar is Premium"
          description="Unlock live F&O futures ranking, OI buildup filters, and per-stock option analytics with Premium."
        />
      ) : selectedStock ? (
        <FnoStockApex symbol={selectedStock} view={selectedView} onBack={() => router.push("/fno")} onViewChange={(view) => openStock(selectedStock, view)} />
      ) : (
        <FnoLeaderboard onSelectStock={(symbol) => openStock(symbol)} />
      )}
    </div>
  );
}
