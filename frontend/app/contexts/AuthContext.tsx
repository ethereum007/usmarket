"use client";

import {
  createContext,
  useContext,
  useEffect,
  useState,
  useCallback,
  type ReactNode,
} from "react";
import { supabase, isRecoverySession } from "../lib/supabase";
import { fetchAPI, primeAuthAccessToken } from "../lib/api";
import type { User, Session } from "@supabase/supabase-js";

const AUTH_INITIALIZATION_TIMEOUT_MS = 6_000;

interface SubscriptionInfo {
  tier: string;
  plan: string;
  status: string;
  expires_at: string | null;
  is_active: boolean;
}

interface SignUpResult {
  error: string | null;
  userExists: boolean;
}

interface AuthContextValue {
  recoverySession: boolean;
  user: User | null;
  session: Session | null;
  loading: boolean;
  subscription: SubscriptionInfo | null;
  subscriptionLoading: boolean;
  subscriptionError: string | null;
  signIn: (email: string, password: string) => Promise<{ error: string | null; userNotFound: boolean }>;
  signInWithGoogle: () => Promise<{ error: string | null }>;
  signUp: (email: string, password: string) => Promise<SignUpResult>;
  verifyOtp: (email: string, token: string) => Promise<{ error: string | null }>;
  resendOtp: (email: string) => Promise<{ error: string | null }>;
  signOut: () => Promise<void>;
  refreshSubscription: () => Promise<void>;
}

const AuthContext = createContext<AuthContextValue>({
  recoverySession: false,
  user: null,
  session: null,
  loading: true,
  subscription: null,
  subscriptionLoading: true,
  subscriptionError: null,
  signIn: async () => ({ error: "Not initialized", userNotFound: false }),
  signInWithGoogle: async () => ({ error: "Not initialized" }),
  signUp: async () => ({ error: "Not initialized", userExists: false }),
  verifyOtp: async () => ({ error: "Not initialized" }),
  resendOtp: async () => ({ error: "Not initialized" }),
  signOut: async () => {},
  refreshSubscription: async () => {},
});

export function AuthProvider({ children, checkSubscription = true }: { children: ReactNode; checkSubscription?: boolean }) {
  const [recoverySession, setRecoverySession] = useState(false);
  const [user, setUser] = useState<User | null>(null);
  const [session, setSession] = useState<Session | null>(null);
  const [loading, setLoading] = useState(true);
  const [subscription, setSubscription] = useState<SubscriptionInfo | null>(null);
  const [subscriptionLoading, setSubscriptionLoading] = useState(true);
  const [subscriptionError, setSubscriptionError] = useState<string | null>(null);

  const fetchSubscription = useCallback(async () => {
    if (!checkSubscription) {
      setSubscriptionLoading(false);
      return;
    }
    setSubscriptionLoading(true);
    setSubscriptionError(null);
    try {
      const data = await fetchAPI<Record<string, unknown>>("/api/user-tier");
      const tier = String(data.tier || "free");
      const plan = String(data.plan || "free");
      const status = String(data.status || "active");
      const expiresAt = (data.expiresAt ?? data.expires_at ?? null) as string | null;
      setSubscription({
        tier,
        plan,
        status,
        expires_at: expiresAt,
        is_active: tier === "premium" && status === "active",
      });
    } catch {
      // Keep Premium content closed, but do not mislabel a paid member as Free
      // when session verification or the tier service is temporarily unavailable.
      setSubscription(null);
      setSubscriptionError("We could not verify your Alpha Radar session.");
    } finally {
      setSubscriptionLoading(false);
    }
  }, [checkSubscription]);

  useEffect(() => {
    if (!supabase) {
      setLoading(false);
      setSubscriptionLoading(false);
      return;
    }
    const client = supabase;

    let active = true;
    let initializationSettled = false;

    const finishSignedOut = () => {
      primeAuthAccessToken(null);
      setRecoverySession(false);
      setSession(null);
      setUser(null);
      setSubscription(null);
      setSubscriptionError(null);
      setSubscriptionLoading(false);
      setLoading(false);
    };

    // A stale refresh token or an orphaned Web Lock must not leave every auth
    // control disabled forever. Late results are ignored; auth state changes
    // still update the provider when a subsequent sign-in succeeds.
    const initializationTimeout = window.setTimeout(() => {
      if (!active || initializationSettled) return;
      initializationSettled = true;
      finishSignedOut();
    }, AUTH_INITIALIZATION_TIMEOUT_MS);

    async function initialize() {
      try {
        const {
          data: { session: initialSession },
          error,
        } = await client.auth.getSession();
        if (error) throw error;
        if (!active || initializationSettled) return;

        initializationSettled = true;
        primeAuthAccessToken(initialSession?.access_token ?? null);
        setSession(initialSession);
        setUser(initialSession?.user ?? null);
        setRecoverySession(Boolean(initialSession && isRecoverySession()));
        setLoading(false);
        if (initialSession?.access_token) {
          void fetchSubscription();
        } else {
          setSubscription(null);
          setSubscriptionError(null);
          setSubscriptionLoading(false);
        }
      } catch {
        if (!active || initializationSettled) return;
        initializationSettled = true;
        finishSignedOut();
      } finally {
        window.clearTimeout(initializationTimeout);
      }
    }

    void initialize();

    // Listen for auth changes
    const {
      data: { subscription: authSub },
    } = client.auth.onAuthStateChange((_event, s) => {
      if (!active) return;
      initializationSettled = true;
      window.clearTimeout(initializationTimeout);
      primeAuthAccessToken(s?.access_token ?? null);
      setSession(s);
      setUser(s?.user ?? null);
      setRecoverySession(Boolean(s && isRecoverySession()));
      setLoading(false);
      if (s?.access_token) {
        void fetchSubscription();
      } else {
        setSubscription(null);
        setSubscriptionError(null);
        setSubscriptionLoading(false);
      }
    });

    return () => {
      active = false;
      window.clearTimeout(initializationTimeout);
      authSub.unsubscribe();
    };
  }, [fetchSubscription]);

  async function signIn(email: string, password: string) {
    if (!supabase) return { error: "Supabase not configured", userNotFound: false };
    const { error } = await supabase.auth.signInWithPassword({ email, password });
    if (!error) return { error: null, userNotFound: false };
    const msg = error.message || "";
    const code = (error as { code?: string }).code || "";
    const userNotFound =
      code === "user_not_found" ||
      /invalid login credentials/i.test(msg) ||
      /invalid credentials/i.test(msg);
    return { error: msg, userNotFound };
  }

  async function signInWithGoogle() {
    if (!supabase) return { error: "Supabase not configured" };
    const { error } = await supabase.auth.signInWithOAuth({
      provider: "google",
      options: { redirectTo: window.location.origin },
    });
    return { error: error?.message ?? null };
  }

  async function signUp(email: string, password: string): Promise<SignUpResult> {
    if (!supabase) return { error: "Supabase not configured", userExists: false };
    const { data, error } = await supabase.auth.signUp({ email, password });
    if (error) {
      const msg = error.message || "";
      const userExists =
        /already registered/i.test(msg) ||
        /already.*exists/i.test(msg) ||
        /user.*exists/i.test(msg);
      return { error: msg, userExists };
    }
    // Supabase returns an empty identities array when the email is already registered
    // (to avoid leaking user existence). Treat this as "user exists".
    const identities = data?.user?.identities ?? [];
    if (data?.user && identities.length === 0) {
      return { error: "ACCOUNT_EXISTS", userExists: true };
    }
    return { error: null, userExists: false };
  }

  async function verifyOtp(email: string, token: string) {
    if (!supabase) return { error: "Supabase not configured" };
    const { error } = await supabase.auth.verifyOtp({ email, token, type: "signup" });
    return { error: error?.message ?? null };
  }

  async function resendOtp(email: string) {
    if (!supabase) return { error: "Supabase not configured" };
    const { error } = await supabase.auth.resend({ type: "signup", email });
    return { error: error?.message ?? null };
  }

  async function handleSignOut() {
    if (!supabase) return;
    const { error } = await supabase.auth.signOut();
    if (error) throw error;
    setRecoverySession(false);
    setSession(null);
    setUser(null);
    primeAuthAccessToken(null);
    setSubscription(null);
    setSubscriptionError(null);
    setSubscriptionLoading(false);
  }

  async function refreshSubscription() {
    if (session?.access_token) {
      await fetchSubscription();
    } else {
      setSubscription(null);
      setSubscriptionError(null);
      setSubscriptionLoading(false);
    }
  }

  return (
    <AuthContext.Provider
      value={{
        recoverySession,
        user,
        session,
        loading,
        subscription,
        subscriptionLoading,
        subscriptionError,
        signIn,
        signInWithGoogle,
        signUp,
        verifyOtp,
        resendOtp,
        signOut: handleSignOut,
        refreshSubscription,
      }}
    >
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth() {
  return useContext(AuthContext);
}
