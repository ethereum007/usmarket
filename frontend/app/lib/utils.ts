import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

export function formatNumber(n: number | undefined | null, decimals = 2): string {
  if (n == null || typeof n !== "number" || isNaN(n)) return "0";
  return n.toLocaleString("en-IN", {
    minimumFractionDigits: decimals,
    maximumFractionDigits: decimals,
  });
}

export function formatChange(change: number, percent: number): string {
  const sign = change >= 0 ? "+" : "";
  return `${sign}${formatNumber(change)} (${sign}${formatNumber(percent)}%)`;
}

export function profitLossColor(value: number | undefined | null): string {
  if (value == null) return "text-muted";
  if (value > 0) return "text-profit";
  if (value < 0) return "text-loss";
  return "text-muted";
}

export function profitLossBg(value: number): string {
  if (value > 0) return "bg-profit-bg";
  if (value < 0) return "bg-loss-bg";
  return "bg-transparent";
}

/**
 * Check if NSE market is currently open (9:15 AM - 3:30 PM IST, weekdays).
 * Uses IST timezone explicitly so it works regardless of the user's local timezone.
 */
export function isMarketOpen(): boolean {
  const now = new Date();
  // Convert to IST (UTC+5:30)
  const istOffset = 5.5 * 60; // minutes
  const utcMinutes = now.getUTCHours() * 60 + now.getUTCMinutes();
  const istMinutes = utcMinutes + istOffset;
  // IST day of week (handle day rollover)
  const utcDay = now.getUTCDay(); // 0=Sun, 6=Sat
  const istDay = istMinutes >= 1440 ? (utcDay + 1) % 7 : istMinutes < 0 ? (utcDay + 6) % 7 : utcDay;
  const normalizedMinutes = ((istMinutes % 1440) + 1440) % 1440;

  // Weekend check: 0=Sun, 6=Sat
  if (istDay === 0 || istDay === 6) return false;

  // 9:15 AM = 555 min, 3:30 PM = 930 min
  return normalizedMinutes >= 555 && normalizedMinutes <= 930;
}
