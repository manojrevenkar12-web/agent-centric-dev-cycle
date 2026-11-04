/** Quality and adoption signals, computed from the event log only (never from what an agent said). */
import type { Event, Run } from "./store.js";

export type Metrics = {
  issues: number;
  blocked_at_preflight: number;
  prs_opened: number;
  merged: number;
  reviewer_acceptance_rate: number | null; // first review of a PR is an approval
  ci_pass_rate: number | null; // first CI result of a PR is a success
  rework_rate: number | null; // reviewed PRs that got at least one "changes requested"
  overclaim_rate: number | null; // agent said tests pass, the executor's run said no
  self_verified_rate: number | null; // agent ran tests itself before finishing
  handed_over: number;
  cost_usd: number;
  cost_per_merged_usd: number | null;
  median_hours_to_merge: number | null;
  satisfaction: { mean: number | null; responses: number };
  levels: Record<string, number>;
};

const ratio = (a: number, b: number) => (b ? a / b : null);

export function metrics(runs: Run[], events: Event[]): Metrics {
  const by = new Map<string, Event[]>();
  for (const e of events) by.set(e.run_id, [...(by.get(e.run_id) ?? []), e]);
  let reviewed = 0;
  let firstApproved = 0;
  let withCi = 0;
  let firstGreen = 0;
  let reworked = 0;
  let finished = 0;
  let overclaims = 0;
  let verified = 0;
  const toMerge: number[] = [];
  const scores: number[] = [];
  const levels: Record<string, number> = {};
  for (const r of runs) {
    const es = by.get(r.id) ?? [];
    const reviews = es.filter((e) => e.kind === "review" && e.data.state !== "commented");
    if (reviews.length) {
      reviewed++;
      if (reviews[0]?.data.state === "approved") firstApproved++;
      if (reviews.some((e) => e.data.state === "changes_requested")) reworked++;
    }
    const ci = es.filter((e) => e.kind === "ci");
    if (ci.length) {
      withCi++;
      if (ci[0]?.data.conclusion === "success") firstGreen++;
    }
    for (const e of es.filter((x) => x.kind === "agent_finished" && x.data.ok)) {
      finished++;
      const checks = e.data.checks as { tests?: boolean } | undefined;
      if (e.data.claimed_tests_pass === true && !checks?.tests) overclaims++;
      if (Number(e.data.tests_run ?? 0) > 0) verified++;
    }
    const opened = es.find((e) => e.kind === "pr_opened");
    const merged = es.find((e) => e.kind === "merged");
    if (opened && merged) toMerge.push((Date.parse(merged.at) - Date.parse(opened.at)) / 3_600_000);
    for (const e of es.filter((x) => x.kind === "feedback")) scores.push(Number(e.data.score));
    if (r.level && opened) levels[r.level] = (levels[r.level] ?? 0) + 1;
  }
  const merged = runs.filter((r) => r.state === "merged").length;
  const cost = runs.reduce((s, r) => s + r.cost_usd, 0);
  const sorted = [...toMerge].sort((a, b) => a - b);
  return {
    issues: new Set(runs.map((r) => r.issue_id)).size,
    blocked_at_preflight: runs.filter((r) => r.state === "blocked").length,
    prs_opened: runs.filter((r) => r.pr_number !== null).length,
    merged,
    reviewer_acceptance_rate: ratio(firstApproved, reviewed),
    ci_pass_rate: ratio(firstGreen, withCi),
    rework_rate: ratio(reworked, reviewed),
    overclaim_rate: ratio(overclaims, finished),
    self_verified_rate: ratio(verified, finished),
    handed_over: events.filter((e) => e.kind === "handed_over").length,
    cost_usd: cost,
    cost_per_merged_usd: merged ? cost / merged : null,
    median_hours_to_merge: sorted.length ? (sorted[Math.floor((sorted.length - 1) / 2)] ?? null) : null,
    satisfaction: {
      mean: scores.length ? scores.reduce((a, b) => a + b, 0) / scores.length : null,
      responses: scores.length,
    },
    levels,
  };
}
