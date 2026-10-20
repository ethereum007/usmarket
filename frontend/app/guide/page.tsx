"use client";

import { PageHeader } from "../components/layout/PageHeader";

import Link from "next/link";
import { useEffect, useMemo, useRef, useState } from "react";

const TOC = [
  { id: "markets", label: "1. Markets (Dashboard)", children: [
    { id: "markets-overview", label: "1.1 Overview" },
    { id: "markets-sectors", label: "1.2 Sectors" },
  ]},
  { id: "signals", label: "2. Signals (Trade Ideas)", children: [
    { id: "oi-signals", label: "2.1 OI Signals" },
    { id: "cpr-scanner", label: "2.2 CPR Scanner" },
    { id: "pattern-scanner", label: "2.3 Pattern Scanner" },
    { id: "vcp", label: "2.4 VCP" },
    { id: "nr-squeeze", label: "2.5 NR Squeeze" },
    { id: "volume-profile", label: "2.6 Volume Profile" },
    { id: "52w-bounce", label: "2.7 52W Bounce" },
    { id: "swing-spectrum", label: "2.8 Swing Spectrum" },
  ]},
  { id: "options", label: "3. Options", children: [
    { id: "options-chain", label: "3.1 Options Chain" },
    { id: "options-apex", label: "3.2 Options Apex" },
    { id: "fo-stocks", label: "3.3 F&O Stocks" },
  ]},
  { id: "radar", label: "4. Radar (Market Pulse)", children: [
    { id: "market-pulse", label: "4.1 Market Pulse" },
    { id: "live-signals", label: "4.2 Live Signals" },
    { id: "market-breadth", label: "4.3 Market Breadth" },
  ]},
  { id: "screener", label: "5. Screener (Stocks)", children: [
    { id: "stock-tables", label: "5.1 Stock Tables" },
    { id: "charts", label: "5.2 Charts" },
    { id: "all-stocks-search", label: "5.3 All Stocks Search" },
  ]},
  { id: "other-features", label: "6. Other Features", children: [
    { id: "scrolling-ticker", label: "6.1 Market tape" },
    { id: "dark-light-mode", label: "6.2 Dark/Light Mode" },
    { id: "market-status", label: "6.3 Market Status" },
  ]},
  { id: "tips", label: "Tips for Best Results", children: [] },
];

// Map section IDs to their searchable text content
const SECTION_CONTENT: Record<string, string> = {
  "markets": "Markets Dashboard home screen snapshot market overview cards NIFTY 50 SENSEX BANK NIFTY VIX MIDCAP SMALLCAP Hot Cold Index best worst performing sector Nifty 50 Heatmap visual map stocks green red Quick Access shortcuts",
  "markets-overview": "Overview home screen snapshot market overview cards NIFTY 50 SENSEX BANK NIFTY VIX MIDCAP SMALLCAP current price change today return last month Hot Cold Index best worst performing sector Nifty 50 Heatmap visual map stocks green red Quick Access shortcuts",
  "markets-sectors": "Sectors NSE sector indices IT Bank Auto Pharma Metal performance leading falling behind",
  "signals": "Signals Trade Ideas OI CPR Pattern Scanner VCP NR Squeeze Volume Profile 52W Bounce Swing Spectrum",
  "oi-signals": "OI Signals algorithm-based trading signals Options Chain analysis Open Interest Put Call Ratio PCR Max Pain IV Skew score bearish bullish Options recommendation Cash recommendation Confidence STRONG MODERATE WEAK market hours",
  "cpr-scanner": "CPR Scanner Camarilla Pivot Range price support resistance levels Multi timeframe Monthly Weekly Daily A+ alert tiers universe N50 N100 N200 Scan",
  "pattern-scanner": "Pattern Scanner chart patterns Head Shoulders Triangles Wedges Flags Double Top Bottom Cup Handle confidence breakout breakdown",
  "vcp": "VCP Volume Contraction Pattern Mark Minervini SEPA methodology price contractions tighter volume declining selling pressure breakout VCP score stage Setting Up Near Pivot relative strength",
  "nr-squeeze": "NR Squeeze big move squeeze setups NR4 NR7 narrowest trading range Inside Bar Bollinger Band Squeeze low volatility compressing breakout",
  "volume-profile": "Volume Profile trading price levels Point of Control POC fair value Value Area High Low 70% support resistance zone",
  "52w-bounce": "52W Bounce 52 week low recovery volume surge buying score reversal candidates turning around",
  "swing-spectrum": "Swing Spectrum swing trading strategies 10 Day Breakout 50 Day Breakout Reversal Radar Channel Breakout signal strength entry price stop loss target",
  "options": "Options Chain Apex F&O Stocks indices NIFTY BANKNIFTY FINNIFTY MIDCPNIFTY SENSEX strike prices OI IV PCR Max Pain",
  "options-chain": "Options Chain live NIFTY BANKNIFTY FINNIFTY MIDCPNIFTY SENSEX strike prices Call Put OI Change Volume LTP Last Traded Price IV Implied Volatility PCR Put Call Ratio Max Pain ATM IV resistance support In The Money ITM OI Clock circular chart",
  "options-apex": "Options Apex advanced analytics visual gauges PCR Gauge market sentiment bullish bearish Money Flux real time money flow Nifty 50 5 minute intraday candlestick chart OI overlay",
  "fo-stocks": "F&O Stocks options chain analytics individual eligible stocks RELIANCE TCS INFY stock options",
  "radar": "Radar Market Pulse Live Signals Market Breadth real time scanner unusual activity breakout",
  "market-pulse": "Market Pulse real time scanner unusual activity Breakout Beacon strong volume signal strength Intraday Boost R Factor price range Bull Bear search intraday trading opportunities",
  "live-signals": "Live Signals crossing key levels real time PDH Crossed yesterday high bullish Combo Surge volume average buy signal PDL Crossed yesterday low bearish Combo Sell high conviction sell signal",
  "market-breadth": "Market Breadth big picture market health Advances Declines A/D Ratio stocks rising falling Sentiment BULLISH BEARISH NEUTRAL breadth",
  "screener": "Screener Stocks Stock Tables Charts All Stocks Search Nifty universe",
  "stock-tables": "Stock Tables Nifty 50 100 200 500 Small Cap 250 Symbol Sector LTP Change Open High Low Volume sort column filter search chart CPR levels",
  "charts": "Charts interactive candlestick charts volume bars CPR levels Pivot TC BC R1 S1 Timeframes 15 minutes 1 hour 1 day 1 week Periods 1 month 3 months 6 months 1 year info card sector index peers",
  "all-stocks-search": "All Stocks Search NSE listed 2700 stocks symbol company name suggestions indices Nifty 50 F&O chart",
  "other-features": "Other Features Scrolling Ticker Dark Light Mode Market Status",
  "scrolling-ticker": "Scrolling Ticker bar top screen live stock prices scrolling green background up red down hover pause",
  "dark-light-mode": "Dark Light Mode sun moon icon navigation bar switch dark mode light mode preference saved remembered",
  "market-status": "Market Status trading hours 9:15 AM 3:30 PM IST Monday Friday green Market Open red Market Closed last trading session",
  "tips": "Tips Best Results OI Signals market hours CPR Scanner end of day Market Pulse breakout opportunities All Stocks search symbol company name",
};

export default function GuidePage() {
  const [activeId, setActiveId] = useState("");
  const [searchQuery, setSearchQuery] = useState("");
  const [showSearchResults, setShowSearchResults] = useState(false);
  const searchRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (entry.isIntersecting) {
            setActiveId(entry.target.id);
          }
        }
      },
      { rootMargin: "-80px 0px -60% 0px", threshold: 0.1 }
    );

    const headings = document.querySelectorAll("[data-guide-section]");
    headings.forEach((el) => observer.observe(el));
    return () => observer.disconnect();
  }, []);

  // Close search dropdown when clicking outside
  useEffect(() => {
    function handleClickOutside(e: MouseEvent) {
      if (searchRef.current && !searchRef.current.contains(e.target as Node)) {
        setShowSearchResults(false);
      }
    }
    document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, []);

  // Build flat list of all sections for search
  const allSections = useMemo(() => {
    const sections: { id: string; label: string }[] = [];
    for (const section of TOC) {
      sections.push({ id: section.id, label: section.label });
      for (const child of section.children) {
        sections.push({ id: child.id, label: child.label });
      }
    }
    return sections;
  }, []);

  // Filter sections by search query
  const searchResults = useMemo(() => {
    if (!searchQuery.trim()) return [];
    const q = searchQuery.toLowerCase();
    return allSections.filter((section) => {
      const labelMatch = section.label.toLowerCase().includes(q);
      const contentMatch = (SECTION_CONTENT[section.id] || "").toLowerCase().includes(q);
      return labelMatch || contentMatch;
    });
  }, [searchQuery, allSections]);

  function handleSearchResultClick(id: string) {
    setShowSearchResults(false);
    setSearchQuery("");
    const el = document.getElementById(id);
    if (el) {
      el.scrollIntoView({ behavior: "smooth", block: "start" });
    }
  }

  return (
    <div id="top" className="min-h-screen bg-background text-foreground">
      <div className="max-w-[1000px] mx-auto">
        <PageHeader eyebrow="Learn the workspace" title="Trading guide" description="Explore every tool, understand the signals, and build a repeatable routine." />
        <div className="mb-6 grid gap-3 sm:grid-cols-3">{[{title:"1. Read the market",href:"/",text:"Start with market breadth and sector strength."},{title:"2. Find a setup",href:"/trade-ideas?tab=swing",text:"Choose a scanner and narrow your universe."},{title:"3. Review the evidence",href:"/trade-ideas?tab=performance",text:"Inspect trade plans, risk and past outcomes."}].map(item => <Link key={item.href} href={item.href} className="rounded-xl border border-card-border bg-card p-5 hover:bg-hover-bg"><h2 className="text-sm font-semibold text-text-heading">{item.title}</h2><p className="mt-2 text-xs leading-relaxed text-muted">{item.text}</p></Link>)}</div>

        {/* Search */}
        <div ref={searchRef} className="relative mb-10">
          <div className="relative">
            <svg
              className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted"
              fill="none"
              viewBox="0 0 24 24"
              stroke="currentColor"
              strokeWidth={2}
            >
              <path strokeLinecap="round" strokeLinejoin="round" d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" />
            </svg>
            <input
              type="text"
              aria-label="Search the guide"
              placeholder="Search the guide..."
              value={searchQuery}
              onChange={(e) => {
                setSearchQuery(e.target.value);
                setShowSearchResults(true);
              }}
              onFocus={() => {
                if (searchQuery.trim()) setShowSearchResults(true);
              }}
              className="w-full pl-10 pr-4 py-2.5 rounded-lg border border-divider bg-surface text-foreground text-sm placeholder:text-muted focus:outline-none focus:ring-2 focus:ring-accent/40 focus:border-accent transition-colors"
            />
            {searchQuery && (
              <button
                onClick={() => {
                  setSearchQuery("");
                  setShowSearchResults(false);
                }}
                className="absolute right-3 top-1/2 -translate-y-1/2 text-muted hover:text-foreground transition-colors"
              >
                <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
                </svg>
              </button>
            )}
          </div>

          {/* Search results dropdown */}
          {showSearchResults && searchQuery.trim() && (
            <div className="absolute z-50 top-full left-0 right-0 mt-1 rounded-lg border border-divider bg-surface shadow-lg max-h-72 overflow-y-auto">
              {searchResults.length > 0 ? (
                <ul className="py-1">
                  {searchResults.map((result) => (
                    <li key={result.id}>
                      <button
                        onClick={() => handleSearchResultClick(result.id)}
                        className="w-full text-left px-4 py-2.5 text-sm text-foreground hover:bg-accent/10 hover:text-accent transition-colors"
                      >
                        {result.label}
                      </button>
                    </li>
                  ))}
                </ul>
              ) : (
                <div className="px-4 py-3 text-sm text-muted">
                  No matching sections found.
                </div>
              )}
            </div>
          )}
        </div>

        {/* Table of Contents */}
        <nav className="mb-14 p-5 sm:p-6 rounded-xl border border-divider bg-surface">
          <h2 className="text-sm font-semibold uppercase tracking-wider text-muted mb-4">Table of Contents</h2>
          <div className="grid grid-cols-1 md:grid-cols-3 gap-x-6 gap-y-4">
            {/* Column 1: Markets + Signals */}
            <div className="space-y-3">
              {TOC.slice(0, 2).map((section) => (
                <div key={section.id}>
                  <a href={`#${section.id}`} className={`text-sm font-semibold transition-colors ${activeId === section.id ? "text-accent" : "text-foreground hover:text-accent"}`}>
                    {section.label}
                  </a>
                  {section.children.length > 0 && (
                    <ul className="ml-4 mt-1 space-y-0.5">
                      {section.children.map((child) => (
                        <li key={child.id}>
                          <a href={`#${child.id}`} className={`text-xs transition-colors ${activeId === child.id ? "text-accent" : "text-text-secondary hover:text-accent"}`}>{child.label}</a>
                        </li>
                      ))}
                    </ul>
                  )}
                </div>
              ))}
            </div>
            {/* Column 2: Options + Radar */}
            <div className="space-y-3">
              {TOC.slice(2, 4).map((section) => (
                <div key={section.id}>
                  <a href={`#${section.id}`} className={`text-sm font-semibold transition-colors ${activeId === section.id ? "text-accent" : "text-foreground hover:text-accent"}`}>
                    {section.label}
                  </a>
                  {section.children.length > 0 && (
                    <ul className="ml-4 mt-1 space-y-0.5">
                      {section.children.map((child) => (
                        <li key={child.id}>
                          <a href={`#${child.id}`} className={`text-xs transition-colors ${activeId === child.id ? "text-accent" : "text-text-secondary hover:text-accent"}`}>{child.label}</a>
                        </li>
                      ))}
                    </ul>
                  )}
                </div>
              ))}
            </div>
            {/* Column 3: Screener + Other + Tips */}
            <div className="space-y-3">
              {TOC.slice(4).map((section) => (
                <div key={section.id}>
                  <a href={`#${section.id}`} className={`text-sm font-semibold transition-colors ${activeId === section.id ? "text-accent" : "text-foreground hover:text-accent"}`}>
                    {section.label}
                  </a>
                  {section.children.length > 0 && (
                    <ul className="ml-4 mt-1 space-y-0.5">
                      {section.children.map((child) => (
                        <li key={child.id}>
                          <a href={`#${child.id}`} className={`text-xs transition-colors ${activeId === child.id ? "text-accent" : "text-text-secondary hover:text-accent"}`}>{child.label}</a>
                        </li>
                      ))}
                    </ul>
                  )}
                </div>
              ))}
            </div>
          </div>
        </nav>

        {/* --- SECTION 1: Markets --- */}
        <Section id="markets" number="1" title="Markets (Dashboard)">

          <SubSection id="markets-overview" number="1.1" title="Overview">
            <p>
              This is your home screen. It gives you a quick snapshot of where the market stands right now.
            </p>
            <BulletList items={[
              <><b>Market Overview cards</b> — You will see cards for <b>NIFTY 50</b>, <b>SENSEX</b>, <b>BANK NIFTY</b>, <b>VIX</b>, <b>MIDCAP</b>, and <b>SMALLCAP</b>. Each card shows the current price, how much it changed today (1D), and the return over the last month (1M).</>,
              <><b>Hot &amp; Cold Index</b> — This automatically picks out the best-performing sector index and the worst-performing sector index over the last month. No setup needed; it updates on its own.</>,
              <><b>Nifty 50 Heatmap</b> — A visual map of all 50 stocks in the Nifty. Bigger boxes mean the stock has more weight in the index. Green means the stock is up, red means it is down. A quick glance tells you how the market is doing.</>,
              <><b>Quick Access</b> — Shortcuts to some of the most popular features in the app, so you can jump to them quickly.</>,
            ]} />
          </SubSection>

          <SubSection id="markets-sectors" number="1.2" title="Sectors">
            <p>
              This section shows all the NSE sector indices — IT, Bank, Auto, Pharma, Metal, and more — along with their recent performance.
              Use it to spot which sectors are leading the market and which ones are falling behind.
            </p>
          </SubSection>
        </Section>

        {/* --- SECTION 2: Signals --- */}
        <Section id="signals" number="2" title="Signals (Trade Ideas)">

          <SubSection id="oi-signals" number="2.1" title="OI Signals">
            <p>
              These are algorithm-based trading signals based on <b>Options Chain analysis</b>.
            </p>
            <p>
              <b>How it works:</b> The system looks at Open Interest (OI), Put-Call Ratio (PCR), Max Pain, and IV Skew for each stock, then generates a score.
            </p>
            <BulletList items={[
              <><b>Score</b> — Ranges from <b>-100</b> (strongly bearish) to <b>+100</b> (strongly bullish).</>,
              <>Each signal comes with two recommendations: an <b>Options recommendation</b> (which option to buy or sell, at what price, stop loss, and targets) and a <b>Cash recommendation</b> (whether to buy or sell the stock itself).</>,
              <><b>Confidence levels</b> — STRONG, MODERATE, or WEAK.</>,
              <>Best used <b>during market hours</b> (9:15 AM - 3:30 PM IST).</>,
            ]} />
          </SubSection>

          <SubSection id="cpr-scanner" number="2.2" title="CPR Scanner">
            <p>
              This tool scans stocks using the <b>Camarilla Pivot Range (CPR)</b> — a price-based trading system that helps identify key support and resistance levels.
            </p>
            <BulletList items={[
              <><b>Multi-timeframe analysis</b> — It checks Monthly, Weekly, and Daily timeframes.</>,
              <>The best setups are when <b>all three timeframes agree</b> on direction.</>,
              <><b>Alert tiers</b> — A+ (best quality), A, B, and Watch.</>,
              <><b>How to use:</b> Select your universe (N50, N100, or N200), click &quot;Scan&quot;, and wait for results.</>,
            ]} />
          </SubSection>

          <SubSection id="pattern-scanner" number="2.3" title="Pattern Scanner">
            <p>
              This scanner automatically detects well-known chart patterns such as <b>Head &amp; Shoulders</b>, <b>Triangles</b>, <b>Wedges</b>, <b>Flags</b>, <b>Double Top/Bottom</b>, and <b>Cup &amp; Handle</b>.
            </p>
            <p>
              Each detected pattern comes with a confidence level. Use these to spot breakout or breakdown setups before they happen.
            </p>
          </SubSection>

          <SubSection id="vcp" number="2.4" title="VCP (Volume Contraction Pattern)">
            <p>
              Based on <b>Mark Minervini&apos;s SEPA methodology</b>. This scanner finds stocks where:
            </p>
            <BulletList items={[
              <>Price contractions are <b>getting tighter</b> over time.</>,
              <>Volume is <b>declining</b> — meaning selling pressure is drying up.</>,
              <>The stock is &quot;coiling&quot; and getting ready for a potential <b>breakout</b>.</>,
            ]} />
            <p>
              Each result shows a <b>VCP score</b>, the current <b>stage</b> (Setting Up, Near Pivot, or Breakout), and the stock&apos;s <b>relative strength</b> compared to the broader market.
            </p>
          </SubSection>

          <SubSection id="nr-squeeze" number="2.5" title="NR Squeeze">
            <p>
              This scanner finds stocks that are about to make a big move. It looks for three types of &quot;squeeze&quot; setups:
            </p>
            <BulletList items={[
              <><b>NR4 / NR7</b> — The stock&apos;s trading range today is the narrowest in the last 4 or 7 days.</>,
              <><b>Inside Bar</b> — Today&apos;s entire price range fits within yesterday&apos;s range.</>,
              <><b>Bollinger Band Squeeze</b> — The Bollinger Bands are at their tightest point, signaling low volatility.</>,
            ]} />
            <p>
              When you see these patterns, the stock is compressing. The direction of the eventual breakout (up or down) will determine the trade.
            </p>
          </SubSection>

          <SubSection id="volume-profile" number="2.6" title="Volume Profile">
            <p>
              Volume Profile tells you <em>where</em> the most trading happened at different price levels:
            </p>
            <BulletList items={[
              <><b>Point of Control (POC)</b> — The price level where the highest volume was traded. Think of it as the &quot;fair value&quot; price.</>,
              <><b>Value Area High / Low</b> — The price range where 70% of all trading happened. This range acts as a strong support/resistance zone.</>,
            ]} />
          </SubSection>

          <SubSection id="52w-bounce" number="2.7" title="52W Bounce">
            <p>
              Finds stocks that are near their <b>52-week low</b> but are starting to show signs of recovery. The criteria are:
            </p>
            <BulletList items={[
              <>Stock is close to its 52-week low.</>,
              <>There is a <b>volume surge</b> (at least 2x the average volume).</>,
              <>The <b>buying score</b> is positive — meaning buyers are stepping in.</>,
            ]} />
            <p>
              These are potential reversal candidates — stocks that might be turning around after a long fall.
            </p>
          </SubSection>

          <SubSection id="swing-spectrum" number="2.8" title="Swing Spectrum">
            <p>
              A collection of swing trading strategies in one place:
            </p>
            <BulletList items={[
              <><b>10-Day Breakout</b> — Stock breaks above its 10-day high.</>,
              <><b>50-Day Breakout</b> — Stock breaks above its 50-day high.</>,
              <><b>Reversal Radar</b> — Detects potential trend reversals.</>,
              <><b>Channel Breakout</b> — Stock breaks out of a well-defined price channel.</>,
            ]} />
            <p>
              Each signal shows the signal strength, suggested entry price, stop loss, and target.
            </p>
          </SubSection>
        </Section>

        {/* --- SECTION 3: Options --- */}
        <Section id="options" number="3" title="Options">

          <SubSection id="options-chain" number="3.1" title="Options Chain">
            <p>
              A live options chain for the major indices: <b>NIFTY</b>, <b>BANKNIFTY</b>, <b>FINNIFTY</b>, <b>MIDCPNIFTY</b>, and <b>SENSEX</b>.
            </p>
            <BulletList items={[
              <>Shows <b>strike prices</b>, Call/Put OI, OI Change, Volume, LTP (Last Traded Price), and IV (Implied Volatility).</>,
              <><b>Analytics</b> — PCR (Put-Call Ratio), Max Pain, ATM IV, and the top OI resistance/support levels.</>,
              <>Options that are <b>In-The-Money (ITM)</b> are highlighted in green.</>,
              <><b>OI Clock view</b> — A visual circular chart that shows how Open Interest is spread across strikes.</>,
            ]} />
          </SubSection>

          <SubSection id="options-apex" number="3.2" title="Options Apex">
            <p>
              Advanced options analytics with easy-to-read visual gauges:
            </p>
            <BulletList items={[
              <><b>PCR Gauge</b> — Shows whether the market sentiment is bullish or bearish, like a speedometer.</>,
              <><b>Money Flux</b> — Real-time money flow across Nifty 50 stocks. See where the big money is going.</>,
              <><b>5-minute intraday chart</b> — Candlestick chart with an OI overlay so you can see price and options activity together.</>,
            ]} />
          </SubSection>

          <SubSection id="fo-stocks" number="3.3" title="F&O Stocks">
            <p>
              The same options chain and analytics you get for indices, but for <b>individual F&amp;O-eligible stocks</b> like RELIANCE, TCS, INFY, and others.
              If you trade stock options, this is your go-to tool.
            </p>
          </SubSection>
        </Section>

        {/* --- SECTION 4: Radar --- */}
        <Section id="radar" number="4" title="Radar (Market Pulse)">

          <SubSection id="market-pulse" number="4.1" title="Market Pulse">
            <p>
              A real-time scanner that finds stocks with unusual activity happening right now:
            </p>
            <BulletList items={[
              <><b>Breakout Beacon</b> — Stocks that are breaking out with strong volume, sorted by signal strength. The strongest signals appear first.</>,
              <><b>Intraday Boost</b> — Stocks with the highest R-Factor (today&apos;s price range compared to their average range). A high R-Factor means the stock is moving much more than usual.</>,
              <>You can filter by <b>Bull/Bear</b> or search for any specific stock.</>,
            ]} />
            <p>
              This is one of the best tools for finding intraday trading opportunities as the market moves.
            </p>
          </SubSection>

          <SubSection id="live-signals" number="4.2" title="Live Signals">
            <p>
              Tracks stocks crossing key levels <b>in real time</b>:
            </p>
            <BulletList items={[
              <><b>PDH Crossed</b> — The stock went above yesterday&apos;s high. This is a bullish signal.</>,
              <><b>Combo Surge</b> — The stock crossed yesterday&apos;s high AND volume is 1.5x the average. This is a high-conviction buy signal.</>,
              <><b>PDL Crossed</b> — The stock went below yesterday&apos;s low. This is a bearish signal.</>,
              <><b>Combo Sell</b> — The stock crossed below yesterday&apos;s low AND volume is 1.5x the average. This is a high-conviction sell signal.</>,
            ]} />
          </SubSection>

          <SubSection id="market-breadth" number="4.3" title="Market Breadth">
            <p>
              Gives you the big picture of market health:
            </p>
            <BulletList items={[
              <><b>Advances vs Declines</b> — How many stocks are going up versus going down across the market.</>,
              <><b>A/D Ratio</b> — A single number that summarizes the balance. Above 1 means more stocks are rising; below 1 means more are falling.</>,
              <><b>Sentiment indicator</b> — Labeled as BULLISH, BEARISH, or NEUTRAL based on the breadth data.</>,
            ]} />
          </SubSection>
        </Section>

        {/* --- SECTION 5: Screener --- */}
        <Section id="screener" number="5" title="Screener (Stocks)">

          <SubSection id="stock-tables" number="5.1" title="Stock Tables">
            <p>
              View stocks organized by universe: <b>Nifty 50</b>, <b>Nifty 100</b>, <b>Nifty 200</b>, <b>Nifty 500</b>, or <b>Small Cap 250</b>.
            </p>
            <BulletList items={[
              <>Each row shows: Symbol, Sector, LTP, Change%, Open, High, Low, and Volume.</>,
              <>You can <b>sort by any column</b>, filter by sector, or search by symbol.</>,
              <><b>Click any stock</b> to open its chart with CPR levels drawn on it.</>,
            ]} />
          </SubSection>

          <SubSection id="charts" number="5.2" title="Charts">
            <p>
              Interactive candlestick charts with volume bars at the bottom.
            </p>
            <BulletList items={[
              <><b>CPR levels</b> are drawn on the chart: Pivot (blue line), TC/BC (green lines), R1/S1 (red lines).</>,
              <><b>Timeframes:</b> 15 minutes, 1 hour, 1 day, 1 week.</>,
              <><b>Periods:</b> 1 month, 3 months, 6 months, 1 year.</>,
              <>An <b>info card</b> on the right shows the stock&apos;s sector, which index it belongs to, its CPR levels, and sector peers.</>,
            ]} />
          </SubSection>

          <SubSection id="all-stocks-search" number="5.3" title="All Stocks Search">
            <p>
              Search for any NSE-listed stock — over <b>2,700 stocks</b> available.
            </p>
            <BulletList items={[
              <>Type a stock symbol or company name, and suggestions appear as you type.</>,
              <>Each result tells you which indices the stock belongs to (Nifty 50, F&amp;O, etc.).</>,
              <>Click to open its chart instantly.</>,
            ]} />
          </SubSection>
        </Section>

        {/* --- SECTION 6: Other Features --- */}
        <Section id="other-features" number="6" title="Other Features">

          <SubSection id="scrolling-ticker" number="6.1" title="Market tape">
            <p>
              The market tape shows the latest available index and stock quotes. Green and red values indicate positive and negative changes. Scroll horizontally to explore the tape at your own pace. Check source timestamps before using cached quotes.
            </p>
          </SubSection>

          <SubSection id="dark-light-mode" number="6.2" title="Dark / Light Mode">
            <p>
              Click the <b>sun/moon icon</b> in the top navigation bar to switch between dark mode and light mode.
              Your preference is saved automatically and will be remembered next time you visit.
            </p>
          </SubSection>

          <SubSection id="market-status" number="6.3" title="Market Status">
            <BulletList items={[
              <>During trading hours (9:15 AM - 3:30 PM IST, Monday to Friday), you will see a <b>Session hours</b> indicator.</>,
              <>Outside those hours, it shows <b>Outside session</b>.</>,
              <>The clock reflects scheduled hours, not exchange holidays or feed health. Use each tool’s source status to check data freshness.</>,
            ]} />
          </SubSection>
        </Section>

        {/* --- Tips --- */}
        <div id="tips" data-guide-section className="scroll-mt-24 mt-16">
          <h2 className="text-2xl font-bold text-text-heading mb-5">Tips for Best Results</h2>
          <div className="rounded-xl border border-card-border bg-accent/5 p-5 sm:p-6 space-y-3">
            <TipItem number={1}>
              Use <b>OI Signals</b> during market hours for the best accuracy.
            </TipItem>
            <TipItem number={2}>
              <b>CPR Scanner</b> works best when you scan at end of day for next day&apos;s setups.
            </TipItem>
            <TipItem number={3}>
              Check <b>Market Pulse</b> throughout the day for breakout opportunities.
            </TipItem>
            <TipItem number={4}>
              Use the <b>All Stocks search</b> to quickly look up any stock — just type the symbol or company name.
            </TipItem>
          </div>
        </div>

        {/* --- Disclaimer --- */}
        <div className="mt-14 pt-8 border-t border-divider">
          <p className="text-xs text-text-secondary leading-relaxed">
            <b>Disclaimer:</b> Alpha Radar is for educational and informational purposes only. It is not financial advice.
            Always do your own research and consult a SEBI-registered advisor before making investment decisions.
            Options trading involves significant risk.
          </p>
        </div>

        {/* Back to top */}
        <div className="mt-8 text-center">
          <button
            onClick={() => document.getElementById("workspace-content")?.scrollTo({ top: 0, behavior: "smooth" })}
            className="text-sm text-muted hover:text-accent transition-colors"
          >
            Back to top
          </button>
        </div>
      </div>

      {/* Print styles */}
      <style jsx global>{`
        @media print {
          nav, .sticky { display: none !important; }
          body { background: white !important; color: black !important; }
          * { color: black !important; border-color: #ccc !important; background: transparent !important; }
          a { text-decoration: underline; }
        }
      `}</style>
    </div>
  );
}

/* --- Helper Components ------------------------------------------------- */

function Section({
  id,
  number,
  title,
  children,
}: {
  id: string;
  number: string;
  title: string;
  children: React.ReactNode;
}) {
  return (
    <section id={id} data-guide-section className="scroll-mt-24 mb-14">
      <h2 className="text-2xl font-bold text-text-heading mb-6 pb-3 border-b border-divider">
        <span className="text-accent mr-2">{number}.</span>
        {title}
      </h2>
      {children}
    </section>
  );
}

function SubSection({
  id,
  number,
  title,
  children,
}: {
  id: string;
  number: string;
  title: string;
  children: React.ReactNode;
}) {
  return (
    <div id={id} data-guide-section className="scroll-mt-24 mb-8">
      <h3 className="text-lg font-semibold text-text-heading mb-3">
        <span className="text-accent/70 mr-1.5">{number}</span>
        {title}
      </h3>
      <div className="space-y-3 text-text-secondary leading-[1.75] text-[15px]">
        {children}
      </div>
    </div>
  );
}

function BulletList({ items }: { items: React.ReactNode[] }) {
  return (
    <ul className="space-y-2 pl-1">
      {items.map((item, i) => (
        <li key={i} className="flex gap-2.5">
          <span className="text-accent mt-1.5 shrink-0">
            <svg className="w-3 h-3" fill="currentColor" viewBox="0 0 8 8">
              <circle cx="4" cy="4" r="3" />
            </svg>
          </span>
          <span>{item}</span>
        </li>
      ))}
    </ul>
  );
}

function TipItem({ number, children }: { number: number; children: React.ReactNode }) {
  return (
    <div className="flex gap-3 items-start">
      <span className="shrink-0 w-6 h-6 rounded-full bg-accent text-white text-xs font-bold flex items-center justify-center mt-0.5">
        {number}
      </span>
      <p className="text-sm text-foreground leading-relaxed">{children}</p>
    </div>
  );
}
