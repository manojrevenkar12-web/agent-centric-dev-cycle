/** Replay benchmark runs through the real loop, for the console and the screenshots.
 *
 * The agent's work is real (each benchmark run's files, cost, test runs, checks and claims); the issue
 * tracker, the code host and the reviewers are stand-ins. Review follows the grader: a run whose change
 * resolved the task and passed CI is approved and merged; any other is sent back, and the replay answers
 * with the same change, so it is handed over after the last allowed rework. Nothing here is a
 * measurement of reviewers.
 *
 *   ACDC_DATABASE_URL=... pnpm --filter @acdc/service exec tsx src/replay.ts sonnet-repo
 */
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { ROOT, parseOwners } from "@acdc/core";
import type { CodeHost, Tracker } from "./adapters.js";
import { Cycle, type ExecResult } from "./loop.js";
import { Store } from "./store.js";

type BenchRun = {
  task: string;
  session: { ok: boolean; cost_usd: number; tests_run: number; result: string };
  grade: {
    resolved: boolean;
    ci_pass: boolean;
    files: string[];
    typecheck: { ok: boolean };
    lint: { ok: boolean };
    risk: { p: number; tier: "low" | "medium" | "high" };
    claim: { tests_pass: boolean | null };
  } | null;
};

const lastJson = (t: string) => {
  const m = [...t.matchAll(/\{[^{}]*(?:\{[^{}]*\}[^{}]*)*\}/g)].reverse();
  for (const x of m) {
    try {
      return JSON.parse(x[0]);
    } catch {}
  }
  return null;
};

export async function replay(store: Store, setup: string) {
  const dir = join(ROOT, "reports/runs", setup);
  const tasks = JSON.parse(readFileSync(join(ROOT, "data/tasks/tasks.json"), "utf8")).tasks as {
    id: string;
    title: string;
    statement: string;
  }[];
  const runs = readdirSync(dir)
    .filter((f) => f.endsWith(".json"))
    .map((f) => JSON.parse(readFileSync(join(dir, f), "utf8")) as BenchRun);
  const byTask = new Map(runs.map((r) => [r.task, r]));
  let pr = 100;
  const host: CodeHost = { openPr: async () => ({ number: ++pr }), comment: async () => {} };
  const tracker: Tracker = { comment: async () => {} };
  const current = { run: null as BenchRun | null };
  const executor = {
    run: async (_i: unknown, o: { branch: string }): Promise<ExecResult> => {
      const r = current.run as BenchRun;
      const g = r.grade;
      return {
        ok: r.session.ok && !!g?.files.length,
        branch: o.branch,
        files: g?.files ?? [],
        cost_usd: r.session.cost_usd,
        tests_run: r.session.tests_run,
        checks: { tests: !!g?.resolved, typecheck: !!g?.typecheck.ok, lint: !!g?.lint.ok },
        claim: lastJson(r.session.result),
      };
    },
  };
  const owners = parseOwners(readFileSync(join(ROOT, "data/n8n/OWNERS"), "utf8"));
  const cycle = new Cycle(store, tracker, host, executor, owners, () => {
    const g = current.run?.grade;
    return g ? g.risk : { p: 0.5, tier: "medium" };
  });
  for (const t of tasks) {
    const r = byTask.get(t.id);
    if (!r) continue;
    current.run = r;
    const run = await cycle.onIssue({
      id: `replay-${setup}-${t.id}`,
      key: t.id.toUpperCase(),
      title: t.statement,
      body: `Replayed from benchmark run ${setup}/${t.id}.`,
      labels: ["agent", "bug"],
      category: "bugfix",
    });
    if (!run?.pr_number) continue;
    const g = r.grade;
    await cycle.onGitHub({ kind: "ci", pr: run.pr_number, conclusion: g?.ci_pass ? "success" : "failure" });
    if (g?.resolved && g.ci_pass) {
      await cycle.onGitHub({
        kind: "review",
        pr: run.pr_number,
        state: "approved",
        body: "",
        reviewer: "replay",
      });
      await cycle.onGitHub({ kind: "closed", pr: run.pr_number, merged: true });
    } else {
      for (let i = 0; i < 3; i++)
        await cycle.onGitHub({
          kind: "review",
          pr: run.pr_number,
          state: "changes_requested",
          body: "The hidden tests still fail.",
          reviewer: "replay",
        });
    }
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const url = process.env.ACDC_DATABASE_URL;
  if (!url) throw new Error("ACDC_DATABASE_URL is not set");
  const store = Store.connect(url);
  await store.pool.query("drop table if exists events, deliveries, runs, issues cascade");
  await store.migrate();
  await replay(store, process.argv[2] ?? "sonnet-repo");
  await store.close();
}
