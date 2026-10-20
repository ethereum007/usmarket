"use client";
import { useEffect, useState } from "react";
import { fetchAPI } from "../lib/api";
import { usd, metric } from "../lib/us-research";
type Quote = {
  symbol: string;
  bid: number | null;
  ask: number | null;
  quote_timestamp: string | null;
  quote_status: string;
  spread_bps: number | null;
  wide_spread: boolean;
  last_trade: number | null;
  trade_timestamp: string | null;
  trade_status: string;
};
type Live = {
  state: string;
  feed: string;
  coverage: string;
  received_at: string;
  market: {
    timestamp: string | null;
    is_open: boolean | null;
    next_open: string | null;
  };
  errors: Record<string, string>;
  rows: Quote[];
  transport: string;
  error?: string;
};
function age(timestamp: string | null, now: number) {
  const value = timestamp ? (now - Date.parse(timestamp)) / 1000 : NaN;
  return Number.isFinite(value) && value >= -5 ? Math.max(0, value) : null;
}
function ageText(value: number | null) {
  return value == null
    ? "Unknown"
    : value < 60
      ? `${Math.floor(value)}s old`
      : value < 3600
        ? `${Math.floor(value / 60)}m old`
        : `${metric(value / 3600, 1)}h old`;
}
export default function LiveFeed({
  symbol,
  benchmark,
}: {
  symbol: string;
  benchmark: string;
}) {
  const [feed, setFeed] = useState("iex");
  const [live, setLive] = useState<Live | null>(null);
  const [error, setError] = useState("");
  const [now, setNow] = useState(Date.now());
  const symbols = [...new Set([symbol || "AAPL", benchmark || "SPY"])]
    .sort()
    .join(",");
  useEffect(() => {
    let active = true;
    let timer: ReturnType<typeof setTimeout>;
    setLive(null);
    setError("");
    async function poll() {
      if (!document.hidden) {
        try {
          const result = await fetchAPI<{ live: Live }>(
            `/api/us/research/live?symbols=${encodeURIComponent(symbols)}&feed=${feed}`,
          );
          if (active) {
            setLive(result.live);
            setError("");
          }
        } catch (e) {
          if (active) {
            setLive(null);
            setError(e instanceof Error ? e.message : "Live feed unavailable");
          }
        }
      }
      if (active) timer = setTimeout(poll, 5000);
    }
    void poll();
    return () => {
      active = false;
      clearTimeout(timer);
    };
  }, [symbols, feed]);
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);
  const clockAge = age(live?.market?.timestamp || null, now);
  const clockKnown =
    clockAge != null &&
    clockAge <= 60 &&
    typeof live?.market?.is_open === "boolean";
  const session = clockKnown
    ? live?.market.is_open
      ? "Regular session open"
      : "Regular session closed"
    : "Session status unknown";
  return (
    <section
      id="live-data"
      className="us-panel us-live"
      aria-label="Live market data diagnostics"
    >
      <div className="us-panel-title">
        <div>
          <span className="us-eyebrow">
            LIVE DATA / INDEPENDENT OF SAVED RESEARCH
          </span>
          <h2>Test the tape.</h2>
        </div>
        <label>
          Feed{" "}
          <select
            aria-label="Live data feed"
            value={feed}
            onChange={(e) => setFeed(e.target.value)}
          >
            <option value="iex">IEX · single exchange</option>
            <option value="sip">SIP · consolidated</option>
          </select>
        </label>
      </div>
      <p>
        {session}
        {clockKnown && !live?.market.is_open && live?.market.next_open
          ? ` · Next open ${new Date(live.market.next_open).toLocaleString("en-US", { timeZone: "America/New_York", hour: "numeric", minute: "2-digit", day: "numeric", month: "short" })} ET`
          : ""}
        . Quotes and trades below use their own exchange timestamps.
      </p>
      {error && (
        <p role="alert" className="us-negative">
          {error}
        </p>
      )}
      {!live && !error && (
        <p role="status">Checking provider access and current quotes…</p>
      )}
      {live?.state === "denied" && (
        <p role="alert" className="us-negative">
          Your current Alpaca subscription does not permit this real-time feed.
          Historical SIP access does not include live SIP. Select IEX to test
          the available feed.
        </p>
      )}
      {live?.error && (
        <p role="alert" className="us-negative">
          {live.error}
        </p>
      )}
      {live && live.state !== "denied" && (
        <div className="us-live-grid">
          {live.rows?.map((row) => {
            const quoteAge = age(row.quote_timestamp, now);
            const tradeAge = age(row.trade_timestamp, now);
            const fresh =
              row.quote_status === "fresh" &&
              quoteAge != null &&
              quoteAge <= 30;
            const tradeFresh =
              row.trade_status === "fresh" &&
              tradeAge != null &&
              tradeAge <= 30;
            return (
              <article key={row.symbol} className="us-live-stock">
                <div className="us-panel-title">
                  <strong>{row.symbol}</strong>
                  <span className={fresh ? "us-positive" : "us-negative"}>
                    {fresh
                      ? "Fresh quote"
                      : row.quote_status === "invalid"
                        ? "Quote unavailable"
                        : "Stale quote"}
                  </span>
                </div>
                <div className="us-live-prices">
                  <div>
                    <span>Bid</span>
                    <strong>{usd(row.bid)}</strong>
                  </div>
                  <div>
                    <span>Ask</span>
                    <strong>{usd(row.ask)}</strong>
                  </div>
                  <div>
                    <span>Spread</span>
                    <strong>{metric(row.spread_bps, 1)} bps</strong>
                  </div>
                </div>
                <p>
                  {ageText(quoteAge)} ·{" "}
                  {row.quote_timestamp
                    ? new Date(row.quote_timestamp).toLocaleString("en-US", {
                        timeZone: "America/New_York",
                        month: "short",
                        day: "numeric",
                        hour: "numeric",
                        minute: "2-digit",
                        second: "2-digit",
                      })
                    : "No timestamp"}{" "}
                  ET
                </p>
                <p>
                  Last trade {usd(row.last_trade)} · {ageText(tradeAge)} ·{" "}
                  {tradeFresh ? "fresh" : "not fresh"}
                </p>
                {row.wide_spread && (
                  <p className="us-negative">
                    Wide spread: over 100 bps. This is not an execution-ready
                    quote.
                  </p>
                )}
              </article>
            );
          })}
        </div>
      )}
      <p className="us-live-footnote">
        {live?.coverage || "Provider: Alpaca"} · REST polling every 5s, not
        streaming. Fresh means timestamp age ≤30s with valid bid/ask. IEX is one
        exchange, not the consolidated best quote. These observations do not
        change research bars or establish execution readiness.
      </p>
      {live &&
        Object.keys(live.errors || {}).length > 0 &&
        live.state !== "denied" && (
          <p role="alert" className="us-negative">
            {Object.entries(live.errors)
              .map(([key, value]) => `${key}: ${value}`)
              .join(" · ")}
          </p>
        )}
    </section>
  );
}
