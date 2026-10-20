"use client";

interface Zone {
  from: number;
  to: number;
  color: string;
}

interface GaugeDialProps {
  value: number;
  label: string;
  zones: Zone[];
  labels: string[];
}

export function GaugeDial({ value, label, zones, labels }: GaugeDialProps) {
  const angle = -135 + (value / 100) * 270;

  return (
    <div className="flex flex-col items-center">
      <svg viewBox="0 0 200 130" className="w-full max-w-[180px]">
        {zones.map((zone, i) => {
          const startAngle = -135 + (zone.from / 100) * 270;
          const endAngle = -135 + (zone.to / 100) * 270;
          const startRad = (startAngle * Math.PI) / 180;
          const endRad = (endAngle * Math.PI) / 180;
          const r = 75;
          const cx = 100, cy = 100;

          const x1 = cx + r * Math.cos(startRad);
          const y1 = cy + r * Math.sin(startRad);
          const x2 = cx + r * Math.cos(endRad);
          const y2 = cy + r * Math.sin(endRad);
          const largeArc = endAngle - startAngle > 180 ? 1 : 0;

          return (
            <path
              key={i}
              d={`M ${x1} ${y1} A ${r} ${r} 0 ${largeArc} 1 ${x2} ${y2}`}
              fill="none"
              stroke={zone.color}
              strokeWidth="10"
              strokeLinecap="round"
            />
          );
        })}

        {(() => {
          const rad = (angle * Math.PI) / 180;
          const cx = 100, cy = 100;
          const needleLen = 58;
          const nx = cx + needleLen * Math.cos(rad);
          const ny = cy + needleLen * Math.sin(rad);
          return (
            <>
              <line x1={cx} y1={cy} x2={nx} y2={ny}
                stroke="white" strokeWidth="2.5" strokeLinecap="round" />
              <circle cx={cx} cy={cy} r="5" fill="white" />
              <circle cx={cx} cy={cy} r="3" fill="var(--card)" />
            </>
          );
        })()}

        {labels.map((lbl, i) => {
          const labelAngle = -135 + (i / (labels.length - 1)) * 270;
          const rad = (labelAngle * Math.PI) / 180;
          const r = 92;
          const x = 100 + r * Math.cos(rad);
          const y = 100 + r * Math.sin(rad);
          return (
            <text key={i} x={x} y={y} textAnchor="middle" dominantBaseline="middle"
              fontSize="7" fill="var(--muted)">
              {lbl.split("\n").map((line, j) => (
                <tspan key={j} x={x} dy={j > 0 ? 8 : 0}>{line}</tspan>
              ))}
            </text>
          );
        })}
      </svg>
      <span className="text-xs font-medium text-foreground -mt-2">{label}</span>
    </div>
  );
}
