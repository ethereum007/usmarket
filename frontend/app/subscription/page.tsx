"use client";

import Link from "next/link";
import { useState } from "react";
import { useRouter } from "next/navigation";
import { useAuth } from "../contexts/AuthContext";

const API_URL = process.env.NEXT_PUBLIC_API_URL || "";
const RAZORPAY_KEY = process.env.NEXT_PUBLIC_RAZORPAY_KEY_ID || "";

const FREE_FEATURES = [
  "Today market overview",
  "Market heatmap",
  "Sector performance",
  "Stock screener and quote lookup",
  "Product guide",
];

const PREMIUM_FEATURES = [
  "Alpha Radar live signal workspace",
  "Options Flow, OI Clock, Options Apex, and F&O Radar",
  "Swing, VCP, NR Squeeze, Volume Profile, 52W Bounce, and institutional scanners",
  "Trade ideas, trade tracking, alerts, and algo tools",
  "Sector rotation, historical snapshots, and Radar Trade workflows",
  "2-3 weekday-morning live Zoom intraday trading sessions every week",
  "Member-only live trade walkthroughs and session access",
];

const COMPARISON_ROWS = [
  ["Home market overview", true, true],
  ["Heatmap, sectors, and stock lookup", true, true],
  ["Alpha Radar signals and live workflows", false, true],
  ["Options Flow and F&O Radar", false, true],
  ["Advanced trade scanners and trade ideas", false, true],
  ["Rotation, snapshots, alerts, and algo tools", false, true],
  ["Weekday-morning live Zoom intraday sessions", false, true],
] as const;

function loadRazorpayScript(): Promise<boolean> {
  return new Promise((resolve) => {
    if ((window as any).Razorpay) return resolve(true);
    const script = document.createElement("script");
    script.src = "https://checkout.razorpay.com/v1/checkout.js";
    script.onload = () => resolve(true);
    script.onerror = () => resolve(false);
    document.body.appendChild(script);
  });
}

function Check({ active }: { active: boolean }) {
  return (
    <span className={`mt-0.5 text-sm font-bold ${active ? "text-accent" : "text-text-tertiary"}`}>
      {active ? "✓" : "×"}
    </span>
  );
}

export default function SubscriptionPage() {
  const { user, session, subscription, refreshSubscription } = useAuth();
  const router = useRouter();
  const [processing, setProcessing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [couponCode, setCouponCode] = useState("");
  const [couponMessage, setCouponMessage] = useState<{ type: "success" | "error"; text: string } | null>(null);
  const [redeemingCoupon, setRedeemingCoupon] = useState(false);

  const isPaidPremium = subscription?.tier === "premium" && subscription?.status === "active";

  function getAccessToken() {
    const accessToken = session?.access_token;
    if (user && accessToken) return accessToken;
    router.push("/login");
    return null;
  }

  const handleSubscribe = async () => {
    const accessToken = getAccessToken();
    const currentUser = user;
    if (!accessToken || !currentUser) return;

    setError(null);
    setProcessing(true);
    try {
      const loaded = await loadRazorpayScript();
      if (!loaded) throw new Error("Failed to load the payment gateway. Please try again.");

      const res = await fetch(`${API_URL}/api/subscription/create`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${accessToken}`,
        },
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.detail || data.error || "Failed to create the payment order");

      const key = data.razorpayKeyId || RAZORPAY_KEY;
      if (!key) throw new Error("Payment system is not configured. Please contact support.");

      const options = {
        key,
        order_id: data.orderId,
        amount: data.amount,
        currency: data.currency,
        name: "Alpha Radar",
        description: "Premium membership - 30-day access",
        handler: async (response: any) => {
          const verifyRes = await fetch(`${API_URL}/api/subscription/verify`, {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              Authorization: `Bearer ${accessToken}`,
            },
            body: JSON.stringify({
              razorpay_order_id: response.razorpay_order_id,
              razorpay_payment_id: response.razorpay_payment_id,
              razorpay_signature: response.razorpay_signature,
            }),
          });

          if (!verifyRes.ok) {
            setError("Payment verification failed. Contact support if you were charged.");
            setProcessing(false);
            return;
          }

          await refreshSubscription();
          router.push("/pulse");
          setProcessing(false);
        },
        prefill: {
          email: currentUser.email,
          name: currentUser.user_metadata?.full_name || "",
        },
        theme: { color: "#059669" },
        modal: {
          ondismiss: () => setProcessing(false),
        },
      };

      const razorpay = new (window as any).Razorpay(options);
      razorpay.on("payment.failed", (result: any) => {
        setError(result.error?.description || "Payment failed. Please try again.");
        setProcessing(false);
      });
      razorpay.open();
    } catch (err: any) {
      setError(err.message || "Unable to start payment. Please try again.");
      setProcessing(false);
    }
  };

  const handleRedeemCoupon = async () => {
    const accessToken = getAccessToken();
    if (!couponCode.trim() || !accessToken) return;

    setRedeemingCoupon(true);
    setCouponMessage(null);
    try {
      const res = await fetch(`${API_URL}/api/coupons/redeem`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${accessToken}`,
        },
        body: JSON.stringify({ code: couponCode.trim() }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.detail || data.error || "Failed to redeem coupon");

      setCouponMessage({ type: "success", text: `Premium activated for ${data.duration_days} days.` });
      setCouponCode("");
      await refreshSubscription();
      window.setTimeout(() => router.push("/pulse"), 1500);
    } catch (err: any) {
      setCouponMessage({ type: "error", text: err.message || "Unable to redeem coupon." });
    } finally {
      setRedeemingCoupon(false);
    }
  };

  return (
    <div className="text-foreground">
      <section className="mx-auto max-w-3xl px-6 pb-8 pt-3 text-center">
        <div className="mb-4 inline-flex items-center rounded-full border border-accent/25 bg-accent/10 px-3 py-1 text-[11px] font-extrabold tracking-[0.15em] text-accent">
          ALPHA RADAR PREMIUM
        </div>
        <h1 className="text-3xl font-semibold tracking-tight text-text-heading">
          Choose your workspace
        </h1>
        <p className="mx-auto mt-4 max-w-2xl text-[15px] leading-7 text-text-secondary">
          Get premium scanners, live market workflows, and live Zoom intraday sessions with the Alpha Radar desk.
        </p>
      </section>

      {isPaidPremium ? (
        <section className="mx-auto max-w-xl px-6 pb-16">
          <div className="rounded-2xl border border-card-border bg-accent/10 p-9 text-center">
            <div className="mx-auto mb-4 inline-flex rounded-full bg-accent px-3 py-1 text-[11px] font-extrabold tracking-[0.12em] text-white">
              PREMIUM ACTIVE
            </div>
            <h2 className="text-2xl font-extrabold text-text-heading">Your full desk is unlocked</h2>
            <p className="mt-3 text-sm leading-6 text-text-secondary">
              Every premium workflow and the live weekday-morning Zoom sessions are available to you.
              {subscription?.expires_at && (
                <span>
                  {" "}Current access ends on {new Date(subscription.expires_at).toLocaleDateString("en-IN", {
                    day: "numeric",
                    month: "long",
                    year: "numeric",
                  })}.
                </span>
              )}
            </p>
            <button
              onClick={() => router.push("/pulse")}
              className="mt-6 rounded-lg bg-accent px-7 py-3 text-sm font-bold text-white transition-colors hover:bg-accent/80"
            >
              Open Alpha Radar
            </button>
          </div>
        </section>
      ) : (
        <>
          <section className="mx-auto grid max-w-5xl gap-5 px-6 pb-10 lg:grid-cols-[0.86fr_1.14fr]">
            <article className="flex flex-col rounded-2xl border border-card-border bg-surface-subtle p-7">
              <div className="text-sm font-bold text-text-secondary">Free</div>
              <div className="mt-3 flex items-end gap-1">
                <span className="text-4xl font-extrabold leading-none text-text-heading">₹0</span>
              </div>
              <p className="mt-3 text-sm leading-6 text-text-secondary">A clean, always-free view of the market basics.</p>
              <ul className="mt-7 flex flex-1 flex-col gap-3">
                {FREE_FEATURES.map((feature) => (
                  <li key={feature} className="flex items-start gap-2 text-sm text-foreground">
                    <Check active />
                    <span>{feature}</span>
                  </li>
                ))}
              </ul>
              <Link
                href="/"
                className="mt-8 inline-flex items-center justify-center rounded-lg border border-card-border px-5 py-3 text-sm font-bold text-text-heading transition-colors hover:bg-surface-hover"
              >
                Explore basic data
              </Link>
            </article>

            <article className="relative flex flex-col overflow-hidden rounded-2xl border border-card-border bg-card p-7 shadow-sm">
              <div className="absolute right-0 top-0 rounded-bl-xl border-b border-l border-card-border bg-accent/10 px-3 py-1.5 text-[10px] font-extrabold tracking-[0.12em] text-accent">
                COMPLETE MEMBERSHIP
              </div>
              <div className="text-sm font-bold text-accent">Premium</div>
              <div className="mt-3 flex items-end gap-1">
                <span className="text-4xl font-extrabold leading-none text-text-heading">₹999</span>
                <span className="text-sm font-semibold text-text-tertiary">/month</span>
              </div>
              <p className="mt-2 text-sm leading-6 text-text-secondary">30 days of full access. Renew your membership each month.</p>
              <ul className="mt-7 flex flex-1 flex-col gap-3">
                {PREMIUM_FEATURES.map((feature) => (
                  <li key={feature} className="flex items-start gap-2 text-sm text-foreground">
                    <Check active />
                    <span>{feature}</span>
                  </li>
                ))}
              </ul>
              {error && <div className="mt-6 rounded-lg border border-loss/25 bg-loss-bg px-3 py-2 text-center text-xs text-loss">{error}</div>}
              <button
                onClick={handleSubscribe}
                disabled={processing}
                className="mt-6 w-full rounded-lg bg-accent px-5 py-3.5 text-sm font-extrabold text-white transition-colors hover:bg-accent/80 disabled:cursor-not-allowed disabled:opacity-70"
              >
                {processing ? "Opening payment..." : "Start Premium for ₹999/month"}
              </button>
              <p className="mt-3 text-center text-[11px] leading-5 text-text-tertiary">
                UPI, cards, and net banking accepted. Access activates after payment verification.
              </p>
            </article>
          </section>

          <section className="mx-auto max-w-5xl px-6 pb-12">
            <div className="rounded-2xl border border-card-border bg-warning/5 p-6 sm:p-7">
              <div className="text-sm font-extrabold text-text-heading">Live intraday desk sessions are included</div>
              <p className="mt-2 max-w-3xl text-sm leading-6 text-text-secondary">
                Premium members get 2-3 live Zoom sessions each week on weekday mornings for intraday market preparation and live trade walkthroughs. The session schedule and Zoom access are shared with active members.
              </p>
              <p className="mt-3 text-xs leading-5 text-text-tertiary">
                Sessions are educational market walkthroughs, not investment advice. Members make their own trading decisions.
              </p>
            </div>
          </section>

          <section className="mx-auto max-w-4xl px-6 pb-14">
            <h2 className="text-center text-2xl font-extrabold tracking-tight text-text-heading">What stays free and what becomes Premium</h2>
            <div className="mt-6 overflow-hidden rounded-2xl border border-card-border bg-surface-subtle">
              <div className="grid grid-cols-[1.8fr_0.6fr_0.8fr] border-b border-card-border bg-card px-5 py-3 text-[11px] font-extrabold uppercase tracking-[0.1em] text-text-tertiary">
                <span>Feature</span>
                <span className="text-center">Free</span>
                <span className="text-center text-accent">Premium</span>
              </div>
              {COMPARISON_ROWS.map(([feature, free, premium], index) => (
                <div
                  key={feature}
                  className={`grid grid-cols-[1.8fr_0.6fr_0.8fr] items-center border-b border-card-border px-5 py-3 text-sm last:border-b-0 ${index % 2 === 0 ? "bg-stripe-bg" : ""}`}
                >
                  <span className="font-medium text-foreground">{feature}</span>
                  <span className="text-center"><Check active={free} /></span>
                  <span className="text-center"><Check active={premium} /></span>
                </div>
              ))}
            </div>
          </section>

          <section className="mx-auto max-w-xl px-6 pb-10">
            <div className="rounded-xl border border-card-border bg-surface-subtle p-6 text-center">
              <div className="text-sm font-bold text-text-heading">Have a member coupon?</div>
              <p className="mt-1 text-xs text-text-secondary">Redeem it after you sign in to activate the included access.</p>
              {couponMessage && (
                <div className={`mt-4 rounded-lg border px-3 py-2 text-xs ${couponMessage.type === "success" ? "border-accent/25 bg-accent/10 text-accent" : "border-loss/25 bg-loss-bg text-loss"}`}>
                  {couponMessage.text}
                </div>
              )}
              <div className="mt-4 flex gap-2">
                <input
                  type="text"
                  value={couponCode}
                  onChange={(event) => setCouponCode(event.target.value.toUpperCase())}
                  onKeyDown={(event) => event.key === "Enter" && void handleRedeemCoupon()}
                  placeholder="AR-XXXX-XXXX"
                  maxLength={12}
                  className="min-w-0 flex-1 rounded-lg border border-input-border bg-input-bg px-3 py-2.5 text-center font-mono text-sm font-semibold tracking-wider text-text-heading outline-none focus:border-accent/50"
                />
                <button
                  onClick={() => void handleRedeemCoupon()}
                  disabled={redeemingCoupon || !couponCode.trim()}
                  className="rounded-lg bg-accent px-5 py-2.5 text-sm font-bold text-white transition-colors hover:bg-accent/80 disabled:cursor-not-allowed disabled:opacity-50"
                >
                  {redeemingCoupon ? "Applying..." : "Apply"}
                </button>
              </div>
            </div>
          </section>
        </>
      )}

      <footer className="border-t border-divider py-7 text-center text-xs text-text-tertiary">
        Alpha Radar Premium membership
      </footer>
    </div>
  );
}
