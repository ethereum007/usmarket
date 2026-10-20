"use client";

import { useEffect, useState, type ReactNode } from "react";
import { useRouter } from "next/navigation";
import { fetchAPI } from "../../lib/api";
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
  return <USInvitationCheck key={user!.id}>{children}</USInvitationCheck>;
}


export function USInvitationCheck({ children }: { children: ReactNode }) {
  const { signOut } = useAuth();
  const [approved, setApproved] = useState(false);
  const [error, setError] = useState("");
  const [retry, setRetry] = useState(0);
  useEffect(() => {
    let active = true;
    setApproved(false);setError("");
    fetchAPI<{ allowed: boolean; market: string; private_mvp: boolean }>("/api/us/research/access")
      .then(result => {
        if (result.allowed !== true || result.market !== "US" || result.private_mvp !== true) throw new Error("Invalid access response");
        if (active) setApproved(true);
      })
      .catch(() => { if (active) setError("Private US access could not be confirmed. Your account may not be invited, or the service may be unavailable. Check again or sign out."); });
    return () => { active = false; };
  }, [retry]);
  if (approved) return <>{children}</>;
  return <main className="grid min-h-screen place-items-center p-6"><div className="space-y-4 max-w-lg">
    {error ? <p role="alert">{error}</p> : <p role="status">Checking your private US invitation…</p>}
    {error && <button type="button" className="workspace-button" onClick={() => setRetry(value => value + 1)}>Check access again</button>}
    <button type="button" className="workspace-button" onClick={() => void signOut().catch(() => setError("Sign-out could not be confirmed. Retry sign-out."))}>Sign out</button>
  </div></main>;
}
