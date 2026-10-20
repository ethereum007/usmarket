"use client";

import { useState } from "react";
import { ChevronDown, ChevronRight, GraduationCap } from "lucide-react";

/**
 * 90-second primer on reading the RRG. Collapsed by default so it doesn't
 * crowd repeat users — single click to expand. Written for AlphaBull
 * students who are seeing RRG for the first time.
 */
export function HowToRead() {
  const [open, setOpen] = useState(false);

  return (
    <section className="rounded-lg border border-card-border bg-card">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        className="flex w-full items-center justify-between px-4 py-3 text-left hover:bg-hover-bg"
      >
        <span className="flex items-center gap-2">
          <GraduationCap size={18} className="text-accent" style={{ color: "var(--accent)" }} />
          <span className="font-semibold text-sm text-foreground">How to read this chart</span>
          <span className="text-xs text-muted">— 90-second primer</span>
        </span>
        {open ? <ChevronDown size={16} /> : <ChevronRight size={16} />}
      </button>

      {open && (
        <div className="border-t border-card-border px-5 py-4 space-y-4 text-sm text-foreground">
          <div>
            <h3 className="font-semibold mb-1">What you&apos;re looking at</h3>
            <p>
              Each dot is one sector index plotted against the benchmark (default: Nifty 50).
              The trail behind it shows where the sector was in previous bars — so you can see
              the direction it&apos;s heading.
            </p>
            <ul className="list-disc pl-5 mt-2 space-y-0.5 text-muted">
              <li>
                <b className="text-foreground">X-axis (RS-Ratio)</b>: Is the sector outperforming
                the benchmark? &gt; 100 = yes, &lt; 100 = no.
              </li>
              <li>
                <b className="text-foreground">Y-axis (RS-Momentum)</b>: Is the outperformance
                accelerating or decelerating? &gt; 100 = accelerating, &lt; 100 = decelerating.
              </li>
            </ul>
          </div>

          <div>
            <h3 className="font-semibold mb-1">The 4 quadrants and what to do</h3>
            <div className="grid grid-cols-1 md:grid-cols-2 gap-2">
              <div className="rounded border border-card-border bg-emerald-500/5 p-2">
                <div className="font-semibold text-emerald-400">↗ Leading (top-right)</div>
                <div className="text-xs text-muted">Outperforming AND momentum rising. <b className="text-foreground">Hold longs, add on dips.</b></div>
              </div>
              <div className="rounded border border-card-border bg-amber-500/5 p-2">
                <div className="font-semibold text-amber-400">↓ Weakening (bottom-right)</div>
                <div className="text-xs text-muted">Still outperforming but momentum is fading. <b className="text-foreground">Trim profits, tighten stops.</b></div>
              </div>
              <div className="rounded border border-card-border bg-violet-500/5 p-2">
                <div className="font-semibold text-violet-400">↑ Improving (top-left)</div>
                <div className="text-xs text-muted">Underperforming but momentum is turning up. <b className="text-foreground">Best new-entry zone — start small.</b></div>
              </div>
              <div className="rounded border border-card-border bg-rose-500/5 p-2">
                <div className="font-semibold text-rose-400">↙ Lagging (bottom-left)</div>
                <div className="text-xs text-muted">Underperforming and decelerating. <b className="text-foreground">Avoid until momentum turns up.</b></div>
              </div>
            </div>
          </div>

          <div>
            <h3 className="font-semibold mb-1">The rotation cycle (counter-clockwise)</h3>
            <p className="text-muted">
              In a healthy market, sectors rotate around the chart counter-clockwise over weeks/months:
            </p>
            <p className="mt-1 font-mono text-xs bg-hover-bg rounded px-3 py-2">
              Improving ↗ Leading ↓ Weakening ↙ Lagging ↑ Improving …
            </p>
            <p className="mt-2 text-muted">
              When a sector skips quadrants or rotates clockwise, it&apos;s usually noise — wait for
              confirmation before acting.
            </p>
          </div>

          <div>
            <h3 className="font-semibold mb-1">Signal events to watch</h3>
            <ul className="list-disc pl-5 space-y-0.5 text-muted">
              <li>
                <b className="text-violet-400">Improving → Leading</b>: strongest buy signal. Sector has
                confirmed an uptrend in relative strength.
              </li>
              <li>
                <b className="text-amber-400">Leading → Weakening</b>: take partial profits / tighten stops.
                The easy money is over for this leg.
              </li>
              <li>
                <b className="text-rose-400">Weakening → Lagging</b>: full exit if you didn&apos;t already.
                Avoid until next cycle.
              </li>
              <li>
                <b className="text-emerald-400">Lagging → Improving</b>: early-warning. Start watching for
                an entry zone but don&apos;t buy yet — wait for the move into Leading.
              </li>
            </ul>
          </div>

          <div>
            <h3 className="font-semibold mb-1">
              <span className="text-muted">~</span> Borderline sectors — don&apos;t over-trust
              the quadrant
            </h3>
            <p className="text-muted">
              When a sector&apos;s ratio or momentum is within ±0.5 of 100, we tag it{" "}
              <b className="text-foreground">~ BORDERLINE</b>. Quadrant assignment is unreliable —
              they can legitimately be read either way and may flip on the next bar.
            </p>
            <p className="mt-1.5 text-xs text-muted">
              Trading rule of thumb: trust quadrant calls more when sectors are FAR from the
              centerlines, less when they&apos;re near. Far + decisive move = strong signal.
            </p>
          </div>

          <div className="rounded border border-card-border bg-hover-bg p-3">
            <h3 className="font-semibold mb-1">Pro tips</h3>
            <ul className="list-disc pl-5 text-sm space-y-1 text-muted">
              <li>Long, smooth tails counter-clockwise = clean trend. Choppy back-and-forth = indecision; size down.</li>
              <li>Crossings made far from center = stronger conviction. Crossings near center = weaker signals.</li>
              <li>Use <b className="text-foreground">Weekly</b> for position-trading bias; <b className="text-foreground">Daily</b> for swing entries.</li>
              <li>The <b className="text-foreground">Date slider</b> replays past months — great for backtesting your reading.</li>
            </ul>
          </div>
        </div>
      )}
    </section>
  );
}
