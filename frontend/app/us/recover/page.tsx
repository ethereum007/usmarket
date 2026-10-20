"use client";
import Link from "next/link";
import { useRef, useState, type FormEvent } from "react";
import { useAuth } from "../../contexts/AuthContext";
import { supabase } from "../../lib/supabase";
import { requestUSRecovery, updateUSRecoveredPassword } from "../../lib/us-recovery";

export default function USRecoveryPage() {
  const { loading, user, recoverySession, signOut } = useAuth();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [confirmation, setConfirmation] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [sent, setSent] = useState(false);
  const [updated, setUpdated] = useState(false);
  const [finished, setFinished] = useState(false);
  const pending = useRef(false);
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (pending.current) return;
    pending.current = true;
    setBusy(true);
    setError("");
    try {
      if (recoverySession && user && !user.is_anonymous) {
        await updateUSRecoveredPassword(password, confirmation, true);
        setPassword("");
        setConfirmation("");
        setUpdated(true);
        try {
          await signOut();
          setFinished(true);
        } catch {
          setError("Password updated, but sign-out was not confirmed. Retry sign-out below.");
        }
      } else {
        await requestUSRecovery(email, window.location.origin);
        setSent(true);
      }
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Recovery is unavailable. Please retry.");
    } finally {
      pending.current = false;
      setBusy(false);
    }
  }
  async function finishSignOut() {
    if (pending.current) return;
    pending.current = true;
    setBusy(true);
    setError("");
    try { await signOut(); setFinished(true); }
    catch { setError("Password is updated. Sign-out is still unavailable; retry shortly."); }
    finally { pending.current = false; setBusy(false); }
  }
  return <main className="mx-auto flex min-h-screen max-w-md flex-col justify-center gap-5 px-6 py-12">
    <p className="text-sm text-text-secondary">ALPHA RADAR US</p>
    <h1 className="text-3xl font-semibold">Recover your account</h1>
    {!supabase && <p role="alert">US authentication is not configured. Recovery is unavailable.</p>}
    {loading ? <p role="status">Checking recovery session…</p> : finished ? <p role="status">Password updated and signed out. Sign in with your new password.</p> : updated ? <><p role="status">Password updated.</p><button type="button" className="workspace-button" disabled={busy} onClick={() => void finishSignOut()}>Retry sign-out</button></> : <form className="space-y-4" onSubmit={submit}>
      {recoverySession && user && !user.is_anonymous ? <>
        <p>Choose a new password for this recovery session.</p>
        <label className="block">New password<input className="workspace-input w-full" type="password" autoComplete="new-password" minLength={12} required value={password} onChange={event => setPassword(event.target.value)} /></label>
        <label className="block">Confirm new password<input className="workspace-input w-full" type="password" autoComplete="new-password" minLength={12} required value={confirmation} onChange={event => setConfirmation(event.target.value)} /></label>
      </> : <>
        <p>Request a fresh recovery link. An expired link or a reloaded recovery session may require a new request.</p>
        <label className="block">Account email<input className="workspace-input w-full" type="email" autoComplete="email" required value={email} onChange={event => setEmail(event.target.value)} /></label>
        {sent && <p role="status">If an account matches this email, a recovery link will arrive. Check your inbox and spam folder.</p>}
      </>}
      <button className="workspace-button workspace-button-primary" disabled={!supabase || busy} type="submit">{busy ? "Working…" : recoverySession && user && !user.is_anonymous ? "Update password and sign out" : "Request recovery link"}</button>
    </form>}
    {error && <p role="alert">{error}</p>}
    <Link href="/us/login" className="underline">Back to US sign-in</Link>
  </main>;
}
