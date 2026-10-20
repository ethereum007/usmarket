"use client";

import { useEffect, type ReactNode } from "react";
import { useRouter } from "next/navigation";
import { useAuth } from "../../contexts/AuthContext";

// This is navigation UX only. The API independently verifies every bearer token.
export function USAccessGuard({ children }: { children: ReactNode }) {
  const { user, loading, recoverySession } = useAuth();
  const router = useRouter();
  const allowed = Boolean(user && !user.is_anonymous && user.email_confirmed_at);
  useEffect(() => {
    if (!loading && recoverySession) router.replace("/us/recover");
    else if (!loading && !allowed) router.replace("/us/login");
  }, [loading, allowed, recoverySession, router]);
  if (loading || !allowed || recoverySession) {
    return <main className="grid min-h-screen place-items-center" role="status">{loading ? "Checking US research access…" : recoverySession ? "Opening password recovery…" : "Opening US sign-in…"}</main>;
  }
  return <>{children}</>;
}
