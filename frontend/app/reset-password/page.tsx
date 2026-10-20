"use client";

import { FormEvent, useEffect, useState } from "react";
import Link from "next/link";
import { AuthFrame } from "../components/auth/AuthFrame";
import { useRouter } from "next/navigation";
import { supabase } from "../lib/supabase";

export default function ResetPasswordPage() {
  const router = useRouter();
  const [password, setPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [loading, setLoading] = useState(false);
  const [checkingSession, setCheckingSession] = useState(true);
  const [hasRecoverySession, setHasRecoverySession] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let active = true;

    async function checkSession() {
      if (!supabase) {
        if (active) {
          setError("Login service is not configured. Please try again shortly.");
          setCheckingSession(false);
        }
        return;
      }

      const url = new URL(window.location.href);
      const hashParams = new URLSearchParams(window.location.hash.replace(/^#/, ""));
      const linkError = url.searchParams.get("error_description") || hashParams.get("error_description");
      if (linkError && active) {
        setError(linkError.replace(/\+/g, " "));
      }

      const { data } = await supabase.auth.getSession();
      if (active) {
        setHasRecoverySession(Boolean(data.session));
        setCheckingSession(false);
      }
    }

    checkSession();

    const { data: listener } =
      supabase?.auth.onAuthStateChange((event, session) => {
        if (event === "PASSWORD_RECOVERY" || session) {
          setHasRecoverySession(Boolean(session));
          setCheckingSession(false);
        }
      }) ?? { data: { subscription: null } };

    return () => {
      active = false;
      listener.subscription?.unsubscribe();
    };
  }, []);

  async function handleSubmit(event: FormEvent) {
    event.preventDefault();
    setError(null);
    setMessage(null);

    if (password.length < 6) {
      setError("Password must be at least 6 characters.");
      return;
    }
    if (password !== confirmPassword) {
      setError("Passwords do not match.");
      return;
    }
    if (!supabase) {
      setError("Login service is not configured. Please try again shortly.");
      return;
    }

    setLoading(true);
    const { error: updateError } = await supabase.auth.updateUser({ password });
    setLoading(false);

    if (updateError) {
      setError(updateError.message || "Could not update password. Please request a fresh reset link.");
      return;
    }

    setMessage("Password updated. Taking you to Alpha Radar...");
    setTimeout(() => router.replace("/"), 900);
  }

  return (
    <AuthFrame>
        <div>
          <Link href="/login" className="text-sm font-bold text-accent hover:underline">
            Back to login
          </Link>

          <div className="mt-8">
            <p className="text-xs font-semibold uppercase tracking-[0.22em] text-accent">Alpha Radar</p>
            <h1 className="mt-3 text-3xl font-semibold tracking-[0]">Create new password</h1>
            <p className="mt-3 text-sm leading-6 text-muted">
              Use a strong password for your trading dashboard account.
            </p>
          </div>

          {error && (
            <div className="mt-6 rounded-xl border border-[#ff6b6b]/30 bg-[#ff6b6b]/10 px-4 py-3 text-sm font-semibold text-loss">
              {error}
            </div>
          )}

          {message && (
            <div className="mt-6 rounded-xl border border-[#2fd07c]/30 bg-accent/10 px-4 py-3 text-sm font-semibold text-profit">
              {message}
            </div>
          )}

          {checkingSession ? (
            <div className="mt-7 rounded-xl border border-card-border bg-background px-4 py-4 text-sm font-semibold text-muted">
              Checking reset link...
            </div>
          ) : !hasRecoverySession ? (
            <div className="mt-7 space-y-4">
              <div className="rounded-xl border border-[#ffb86b]/30 bg-[#ffb86b]/10 px-4 py-3 text-sm font-semibold text-[#ffd29a]">
                This reset link is missing or expired. Please request a fresh password reset email.
              </div>
              <Link
                href="/forgot-password"
                className="flex h-12 w-full items-center justify-center rounded-xl bg-[var(--accent-solid)] px-5 text-sm font-semibold text-white transition hover:brightness-110"
              >
                Request new reset link
              </Link>
            </div>
          ) : (
            <form onSubmit={handleSubmit} className="mt-7 space-y-5">
              <label className="block">
                <span className="text-sm font-bold text-muted">New password</span>
                <input
                  type="password"
                  value={password}
                  onChange={(event) => setPassword(event.target.value)}
                  placeholder="Min 6 characters"
                  required
                  className="mt-2 h-12 w-full rounded-xl border border-card-border bg-background px-4 text-sm font-semibold text-text-heading outline-none transition placeholder:text-[#64748b] focus:border-[#7cc4ff] focus:ring-4 focus:ring-[#7cc4ff]/10"
                />
              </label>

              <label className="block">
                <span className="text-sm font-bold text-muted">Confirm password</span>
                <input
                  type="password"
                  value={confirmPassword}
                  onChange={(event) => setConfirmPassword(event.target.value)}
                  placeholder="Repeat new password"
                  required
                  className="mt-2 h-12 w-full rounded-xl border border-card-border bg-background px-4 text-sm font-semibold text-text-heading outline-none transition placeholder:text-[#64748b] focus:border-[#7cc4ff] focus:ring-4 focus:ring-[#7cc4ff]/10"
                />
              </label>

              <button
                type="submit"
                disabled={loading || !password || !confirmPassword}
                className="flex h-12 w-full items-center justify-center rounded-xl bg-[var(--accent-solid)] px-5 text-sm font-semibold text-white transition hover:brightness-110 disabled:cursor-not-allowed disabled:opacity-50"
              >
                {loading ? "Updating password..." : "Update password"}
              </button>
            </form>
          )}
        </div>
    </AuthFrame>
  );
}
