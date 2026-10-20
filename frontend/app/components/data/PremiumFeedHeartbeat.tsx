"use client";

import { useEffect } from "react";
import { useAuth } from "../../contexts/AuthContext";
import { postAPI } from "../../lib/api";

const HEARTBEAT_MS = 60_000;

/** Keeps server-side shared feed refreshes active only while Premium is in use. */
export function PremiumFeedHeartbeat() {
  const { subscription } = useAuth();
  const isPremium = subscription?.tier === "premium" && subscription?.is_active;

  useEffect(() => {
    if (!isPremium) return;

    const beat = () => {
      void postAPI("/api/market-snapshots/heartbeat", {}).catch(() => {
        // The visible feed still has its persisted fallback; do not surface a
        // background presence ping as a trading-screen error.
      });
    };

    beat();
    const timer = window.setInterval(beat, HEARTBEAT_MS);
    return () => window.clearInterval(timer);
  }, [isPremium]);

  return null;
}
