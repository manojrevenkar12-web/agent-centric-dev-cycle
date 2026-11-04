/** Run the benchmark: every setup (model x context) on every task, each in its own sandbox, within a
 * total spend cap kept in a ledger. A setup's result for a task is written once to reports/runs/ and
 * never rerun unless asked (`--force`), so the numbers in the report are first attempts. */
import { execFileSync } from "node:child_process";
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { ROOT, loadConfig } from "@acdc/core";
import { type Session, runAgent, writeWrappers } from "./agent.js";
import { GRADER_VERSION, type Grade, evidence, grade, lastJson } from "./grade.js";
import { benchCfg, checkout, remove } from "./sandbox.js";
import { type Task, readTasks } from "./tasks.js";

export type Setup = { name: string; model: string; context: "bare" | "repo" };
type RunCfg = {
  setups: Setup[];
  budget_per_run_usd: number;
  total_cap_usd: number;
  timeout_s: number;
  concurrency: number;
};
/** The session ended without the model's answer (the CLI died, or never started). */
export const infraFailure = (s: Session) =>
  !s.ok && (s.error.startsWith("ended without a result") || s.error.startsWith("no output"));

export type RunResult = {
  task: string;
  setup: string;
  model: string;
  context: string;
  session: Session;
  grade: Grade | null;
  evidence: string;
  infra_retry?: { error: string; cost_usd: number }; // the first session ended without an answer; rerun once
  judge?: import("./judge.js").Verdict; // added later by `acdc judge`
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
- verify your change: \`acdc-test <test files>\` runs the package's vitest tests (no network), \`acdc-typecheck\` type-checks the package, \`acdc-lint <files>\` runs n8n's linter;
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
    writeWrappers(bin, dir, repo);
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
  const setups = cfg.setups.filter((s) => !only || s.name === only);
  mkdirSync(RUNS, { recursive: true });
  for (const s of setups) mkdirSync(join(RUNS, s.name), { recursive: true });
  // task by task, every setup on it, so a stopped run still leaves paired results
  const jobs = tasks
    .flatMap((task) =>
      setups.map((setup) => ({ task, setup, out: join(RUNS, setup.name, `${task.id}.json`) })),
    )
    .filter((j) => force || !existsSync(j.out));
  let inFlight = 0; // budget reserved by sessions that have not reported their cost yet
  let stop = false;
  const worker = async () => {
    for (let j = jobs.shift(); j && !stop; j = jobs.shift()) {
      if (spent() + inFlight + cfg.budget_per_run_usd > cfg.total_cap_usd) {
        console.log(`spend cap reached ($${spent().toFixed(2)} of $${cfg.total_cap_usd}); stopping`);
        stop = true;
        return;
      }
      inFlight += cfg.budget_per_run_usd;
      let r: RunResult;
      try {
        r = await runOne(repo, j.task, j.setup, cfg);
        if (infraFailure(r.session)) {
          // one rerun for a session that never reached the model's answer; both are on record
          const first = { error: r.session.error, cost_usd: r.session.cost_usd };
          appendFileSync(
            LEDGER,
            `${JSON.stringify({ at: new Date().toISOString(), setup: j.setup.name, task: j.task.id, cost_usd: first.cost_usd, infra_failure: first.error })}\n`,
          );
          r = { ...(await runOne(repo, j.task, j.setup, cfg)), infra_retry: first };
        }
      } finally {
        inFlight -= cfg.budget_per_run_usd;
      }
      writeFileSync(j.out, `${JSON.stringify(r, null, 1)}\n`);
      appendFileSync(
        LEDGER,
        `${JSON.stringify({ at: new Date().toISOString(), setup: j.setup.name, task: j.task.id, cost_usd: r.session.cost_usd })}\n`,
      );
      const g = r.grade;
      console.log(
        `${j.setup.name} ${j.task.id}: ${g?.resolved ? "resolved" : "not resolved"}, ci ${g?.ci_pass ? "green" : "red"}, ${g?.policy.level}, $${r.session.cost_usd.toFixed(2)}, ${r.session.seconds}s${r.session.error ? ` (${r.session.error})` : ""}`,
      );
    }
  };
  await Promise.all(Array.from({ length: cfg.concurrency }, worker));
}

/** Grade every stored run again with the current grader, from the change it recorded. The agents'
 * work is not rerun: each change is applied to a fresh checkout of its task's commit. Used when the
 * grader itself is fixed (version 2 compares the type check and lint with the starting commit). */
export async function regradeAll(repo: string) {
  const tasks = new Map(readTasks().map((t) => [t.id, t]));
  for (const setupDir of readdirSync(RUNS, { withFileTypes: true }).filter((d) => d.isDirectory())) {
    for (const f of readdirSync(join(RUNS, setupDir.name)).filter((x) => x.endsWith(".json"))) {
      const path = join(RUNS, setupDir.name, f);
      const r = JSON.parse(readFileSync(path, "utf8")) as RunResult;
      const task = tasks.get(r.task);
      if (!task || !r.grade || r.grade.version === GRADER_VERSION) continue;
      if (r.grade.version === 4 && r.grade.ci_pass) {
        // version 5 can only turn a red CI green; a green run's grade is the same
        r.grade.version = GRADER_VERSION;
        writeFileSync(path, `${JSON.stringify(r, null, 1)}\n`);
        continue;
      }
      if (r.grade.diff.length >= 60_000) {
        console.log(
          `${setupDir.name} ${r.task}: change too large to replay, kept grade ${r.grade.version ?? 1}`,
        );
        continue;
      }
      const dir = checkout(repo, task.base, `regrade-${setupDir.name}-${task.id}`);
      try {
        if (r.context === "bare") for (const c of CONTEXT_FILES) rmSync(join(dir, c), { force: true });
        if (r.grade.diff.trim())
          execFileSync("git", ["-C", dir, "apply", "--whitespace=nowarn", "-"], { input: r.grade.diff });
        const g = grade(repo, dir, task, r.session.result);
        if (r.context === "bare") {
          g.files = g.files.filter((x) => !CONTEXT_FILES.includes(x));
          g.outside_package = g.outside_package.filter((x) => !CONTEXT_FILES.includes(x));
        }
        const before = r.grade.resolved;
        r.grade = g;
        r.evidence = evidence(task, g, lastJson(r.session.result), r.session);
        writeFileSync(path, `${JSON.stringify(r, null, 1)}\n`);
        console.log(
          `${setupDir.name} ${r.task}: resolved ${before} -> ${g.resolved}, ci ${g.ci_pass ? "green" : "red"}`,
        );
      } finally {
        remove(repo, dir);
      }
    }
  }
}
