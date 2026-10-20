export const EVENT_TYPES = {
  order_win: { label: "Order wins", color: "#10b981" },
  m_and_a: { label: "M&A", color: "#818cf8" },
  fundraising: { label: "Fundraising", color: "#fbbf24" },
  partnership_jv: { label: "Partnerships", color: "#38bdf8" },
  capex: { label: "Capex & operations", color: "#fb923c" },
  product_license: { label: "Products & approvals", color: "#e879f9" },
  litigation_arbitration: { label: "Legal disputes", color: "#fb7185" },
  regulatory_action: { label: "Regulatory actions", color: "#f87171" },
  capital_return: { label: "Dividends & buybacks", color: "#2dd4bf" },
  credit_rating: { label: "Credit ratings", color: "#a3e635" },
  business_update: { label: "Business updates", color: "#94a3b8" },
} as const;

export type EventType = keyof typeof EVENT_TYPES;
export type Announcement = {
  id: string;
  symbol: string;
  company_name: string | null;
  event_type: EventType;
  headline: string;
  event_date: string;
  order_value_text: string | null;
  counterparty: string | null;
  why_it_matters: string | null;
  source_url: string | null;
  materiality?: string;
  confidence?: string;
  signal_score?: number;
  metadata: { announcement_summary?: string; subject?: string; review_priority?: import("./priority").ReviewPriority; is_repeat?: boolean; novelty?: string } | null;
};

export function istDate(value: string | Date): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Kolkata", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date(value));
}

export function validDate(value: string): boolean {
  return typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value) && !Number.isNaN(Date.parse(value)) && new Date(value).toISOString().slice(0, 10) === value;
}

export function dateRange(date: string) {
  if (!validDate(date)) throw new Error("Invalid date");
  const start = new Date(`${date}T00:00:00+05:30`);
  return { start: start.toISOString(), end: new Date(start.getTime() + 86_400_000).toISOString() };
}

export function sourceLink(value: string | null): string | null {
  try {
    const url = new URL(value || "");
    return url.protocol === "https:" && (url.hostname === "nseindia.com" || url.hostname.endsWith(".nseindia.com")) ? url.href : null;
  } catch { return null; }
}

export function breakdown(rows: Announcement[]) {
  return Object.entries(EVENT_TYPES).map(([type, event]) => ({ type: type as EventType, ...event, count: rows.filter(row => row.event_type === type).length })).filter(item => item.count > 0);
}
