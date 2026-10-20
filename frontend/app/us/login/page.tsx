"use client";

import { useEffect, useState, type FormEvent } from "react";
import { useRouter } from "next/navigation";
import { useAuth } from "../../contexts/AuthContext";
import { supabase } from "../../lib/supabase";

export default function USLoginPage() {
  const { user, loading, signIn, signOut } = useAuth();
  const router = useRouter();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    if (!loading && user && !user.is_anonymous) router.replace("/us");
  }, [loading, user, router]);
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
      <div><p className="text-sm text-text-secondary">ALPHA RADAR US · PRIVATE BETA</p><h1 className="mt-3 text-3xl font-semibold">Your US research workspace</h1><p className="mt-3 text-sm text-text-secondary">Sign in with your US beta account to review stock setups, source charts and market-data diagnostics.</p></div>
      {!supabase && <p role="alert">US sign-in is not configured. An administrator must configure the US authentication project before access is available.</p>}
      <form onSubmit={submit} className="flex flex-col gap-4">
        <label className="flex flex-col gap-2">Email<input className="workspace-input" type="email" autoComplete="username" required value={email} onChange={event => setEmail(event.target.value)} /></label>
        <label className="flex flex-col gap-2">Password<input className="workspace-input" type="password" autoComplete="current-password" required value={password} onChange={event => setPassword(event.target.value)} /></label>
        {error && <p role="alert">{error}</p>}
        <button className="workspace-button workspace-button-primary" disabled={!supabase || loading || busy} type="submit">{busy ? "Signing in…" : "Sign in"}</button>
      </form>
      <p className="text-sm text-text-secondary">Account creation and password recovery are managed by your beta administrator during private testing.</p>
      <p className="text-xs text-text-secondary">Research software. Scores are uncalibrated; a setup does not establish a trading edge.</p>
    </main>
  );
}
