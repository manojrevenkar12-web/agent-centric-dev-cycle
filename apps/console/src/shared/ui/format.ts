export const pct = (x: number | null | undefined, digits = 0) =>
  x === null || x === undefined ? "–" : `${(100 * x).toFixed(digits)}%`;

export const usd = (x: number | null | undefined) =>
  x === null || x === undefined ? "–" : `$${x.toFixed(2)}`;

export const LEVEL_NAMES: Record<string, string> = {
  human_only: "Human only",
  agent_draft: "Agent draft",
  agent_reviewed: "Agent, reviewed",
  auto_approvable: "Auto-approvable",
};

export const levelName = (l: string | null | undefined) => (l ? (LEVEL_NAMES[l] ?? l) : "–");

export const STATE_NAMES: Record<string, string> = {
  queued: "Queued",
  blocked: "Not for an agent",
  running: "Agent working",
  failed: "No change",
  rejected: "Change discarded",
  pr_open: "PR open",
  changes_requested: "Changes requested",
  merged: "Merged",
  closed: "Closed",
};

export const when = (iso: string) =>
  new Date(iso).toLocaleString("en-GB", {
    day: "numeric",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
  });
