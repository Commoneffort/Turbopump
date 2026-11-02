// Closing a chosen share of a position: one slider, 1% to 100%, with 25/50/75/100 marks.
import { CSSProperties } from "react";

/** The share (percent) of a position to close. The close button next to it uses this share. */
export function CloseSlider({ pct, onChange, disabled, compact }: { pct: number; onChange: (pct: number) => void; disabled?: boolean; compact?: boolean }) {
  return (
    <div className={`pc-slide${compact ? " compact" : ""}`} style={{ "--fill": `${pct}%` } as CSSProperties}>
      <input type="range" min={1} max={100} step={1} value={pct} onChange={e => onChange(Number(e.target.value))} aria-label="Share of the position to close" disabled={disabled} />
      {!compact && <div className="pc-ticks">{[25, 50, 75, 100].map(p => <button key={p} type="button" className={pct === p ? "on" : ""} style={{ left: `${(p - 1) / 99 * 100}%` }} onClick={() => onChange(p)} disabled={disabled}>{p}%</button>)}</div>}
    </div>
  );
}
