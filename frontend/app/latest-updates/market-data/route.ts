import { NextRequest, NextResponse } from "next/server";
import { istDate, validDate } from "../model";
import { marketSetup, type Candle } from "../market-setup";

export async function GET(request: NextRequest) {
  const symbol = (request.nextUrl.searchParams.get("symbol") || "").toUpperCase();
  const date = request.nextUrl.searchParams.get("date") || istDate(new Date());
  if (!/^[A-Z0-9][A-Z0-9&_.-]{0,29}$/.test(symbol) || !validDate(date) || date > istDate(new Date())) return NextResponse.json({ error: "Invalid symbol or date" }, { status: 400 });
  const end = Date.parse(`${date}T00:00:00+05:30`) / 1000 + 86400;
  const params = new URLSearchParams({ period1: String(end - 260 * 86400), period2: String(end), interval: "1d" });
  try {
    const response = await fetch(`https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol + ".NS")}?${params}`, { headers: { "User-Agent": "Mozilla/5.0" }, next: { revalidate: 900 }, signal: AbortSignal.timeout(12000), redirect: "error" });
    if (!response.ok) throw new Error("Price provider unavailable");
    const payload = await response.json();
    const result = payload?.chart?.result?.[0];
    const quote = result?.indicators?.quote?.[0];
    if (!result || !quote || result.meta?.currency !== "INR" || result.meta?.exchangeTimezoneName !== "Asia/Kolkata" || !Array.isArray(result.timestamp)) throw new Error("Invalid price response");
    const now = new Date();
    const clock = new Intl.DateTimeFormat("en-GB", { timeZone: "Asia/Kolkata", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(now);
    const today = istDate(now);
    const candles: Candle[] = [];
    const seen = new Set<string>();
    for (let i = 0; i < result.timestamp.length; i++) {
      const stamp = result.timestamp[i];
      if (!Number.isFinite(stamp)) continue;
      const day = istDate(new Date(stamp * 1000));
      if (day > date || (day === today && clock < "15:45") || seen.has(day)) continue;
      const values = [quote.open?.[i], quote.high?.[i], quote.low?.[i], quote.close?.[i]];
      if (!values.every(v => typeof v === "number" && Number.isFinite(v) && v > 0)) continue;
      const [open, high, low, close] = values;
      if (high < Math.max(open, close, low) || low > Math.min(open, close)) continue;
      const volume = quote.volume?.[i];
      candles.push({ date: day, open, high, low, close, volume: typeof volume === "number" && Number.isFinite(volume) && volume >= 0 ? volume : 0 });
      seen.add(day);
    }
    candles.sort((a, b) => a.date.localeCompare(b.date));
    return NextResponse.json({ symbol, candles, setup: marketSetup(candles, date), source: "Yahoo Finance · NSE daily candles", requestedDate: date }, { headers: { "Cache-Control": "public, max-age=60, s-maxage=900" } });
  } catch {
    return NextResponse.json({ error: "Daily price data is unavailable. Try again or open the external chart." }, { status: 503, headers: { "Cache-Control": "no-store" } });
  }
}
