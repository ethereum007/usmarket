import publicFeed from "./public-feed.json";
import { Announcement, EVENT_TYPES, dateRange, istDate, validDate } from "./model";

// This is the existing NSE publisher's public, RLS-controlled read credential.
// Never use the Alpha Radar auth database or a service-role key for this feed.
const origin = process.env.NSE_FEED_SUPABASE_URL || publicFeed.url;
const publishableKey = process.env.NSE_FEED_PUBLISHABLE_KEY || publicFeed.publishableKey;
const LIMIT = 1000;

async function read(params: URLSearchParams): Promise<Announcement[]> {
  const response = await fetch(`${origin}/rest/v1/announcement_signals?${params}`, {
    headers: { apikey: publishableKey },
    next: { revalidate: 60 },
    signal: AbortSignal.timeout(12000),
    redirect: "error",
  });
  if (!response.ok) throw new Error(`NSE feed returned ${response.status}`);
  const rows: unknown = await response.json();
  if (!Array.isArray(rows)) throw new Error("Invalid NSE feed response");
  return rows.filter((row): row is Announcement => row && typeof row.id === "string" && typeof row.symbol === "string" && typeof row.headline === "string" && typeof row.event_date === "string" && Number.isFinite(Date.parse(row.event_date)) && Object.hasOwn(EVENT_TYPES, row.event_type));
}

export async function getFeed(requestedDate?: string) {
  const today = istDate(new Date());
  const chosen = requestedDate && validDate(requestedDate) && requestedDate <= today ? requestedDate : null;
  const select = "id,symbol,company_name,event_type,headline,event_date,order_value_text,counterparty,why_it_matters,source_url,metadata,materiality,confidence,signal_score";
  const base = { select, event_type: `in.(${Object.keys(EVENT_TYPES).join(",")})`, order: "event_date.desc,id.asc" };
  try {
    const latest = await read(new URLSearchParams({ ...base, event_date: "not.is.null", limit: "1" }));
    const latestAt = latest[0]?.event_date || null;
    const date = chosen || (latestAt ? istDate(latestAt) : today);
    const { start, end } = dateRange(date);
    const params = new URLSearchParams({ ...base, and: `(event_date.gte.${start},event_date.lt.${end})`, limit: String(LIMIT) });
    const rows = await read(params);
    return { rows, date, today, latestAt, limited: rows.length === LIMIT, error: false };
  } catch {
    return { rows: [], date: chosen || today, today, latestAt: null, limited: false, error: true };
  }
}
