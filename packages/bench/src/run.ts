/** Run the benchmark: every setup (model x context) on every task, each in its own sandbox, within a
 * total spend cap kept in a ledger. A setup's result for a task is written once to reports/runs/ and
 * never rerun unless asked (`--force`), so the numbers in the report are first attempts. */
import { appendFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ROOT, loadConfig } from "@acdc/core";
import { type Session, runAgent, writeWrappers } from "./agent.js";
import { type Grade, evidence, grade, lastJson } from "./grade.js";
import { benchCfg, checkout, remove } from "./sandbox.js";
import { type Task, readTasks } from "./tasks.js";

export type Setup = { name: string; model: string; context: "bare" | "repo" };
type RunCfg = { setups: Setup[]; budget_per_run_usd: number; total_cap_usd: number; timeout_s: number };
export type RunResult = {
  task: string;
  setup: string;
  model: string;
  context: string;
  session: Session;
  grade: Grade | null;
  evidence: string;
};

export const RUNS = join(ROOT, "reports/runs");
const LEDGER = join(ROOT, "reports/runs/ledger.jsonl");

export function spent(): number {
  if (!existsSync(LEDGER)) return 0;
  return readFileSync(LEDGER, "utf8")
    .split("\n")
    .filter(Boolean)
    .reduce((s, l) => s + Number(JSON.parse(l).cost_usd ?? 0), 0);
}

/** n8n's agent instructions are part of the repository; the bare setup removes them. */
export const CONTEXT_FILES = [
  "AGENTS.md",
  "CLAUDE.md",
  "packages/workflow/AGENTS.md",
  "packages/workflow/CLAUDE.md",
];

export function prompt(task: Task): string {
  return `You are an engineer at n8n working on a Linear issue in the n8n monorepo, which is checked out here (only ${benchCfg().package} is present).

Issue: ${task.statement}

Fix it in ${benchCfg().package}, the way you would for a real pull request:
- find the cause and make the smallest change that fixes it; add or update tests for it;
- verify your change: \`acdc-test <test files>\` runs the package's vitest tests (no network), \`acdc-typecheck\` type-checks the package;
- \`git status\` and \`git diff\` are available. No other commands are.

When you are done, end your reply with one JSON object on its own line:
{"summary": "what you changed and why", "verification": "what you ran and what it showed", "tests_pass": true or false, "risks": ["what a reviewer should look at"]}
`;
}

export async function runOne(repo: string, task: Task, setup: Setup, cfg: RunCfg): Promise<RunResult> {
  const name = `${setup.name}-${task.id}`;
  const dir = checkout(repo, task.base, name);
  const bin = join(benchCfg().work_dir, `${name}-bin`);
  try {
    if (setup.context === "bare") for (const f of CONTEXT_FILES) rmSync(join(dir, f), { force: true });
    writeWrappers(bin, dir);
    const session = await runAgent({
      prompt: prompt(task),
      cwd: dir,
      binDir: bin,
      model: setup.model,
      budget: cfg.budget_per_run_usd,
      timeoutS: cfg.timeout_s,
      transcript: join(ROOT, "runs", setup.name, `${task.id}.jsonl`),
    });
    // the context files we removed are not part of the agent's change
    const g = grade(repo, dir, task, session.result);
    if (setup.context === "bare") {
      g.files = g.files.filter((f) => !CONTEXT_FILES.includes(f));
      g.outside_package = g.outside_package.filter((f) => !CONTEXT_FILES.includes(f));
    }
    const ev = evidence(task, g, lastJson(session.result), session);
    return {
      task: task.id,
      setup: setup.name,
      model: setup.model,
      context: setup.context,
      session,
      grade: g,
      evidence: ev,
    };
  } finally {
    remove(repo, dir);
    rmSync(bin, { recursive: true, force: true });
  }
}

export async function runBench(repo: string, args: string[]) {
  const cfg = loadConfig<{ run: RunCfg }>("bench").run;
  const only = args.find((a) => a.startsWith("--setup="))?.split("=")[1];
  const limit = Number(args.find((a) => a.startsWith("--tasks="))?.split("=")[1] ?? Number.POSITIVE_INFINITY);
  const force = args.includes("--force");
  const tasks = readTasks().slice(0, limit);
  mkdirSync(RUNS, { recursive: true });
  for (const setup of cfg.setups.filter((s) => !only || s.name === only)) {
    mkdirSync(join(RUNS, setup.name), { recursive: true });
    for (const task of tasks) {
      const out = join(RUNS, setup.name, `${task.id}.json`);
      if (existsSync(out) && !force) continue;
      if (spent() + cfg.budget_per_run_usd > cfg.total_cap_usd) {
        console.log(`spend cap reached ($${spent().toFixed(2)} of $${cfg.total_cap_usd}); stopping`);
        return;
      }
      const r = await runOne(repo, task, setup, cfg);
      writeFileSync(out, `${JSON.stringify(r, null, 1)}\n`);
      appendFileSync(
        LEDGER,
        `${JSON.stringify({ at: new Date().toISOString(), setup: setup.name, task: task.id, cost_usd: r.session.cost_usd })}\n`,
      );
      const g = r.grade;
      console.log(
        `${setup.name} ${task.id}: ${g?.resolved ? "resolved" : "not resolved"}, ci ${g?.ci_pass ? "green" : "red"}, ${g?.policy.level}, $${r.session.cost_usd.toFixed(2)}, ${r.session.seconds}s${r.session.error ? ` (${r.session.error})` : ""}`,
      );
    }
  }
}
