"use client";

import { useAuth } from "../../contexts/AuthContext";
import { usePathname, useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { PremiumLocked } from "../premium/PremiumBadge";

const PUBLIC_PATHS = [
  "/",
  "/latest-updates",
  "/heatmap",
  "/sectors",
  "/stocks",
  "/guide",
  "/subscription",
  "/login",
  "/signup",
  "/forgot-password",
  "/reset-password",
];

const PREMIUM_PATHS = [
  "/us",
  "/swing",
  "/pulse",
  "/options",
  "/fno",
  "/trade-ideas",
  "/radar-trade",
  "/rrg",
  "/snapshots",
];

function matchesPath(pathname: string, route: string) {
  return pathname === route || (route !== "/" && pathname.startsWith(`${route}/`));
}

export function ProtectedRoute({ children }: { children: React.ReactNode }) {
  const {
    user,
    loading,
    subscription,
    subscriptionLoading,
    subscriptionError,
    refreshSubscription,
    signOut,
  } = useAuth();
  const pathname = usePathname();
  const router = useRouter();
  const [isLocalhost, setIsLocalhost] = useState(false);
  const [mounted, setMounted] = useState(false);

  const isPublicPage = PUBLIC_PATHS.some((route) => matchesPath(pathname, route));
  const isPremiumPage = PREMIUM_PATHS.some((route) => matchesPath(pathname, route));
  const hasPremium = subscription?.tier === "premium" && subscription?.status === "active";

  useEffect(() => {
    setMounted(true);
    setIsLocalhost(window.location.hostname === "localhost");
  }, []);

  useEffect(() => {
    if (!mounted) return;
    // Skip auth check on localhost for development
    if (isLocalhost) return;

    if (!loading && !user && !isPublicPage) {
      router.replace("/login");
    }
  }, [user, loading, isPublicPage, router, isLocalhost, mounted]);

  // Wait for client mount to avoid hydration mismatch.
  if (!mounted || loading) {
    if (isPublicPage) return <>{children}</>;
    return <AccessLoading label="Checking access..." />;
  }

  // On localhost, always render children without a production auth dependency.
  if (isLocalhost) {
    return <>{children}</>;
  }

  // Public pages always render.
  if (isPublicPage) {
    return <>{children}</>;
  }

  // Not authenticated in production. The redirect is started in the effect above.
  if (!user) {
    return <AccessLoading label="Redirecting to login..." />;
  }

  if (isPremiumPage && subscriptionLoading) {
    return <AccessLoading label="Checking Premium access..." />;
  }

  if (isPremiumPage && subscriptionError) {
    return (
      <div className="mx-auto flex min-h-[60vh] w-full max-w-2xl items-center px-4">
        <div className="w-full rounded-xl bg-card p-8 text-center shadow-sm">
          <div className="mx-auto mb-4 grid h-10 w-10 place-items-center rounded-full bg-warning/15 text-lg font-black text-warning">
            !
          </div>
          <h2 className="text-lg font-bold text-text-heading">Your Premium access could not be verified</h2>
          <p className="mx-auto mt-2 max-w-lg text-sm leading-relaxed text-text-secondary">
            Your plan has not been changed. Retry the session check, or sign in again if this browser session has expired.
          </p>
          <div className="mt-5 flex flex-wrap justify-center gap-2">
            <button className="workspace-button workspace-button-primary" onClick={() => void refreshSubscription()}>
              Retry access check
            </button>
            <button
              className="workspace-button"
              onClick={() => void signOut().finally(() => router.push("/login"))}
            >
              Sign in again
            </button>
          </div>
        </div>
      </div>
    );
  }

  if (isPremiumPage && !hasPremium) {
    return (
      <div className="mx-auto flex min-h-[60vh] w-full max-w-2xl items-center px-4">
        <PremiumLocked
          title="This is part of Alpha Radar Premium"
          description="Premium includes every advanced radar and scanner, plus 2-3 weekday-morning live Zoom intraday trading sessions. Access is ₹999 for 30 days."
          className="w-full p-10"
        />
      </div>
    );
  }

  return <>{children}</>;
}

function AccessLoading({ label }: { label: string }) {
  return (
    <div className="flex min-h-[60vh] items-center justify-center">
      <div className="flex flex-col items-center gap-3">
        <div className="h-8 w-8 animate-spin rounded-full border-2 border-accent border-t-transparent" />
        <span className="text-sm text-muted">{label}</span>
      </div>
    </div>
  );
}
