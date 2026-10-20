"use client";

import { useEffect, useState, type FormEvent } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useAuth } from "../../contexts/AuthContext";
import { US_SIGNUP_ENABLED } from "../../lib/us-signup";
import { supabase } from "../../lib/supabase";

export default function USLoginPage() {
  const { user, loading, signIn, signOut, recoverySession } = useAuth();
  const router = useRouter();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    if (!loading && user && !user.is_anonymous && (user.email_confirmed_at || recoverySession)) router.replace(recoverySession ? "/us/recover" : "/us");
  }, [loading, user, recoverySession, router]);
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      if (user?.is_anonymous) await signOut();
      const result = await signIn(email.trim(), password);
      if (result.error) setError("Sign-in failed. Check your credentials or contact your beta administrator.");
    } catch {
      setError("The sign-in service is unavailable. Please try again.");
    } finally {
      setBusy(false);
    }
  }
  return (
    <main className="mx-auto flex min-h-screen max-w-md flex-col justify-center gap-6 px-6 py-12">
      <div><p className="text-sm text-text-secondary">ALPHA RADAR US · PRIVATE BETA</p><h1 className="mt-3 text-3xl font-semibold">Your US research workspace</h1><p className="mt-3 text-sm text-text-secondary">Sign in with your invited US beta account to review stock setups, source charts and market-data diagnostics. Confirmed email alone does not grant private MVP access.</p></div>
      {!supabase && <p role="alert">US sign-in is not configured. An administrator must configure the US authentication project before access is available.</p>}
      {user && !user.is_anonymous && !user.email_confirmed_at && <p role="status">Confirm your email before entering the workspace. Check your inbox, or sign out and retry.</p>}
      <form onSubmit={submit} className="flex flex-col gap-4">
        <label className="flex flex-col gap-2">Email<input className="workspace-input" type="email" autoComplete="username" required value={email} onChange={event => setEmail(event.target.value)} /></label>
        <label className="flex flex-col gap-2">Password<input className="workspace-input" type="password" autoComplete="current-password" required value={password} onChange={event => setPassword(event.target.value)} /></label>
        {error && <p role="alert">{error}</p>}
        <button className="workspace-button workspace-button-primary" disabled={!supabase || loading || busy} type="submit">{busy ? "Signing in…" : "Sign in"}</button>
      </form>
      <Link href="/us/recover" className="text-sm underline">Forgot your password?</Link>
      {US_SIGNUP_ENABLED ? <Link href="/us/signup" className="text-sm underline">Create a US account</Link> : <p className="text-sm text-text-secondary">Account creation is managed by your beta administrator during private testing.</p>}
      {user && !user.email_confirmed_at && <button type="button" className="workspace-button" onClick={() => void signOut().catch(() => setError("Sign-out could not be confirmed. Retry shortly."))}>Sign out</button>}
      <p className="text-xs text-text-secondary">Research software. Scores are uncalibrated; a setup does not establish a trading edge.</p>
    </main>
  );
}
