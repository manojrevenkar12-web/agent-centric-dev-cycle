import { motion } from "motion/react";
import { useEffect, useState } from "react";
import { motionTokens } from "../theme/motion";
import { levelName } from "./format";

export const RUNGS = ["auto_approvable", "agent_reviewed", "agent_draft", "human_only"] as const;

export type Rung = { level: string; share?: number; note?: string };

/** The autonomy ladder, most autonomy at the top. With a marker, it shows a change starting at the
 * level its issue allowed and dropping to the level the change itself earned: it can only go down. */
export function Ladder({
  rows,
  marker,
  label,
}: { rows: Rung[]; marker?: { from: string; to: string }; label: string }) {
  const [at, setAt] = useState(marker?.from);
  useEffect(() => {
    setAt(marker?.from);
    if (!marker) return;
    const t = setTimeout(() => setAt(marker.to), motionTokens.base * 1000);
    return () => clearTimeout(t);
  }, [marker?.from, marker?.to, marker]);
  const byLevel = new Map(rows.map((r) => [r.level, r]));
  return (
    <ol className="ladder" aria-label={label}>
      {RUNGS.map((level) => {
        const r = byLevel.get(level);
        const here = marker && at === level;
        return (
          <li
            key={level}
            className="rung"
            data-level={level}
            aria-current={marker?.to === level ? "step" : undefined}
          >
            <span aria-hidden="true">
              {here && (
                <motion.span
                  layoutId="ladder-marker"
                  className="marker"
                  transition={{ duration: motionTokens.drop, ease: motionTokens.ease }}
                />
              )}
            </span>
            <span className="rung-name">{levelName(level)}</span>
            <span className="rung-bar" aria-hidden="true">
              {r?.share !== undefined && <span style={{ width: `${Math.max(1, 100 * r.share)}%` }} />}
            </span>
            <span className="rung-note">{r?.note ?? ""}</span>
          </li>
        );
      })}
    </ol>
  );
}
