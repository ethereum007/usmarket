"use client";

import { useEffect, useRef, useState } from "react";
import { Play, Pause, SkipForward, SkipBack } from "lucide-react";

type Props = {
  dates: string[];
  value: string | null;
  onChange: (date: string) => void;
};

const PLAY_INTERVAL_MS = 350;

/**
 * Historical replay slider. Wires the chart to any past snapshot date — Play
 * auto-advances through history at PLAY_INTERVAL_MS per bar.
 */
export function DateSlider({ dates, value, onChange }: Props) {
  const [playing, setPlaying] = useState(false);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const index = value ? Math.max(0, dates.indexOf(value)) : dates.length - 1;
  const isLatest = index === dates.length - 1;

  useEffect(() => {
    if (!playing) return;
    timerRef.current = setInterval(() => {
      const cur = value ? dates.indexOf(value) : dates.length - 1;
      if (cur < 0 || cur >= dates.length - 1) {
        setPlaying(false);
        return;
      }
      onChange(dates[cur + 1]);
    }, PLAY_INTERVAL_MS);
    return () => {
      if (timerRef.current) clearInterval(timerRef.current);
    };
  }, [playing, value, dates, onChange]);

  if (dates.length === 0) return null;

  const step = (delta: number) => {
    const next = Math.min(dates.length - 1, Math.max(0, index + delta));
    onChange(dates[next]);
  };

  return (
    <div className="flex flex-wrap items-center gap-3 rounded-lg border border-card-border bg-card px-3 py-2">
      <button
        type="button"
        onClick={() => step(-1)}
        disabled={index === 0}
        className="p-1 text-muted hover:text-foreground disabled:opacity-30"
        aria-label="Previous day"
      >
        <SkipBack size={16} />
      </button>
      <button
        type="button"
        onClick={() => setPlaying((p) => !p)}
        disabled={isLatest}
        className="p-1 text-muted hover:text-foreground disabled:opacity-30"
        aria-label={playing ? "Pause" : "Play"}
      >
        {playing ? <Pause size={16} /> : <Play size={16} />}
      </button>
      <button
        type="button"
        onClick={() => step(1)}
        disabled={isLatest}
        className="p-1 text-muted hover:text-foreground disabled:opacity-30"
        aria-label="Next day"
      >
        <SkipForward size={16} />
      </button>
      <input
        aria-label="Replay date"
        type="range"
        min={0}
        max={dates.length - 1}
        value={index}
        onChange={(e) => onChange(dates[Number(e.target.value)])}
        className="flex-1 min-w-24"
        style={{ accentColor: "var(--accent)" }}
      />
      <span className="text-sm tabular-nums text-foreground min-w-[6.5rem] text-right">
        {dates[index]}
      </span>
      <button
        type="button"
        onClick={() => onChange(dates[dates.length - 1])}
        disabled={isLatest}
        className="text-xs text-muted hover:text-foreground disabled:opacity-30"
      >
        Latest
      </button>
    </div>
  );
}
