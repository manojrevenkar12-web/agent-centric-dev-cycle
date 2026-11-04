/** The loop: a Linear issue becomes an agent run, the run becomes a pull request with evidence, and
 * review decides. The safety model gates both ends: preflight decides whether an agent may attempt
 * the issue at all, and the change itself decides the level (draft, reviewed, auto-approvable) and the
 * reviewers. Nothing here merges: people and n8n's own merge gates do.
 */
import { type Decision, type OwnersEntry, type RiskTier, decide, preflight } from "@acdc/core";
import { type CodeHost, type GitHubEvent, type Tracker, serviceCfg } from "./adapters.js";
import type { Issue, Run, Store } from "./store.js";

export type Claim = { summary?: string; verification?: string; tests_pass?: boolean; risks?: string[] };

export type ExecResult = {
  ok: boolean;
  error?: string;
  branch: string;
  files: string[];
  cost_usd: number;
  tests_run: number; // the agent's own test runs: self-verification
  checks: { tests: boolean; typecheck: boolean; lint: boolean }; // run by the executor after the agent, not claimed
  claim: Claim | null;
};

export interface Executor {
  run(
    issue: Issue,
    opts: { runId: string; attempt: number; branch: string; feedback?: string },
  ): Promise<ExecResult>;
}

export type RiskScorer = (files: string[], title: string) => { p: number; tier: RiskTier };

export class Cycle {
  private queue: Promise<unknown> = Promise.resolve();

  constructor(
    readonly store: Store,
    readonly tracker: Tracker,
    readonly host: CodeHost,
    readonly executor: Executor,
    readonly owners: OwnersEntry[],
    readonly risk: RiskScorer,
  ) {}

  /** Webhooks return at once; runs go through a queue (concurrency 1 per instance). */
  enqueue<T>(job: () => Promise<T>): Promise<T> {
    const next = this.queue.then(job, job);
    this.queue = next.catch(() => undefined);
    return next;
  }

  async onIssue(issue: Issue): Promise<Run | null> {
    await this.store.upsertIssue(issue);
    const run = await this.store.createRun(issue.id);
    if (!run) return null; // already in flight: a Linear update does not start a second run
    const pre = preflight(issue.category as Parameters<typeof preflight>[0]);
    await this.store.event(run.id, "preflight", {
      category: issue.category,
      level: pre.level,
      allowed: pre.allowed,
    });
    if (!pre.allowed) {
      await this.store.update(run.id, { state: "blocked", level: pre.level });
      await this.tracker.comment(
        issue.id,
        `An agent will not take this issue: ${pre.reasons.join("; ")}. A person needs to own it.`,
      );
      return this.store.run(run.id);
    }
    await this.execute(run, issue, 1);
    return this.store.run(run.id);
  }

  private async execute(run: Run, issue: Issue, attempt: number, feedback?: string) {
    await this.store.update(run.id, { state: "running" });
    const branch = `${serviceCfg().branch_prefix}${issue.key.toLowerCase()}`;
    let res: ExecResult;
    try {
      res = await this.executor.run(issue, { runId: run.id, attempt, branch, feedback });
    } catch (e) {
      res = {
        ok: false,
        error: String(e),
        branch,
        files: [],
        cost_usd: 0,
        tests_run: 0,
        checks: { tests: false, typecheck: false, lint: false },
        claim: null,
      };
    }
    await this.store.addCost(run.id, res.cost_usd);
    await this.store.event(run.id, "agent_finished", {
      attempt,
      ok: res.ok,
      error: res.error,
      files: res.files,
      cost_usd: res.cost_usd,
      tests_run: res.tests_run,
      checks: res.checks,
      claimed_tests_pass: res.claim?.tests_pass ?? null,
    });
    if (!res.ok || !res.files.length) {
      await this.store.update(run.id, { state: "failed" });
      await this.tracker.comment(
        issue.id,
        `The agent did not produce a change${res.error ? ` (${res.error})` : ""}. Back to the team.`,
      );
      return;
    }
    const r = this.risk(res.files, issue.title);
    const d = decide(issue.category as Parameters<typeof decide>[0], res.files, this.owners, r.tier);
    await this.store.event(run.id, "decision", {
      level: d.level,
      reasons: d.reasons,
      risk: r,
      forbidden: d.forbidden,
    });
    if (!d.allowed) {
      await this.store.update(run.id, { state: "rejected", level: d.level, decision: d });
      await this.tracker.comment(issue.id, `The agent's change was discarded: ${d.reasons.join("; ")}.`);
      return;
    }
    const body = evidenceBody(issue, res, d, r);
    if (attempt === 1) {
      const pr = await this.host.openPr({
        branch: res.branch,
        title: issue.title,
        body,
        draft: d.level === "agent_draft",
        teams: Object.keys(d.requiredTeams),
      });
      await this.store.update(run.id, {
        state: "pr_open",
        level: d.level,
        pr_number: pr.number,
        evidence: body,
        decision: d,
      });
      await this.store.event(run.id, "pr_opened", {
        pr: pr.number,
        level: d.level,
        draft: d.level === "agent_draft",
      });
      await this.tracker.comment(
        issue.id,
        `Pull request #${pr.number} is open (${d.level.replace("_", " ")}).`,
      );
    } else {
      const pr = run.pr_number as number;
      await this.host.comment(pr, `Rework ${attempt - 1} after review:\n\n${body}`);
      await this.store.update(run.id, { state: "pr_open", level: d.level, evidence: body, decision: d });
      await this.store.event(run.id, "reworked", { pr, attempt, level: d.level });
    }
  }

  async onGitHub(ev: GitHubEvent) {
    const run = await this.store.runByPr(ev.pr);
    if (!run) return;
    if (ev.kind === "ci") {
      await this.store.event(run.id, "ci", { conclusion: ev.conclusion, attempt: run.attempt });
      return;
    }
    if (ev.kind === "closed") {
      await this.store.update(run.id, { state: ev.merged ? "merged" : "closed" });
      await this.store.event(run.id, ev.merged ? "merged" : "closed", { pr: ev.pr });
      return;
    }
    await this.store.event(run.id, "review", {
      state: ev.state,
      reviewer: ev.reviewer,
      attempt: run.attempt,
    });
    if (ev.state !== "changes_requested") return;
    const issue = await this.store.issue(run.issue_id);
    if (!issue) return;
    const reworks = (await this.store.events(run.id)).filter((e) => e.kind === "reworked").length;
    if (reworks >= serviceCfg().max_rework) {
      await this.store.update(run.id, { state: "changes_requested" });
      await this.host.comment(
        ev.pr,
        "The agent has answered review the most times it may. A person takes it from here.",
      );
      await this.store.event(run.id, "handed_over", { reworks });
      return;
    }
    await this.store.update(run.id, { state: "changes_requested" });
    await this.store.pool.query("update runs set attempt = attempt + 1 where id = $1", [run.id]);
    const fresh = (await this.store.run(run.id)) as Run;
    await this.execute(fresh, issue, fresh.attempt, ev.body);
  }

  async feedback(runId: string, score: number, comment: string) {
    if (!Number.isInteger(score) || score < 1 || score > 5) throw new Error("score must be 1 to 5");
    await this.store.event(runId, "feedback", { score, comment: comment.slice(0, 2000) });
  }

  /** After a restart: a run that was mid-flight is marked failed rather than left looking busy. */
  async recover() {
    const stale = await this.store.pool.query(
      "update runs set state = 'failed', updated_at = now() where state in ('queued','running') returning id",
    );
    for (const r of stale.rows) await this.store.event(r.id, "interrupted", {});
    return stale.rowCount ?? 0;
  }
}

export function evidenceBody(
  issue: Issue,
  res: ExecResult,
  d: Decision,
  r: { p: number; tier: string },
): string {
  const c = res.claim;
  const said = c?.tests_pass;
  const actually = res.checks.tests;
  return [
    `Closes ${issue.key}`,
    "",
    c?.summary ?? "_The agent gave no summary._",
    "",
    "### What changed",
    ...res.files.map((f) => `- \`${f}\``),
    "",
    "### What ran",
    `- The agent ran tests ${res.tests_run} time(s): ${c?.verification ?? "it did not say what it ran"}`,
    `- After the agent, the executor ran: tests ${actually ? "pass" : "fail"}, type check ${res.checks.typecheck ? "passes" : "fails"}, lint ${res.checks.lint ? "passes" : "fails"}`,
    said === true && !actually
      ? "- **The agent said the tests pass; the executor's run says they do not.**"
      : "",
    "",
    "### Risks that remain",
    `- Change risk: ${r.tier} (${(100 * r.p).toFixed(0)}% chance of a revert or follow-up fix, from n8n's history)`,
    ...(c?.risks ?? []).map((x) => `- ${x}`),
    "",
    "### Where a person decides",
    `- Autonomy level: **${d.level.replace("_", " ")}**`,
    ...d.reasons.map((x) => `- ${x}`),
    Object.keys(d.requiredTeams).length
      ? `- Required reviewers: ${Object.keys(d.requiredTeams).join(", ")}`
      : "",
  ]
    .filter((l, i, a) => l !== "" || a[i - 1] !== "")
    .join("\n");
}
