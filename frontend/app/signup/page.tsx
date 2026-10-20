"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { AuthFrame } from "../components/auth/AuthFrame";
import { useAuth } from "../contexts/AuthContext";

type Stage = "form" | "otp";

export default function SignupPage() {
  const router = useRouter();
  const { signUp, verifyOtp, resendOtp, signInWithGoogle, user } = useAuth();

  const [stage, setStage] = useState<Stage>("form");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [otp, setOtp] = useState<string[]>(["", "", "", "", "", ""]);
  const otpRefs = useRef<Array<HTMLInputElement | null>>([]);

  const [error, setError] = useState<string | null>(null);
  const [accountExists, setAccountExists] = useState(false);
  const [loading, setLoading] = useState(false);
  const [resendCooldown, setResendCooldown] = useState(0);
  const [resendMessage, setResendMessage] = useState<string | null>(null);

  useEffect(() => {
    if (user) router.replace("/");
  }, [user, router]);

  useEffect(() => {
    if (resendCooldown <= 0) return;
    const t = setTimeout(() => setResendCooldown((c) => c - 1), 1000);
    return () => clearTimeout(t);
  }, [resendCooldown]);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setAccountExists(false);

    if (password !== confirmPassword) {
      setError("Passwords do not match");
      return;
    }
    if (password.length < 6) {
      setError("Password must be at least 6 characters");
      return;
    }

    setLoading(true);
    const { error: err, userExists } = await signUp(email, password);
    setLoading(false);

    if (userExists) {
      setAccountExists(true);
      return;
    }
    if (err) {
      setError(err);
      return;
    }
    setStage("otp");
    setResendCooldown(30);
    setTimeout(() => otpRefs.current[0]?.focus(), 50);
  }

  function handleOtpChange(index: number, value: string) {
    const digit = value.replace(/\D/g, "").slice(0, 1);
    const next = [...otp];
    next[index] = digit;
    setOtp(next);
    if (digit && index < 5) otpRefs.current[index + 1]?.focus();
  }

  function handleOtpKeyDown(index: number, e: React.KeyboardEvent<HTMLInputElement>) {
    if (e.key === "Backspace" && !otp[index] && index > 0) {
      otpRefs.current[index - 1]?.focus();
    }
  }

  function handleOtpPaste(e: React.ClipboardEvent<HTMLInputElement>) {
    const pasted = e.clipboardData.getData("text").replace(/\D/g, "").slice(0, 6);
    if (!pasted) return;
    e.preventDefault();
    const next = ["", "", "", "", "", ""];
    for (let i = 0; i < pasted.length; i++) next[i] = pasted[i];
    setOtp(next);
    const focusIdx = Math.min(pasted.length, 5);
    otpRefs.current[focusIdx]?.focus();
  }

  async function handleVerify(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    const token = otp.join("");
    if (token.length !== 6) {
      setError("Enter the 6-digit code from your email");
      return;
    }
    setLoading(true);
    const { error: err } = await verifyOtp(email, token);
    setLoading(false);
    if (err) {
      setError(/expired|invalid|incorrect/i.test(err) ? "Incorrect or expired code. Please try again." : err);
      return;
    }
    router.replace("/");
  }

  async function handleResend() {
    if (resendCooldown > 0) return;
    setResendMessage(null);
    setError(null);
    const { error: err } = await resendOtp(email);
    if (err) {
      setError(err);
      return;
    }
    setResendMessage("A new code has been sent to your email.");
    setResendCooldown(30);
  }

  async function handleGoogle() {
    setError(null);
    const { error: err } = await signInWithGoogle();
    if (err) setError(err);
  }

  // ─────────────────────────────── OTP STAGE ───────────────────────────────
  if (stage === "otp") {
    return (
      <AuthFrame>
        <div className="space-y-5">
          <div className="text-center space-y-1">
            <h1 className="text-2xl font-bold text-accent">Verify your email</h1>
            <p className="text-sm text-muted">
              We sent a 6-digit code to
              <br />
              <strong className="text-foreground">{email}</strong>
            </p>
          </div>

          {error && (
            <div className="bg-loss-bg border border-loss/20 rounded p-3 text-loss text-sm">
              {error}
            </div>
          )}
          {resendMessage && !error && (
            <div className="bg-profit/10 border border-profit/20 rounded p-3 text-profit text-sm">
              {resendMessage}
            </div>
          )}

          <form onSubmit={handleVerify} className="space-y-4">
            <div className="flex justify-between gap-2">
              {otp.map((d, i) => (
                <input
                  key={i}
                  aria-label={`Verification code digit ${i + 1}`}
                  autoComplete={i === 0 ? "one-time-code" : "off"}
                  ref={(el) => {
                    otpRefs.current[i] = el;
                  }}
                  type="text"
                  inputMode="numeric"
                  maxLength={1}
                  value={d}
                  onChange={(e) => handleOtpChange(i, e.target.value)}
                  onKeyDown={(e) => handleOtpKeyDown(i, e)}
                  onPaste={handleOtpPaste}
                  className="w-11 h-12 text-center text-lg font-bold bg-background border border-card-border rounded text-foreground focus:outline-none focus:border-accent"
                />
              ))}
            </div>

            <button
              type="submit"
              disabled={loading || otp.join("").length !== 6}
              className="auth-primary-button"
            >
              {loading ? "Verifying..." : "Verify & Continue"}
            </button>
          </form>

          <div className="text-center text-xs text-muted">
            Didn&apos;t get the code?{" "}
            <button
              onClick={handleResend}
              disabled={resendCooldown > 0}
              className="text-accent hover:underline disabled:opacity-50 disabled:no-underline"
            >
              {resendCooldown > 0 ? `Resend in ${resendCooldown}s` : "Resend"}
            </button>
          </div>

          <button
            onClick={() => {
              setStage("form");
              setOtp(["", "", "", "", "", ""]);
              setError(null);
              setResendMessage(null);
            }}
            className="w-full text-xs text-muted hover:text-foreground"
          >
            ← Use a different email
          </button>
        </div>
      </AuthFrame>
    );
  }

  // ─────────────────────────────── FORM STAGE ──────────────────────────────
  return (
    <AuthFrame>
      <div className="space-y-6">
        <div className="text-center">
          <p className="eyebrow mb-3">Get started</p><h1 className="text-3xl font-semibold tracking-tight text-text-heading">Your market starts here.</h1><p className="mt-3 text-sm text-muted">Create your Alpha Radar account.</p>
        </div>

        {accountExists && (
          <div className="bg-accent/10 border border-accent/30 rounded p-3 text-sm space-y-2">
            <p className="text-foreground">
              An account with <strong>{email}</strong> already exists.
            </p>
            <Link
              href={`/login?email=${encodeURIComponent(email)}`}
              className="inline-block text-accent font-semibold hover:underline"
            >
              Sign in instead →
            </Link>
          </div>
        )}

        {error && !accountExists && (
          <div className="bg-loss-bg border border-loss/20 rounded p-3 text-loss text-sm">
            {error}
          </div>
        )}

        <form onSubmit={handleSubmit} className="space-y-4">
          <div>
            <label htmlFor="signup-email" className="auth-label">Email address</label>
            <input
              id="signup-email" type="email" autoComplete="email"
              value={email}
              onChange={(e) => {
                setEmail(e.target.value);
                setAccountExists(false);
              }}
              required
              className="auth-input"
              placeholder="you@example.com"
            />
          </div>
          <div>
            <label htmlFor="signup-password" className="auth-label">Password</label>
            <input
              id="signup-password" type="password" autoComplete="new-password" minLength={6}
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              required
              className="auth-input"
              placeholder="Min 6 characters"
            />
          </div>
          <div>
            <label htmlFor="signup-confirm" className="auth-label">Confirm password</label>
            <input
              id="signup-confirm" type="password" autoComplete="new-password" minLength={6}
              value={confirmPassword}
              onChange={(e) => setConfirmPassword(e.target.value)}
              required
              className="auth-input"
              placeholder="Repeat your password"
            />
          </div>
          <button
            type="submit"
            disabled={loading}
            className="auth-primary-button"
          >
            {loading ? "Sending code..." : "Create Account"}
          </button>
        </form>

        <div className="relative">
          <div className="absolute inset-0 flex items-center">
            <div className="w-full border-t border-card-border" />
          </div>
          <div className="relative flex justify-center text-xs">
            <span className="bg-card px-2 text-muted">or</span>
          </div>
        </div>

        <button
          onClick={handleGoogle}
          className="w-full py-2 bg-background border border-card-border rounded text-sm font-medium text-foreground hover:bg-hover-bg flex items-center justify-center gap-2"
        >
          <svg className="w-4 h-4" viewBox="0 0 24 24">
            <path fill="#4285F4" d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92a5.06 5.06 0 0 1-2.2 3.32v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.1z" />
            <path fill="#34A853" d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z" />
            <path fill="#FBBC05" d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l2.85-2.22.81-.62z" />
            <path fill="#EA4335" d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z" />
          </svg>
          Continue with Google
        </button>

        <p className="text-center text-xs text-muted">
          Already have an account?{" "}
          <Link href="/login" className="text-accent hover:underline">
            Sign in
          </Link>
        </p>
      </div>
    </AuthFrame>
  );
}
