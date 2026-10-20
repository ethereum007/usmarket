"use client";

import { useEffect, type ReactNode } from "react";
import { useRouter } from "next/navigation";
import { useAuth } from "../../contexts/AuthContext";

// This is navigation UX only. The API independently verifies every bearer token.
export function USAccessGuard({ children }: { children: ReactNode }) {
  const { user, loading } = useAuth();
  const router = useRouter();
  const allowed = Boolean(user && !user.is_anonymous);
  useEffect(() => {
    if (!loading && !allowed) router.replace("/us/login");
  }, [loading, allowed, router]);
  if (loading || !allowed) {
    return <main className="grid min-h-screen place-items-center" role="status">{loading ? "Checking US research access…" : "Opening US sign-in…"}</main>;
  }
  return <>{children}</>;
}
