/** Benchmark tasks from real n8n fixes, the way SWE-bench builds them: the task starts at the fix's
 * parent commit, the fix's own tests are hidden, and a task counts only if those tests fail before the
 * fix and pass after it in our sandbox. Tests that already fail at the fix commit are left out, so an
 * agent is never graded on the environment.
 */
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { ROOT, isTestFile, loadConfig } from "@acdc/core";
import { type TestResult, applyFiles, benchCfg, checkout, remove, runTests } from "./sandbox.js";

export type Task = {
  id: string;
  pr: number;
  sha: string; // the fix
  base: string; // its parent: where the agent starts
  date: string;
  title: string;
  statement: string; // what the agent is told
  source_files: string[]; // what the fix changed (the reference solution's scope)
  source_lines: number;
  test_files: string[]; // hidden: the fix's tests
  related_test_files: string[]; // visible tests that import a changed module
  fail_to_pass: string[];
  pass_to_pass: string[];
  validation: { base_failed: number; fix_passed: number; seconds: number };
};

export const TASKS = join(ROOT, "data/tasks/tasks.json");
export const STATEMENTS = join(ROOT, "data/tasks/statements.json");

type Mining = {
  since: string;
  max_source_files: number;
  max_source_lines: number;
  require_tests_in: string;
  limit: number;
};

const git = (repo: string, args: string[]) =>
  execFileSync("git", ["-C", repo, ...args], { encoding: "utf8", maxBuffer: 256 * 1024 * 1024 });

export type Candidate = {
  sha: string;
  date: string;
  title: string;
  pr: number;
  source: string[];
  tests: string[];
  lines: number;
};

export function candidates(repo: string): Candidate[] {
  const cfg = benchCfg();
  const m = loadConfig<{ mining: Mining }>("bench").mining;
  const raw = git(repo, [
    "log",
    "--first-parent",
    `--since=${m.since}`,
    "--format=@@%H%x09%aI%x09%s",
    "--numstat",
    "HEAD",
    "--",
    cfg.package,
  ]);
  const out: Candidate[] = [];
  for (const block of raw.split("@@").filter(Boolean)) {
    const [head, ...rows] = block.split("\n");
    const [sha, date, title] = (head ?? "").split("\t");
    if (!sha || !date || !title || !/^fix(\(|:)/.test(title)) continue;
    const pr = Number(title.match(/\(#(\d+)\)\s*$/)?.[1] ?? 0);
    const files = rows
      .filter(Boolean)
      .map((r) => r.split("\t"))
      .map(([a, d, f]) => ({ f: f ?? "", n: (Number(a) || 0) + (Number(d) || 0) }));
    // the whole commit, not only the package: a fix that also changed other packages is out of scope
    const all = git(repo, ["show", "--name-only", "--format=", sha]).split("\n").filter(Boolean);
    const source = all.filter(
      (f) => !isTestFile(f) && !f.endsWith(".md") && !/CHANGELOG|package\.json$/.test(f),
    );
    const tests = all.filter((f) => f.startsWith(m.require_tests_in) && f.endsWith(".test.ts"));
    const lines = files.filter((x) => source.includes(x.f)).reduce((s, x) => s + x.n, 0);
    if (!pr || !tests.length || !source.length) continue;
    if (source.some((f) => !f.startsWith(`${cfg.package}/src/`))) continue;
    if (source.length > m.max_source_files || lines > m.max_source_lines) continue;
    out.push({ sha, date, title, pr, source, tests, lines });
  }
  return out.slice(0, m.limit);
}

/** Test files in the package that import one of the changed modules (at the fix commit). */
export function relatedTests(repo: string, sha: string, source: string[], hidden: string[]): string[] {
  const cfg = benchCfg();
  const testFiles = git(repo, ["ls-tree", "-r", "--name-only", sha, `${cfg.package}/test/`])
    .split("\n")
    // fuzz and corpus suites take minutes each and test the whole engine, not the change
    .filter((f) => f.endsWith(".test.ts") && !hidden.includes(f) && !/fuzz|corpus/.test(f));
  const mods = source.map((f) => basename(f).replace(/\.ts$/, "")).filter((m) => m !== "index");
  const hits: string[] = [];
  for (const f of testFiles) {
    const text = git(repo, ["show", `${sha}:${f}`]);
    if (
      mods.some((m) =>
        new RegExp(`from ['"][^'"]*/${m.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}['"]`).test(text),
      )
    )
      hits.push(f);
  }
  return hits.slice(0, 6);
}

const key = (r: TestResult) => `${r.file} :: ${r.name}`;

/** Tests that passed everywhere they ran: an engine test runs once per engine project, and a failure in
 * any project is a failure. */
export function passing(results: TestResult[]): string[] {
  const failed = new Set(results.filter((r) => r.status === "failed").map(key));
  return [...new Set(results.filter((r) => r.status === "passed").map(key))].filter((k) => !failed.has(k));
}

export function validate(repo: string, c: Candidate): Task | { id: string; rejected: string } {
  const id = `n8n-${c.pr}`;
  const base = git(repo, ["rev-parse", `${c.sha}^`]).trim();
  const related = relatedTests(repo, c.sha, c.source, c.tests);
  const dir = checkout(repo, base, `validate-${id}`);
  try {
    applyFiles(repo, dir, c.sha, [...c.tests, ...related]); // the fix's tests, on the code before the fix
    const before = runTests(dir, [...c.tests, ...related]);
    applyFiles(repo, dir, c.sha, c.source);
    const after = runTests(dir, [...c.tests, ...related]);
    const passedBefore = new Set(passing(before.results));
    const passedAfter = passing(after.results);
    const f2p = passedAfter.filter((k) => !passedBefore.has(k));
    const p2p = passedAfter.filter((k) => passedBefore.has(k));
    if (!after.results.length)
      return { id, rejected: `no tests ran after the fix: ${after.error.slice(0, 300)}` };
    if (!f2p.length) return { id, rejected: "the fix's tests already pass before the fix" };
    const hiddenF2p = f2p.filter((k) => c.tests.some((t) => k.startsWith(`${t} ::`)));
    if (!hiddenF2p.length) return { id, rejected: "only related tests changed outcome" };
    return {
      id,
      pr: c.pr,
      sha: c.sha,
      base,
      date: c.date,
      title: c.title,
      statement: "",
      source_files: c.source,
      source_lines: c.lines,
      test_files: c.tests,
      related_test_files: related,
      fail_to_pass: f2p,
      pass_to_pass: p2p,
      validation: {
        base_failed: before.results.filter((r) => r.status === "failed").length,
        fix_passed: passedAfter.length,
        seconds: Math.round(before.seconds + after.seconds),
      },
    };
  } finally {
    remove(repo, dir);
  }
}

export async function mineTasks(repo: string, args: string[]) {
  mkdirSync(join(ROOT, "data/tasks"), { recursive: true });
  const cands = candidates(repo);
  const want = Number(args[0] ?? cands.length);
  const tasks: Task[] = [];
  const rejected: { id: string; title: string; rejected: string }[] = [];
  for (const c of cands) {
    if (tasks.length >= want) break;
    const cache = join(ROOT, "data/tasks/validation", `n8n-${c.pr}.json`);
    let r: Task | { id: string; rejected: string };
    if (existsSync(cache)) r = JSON.parse(readFileSync(cache, "utf8"));
    else {
      r = validate(repo, c);
      mkdirSync(dirname(cache), { recursive: true });
      writeFileSync(cache, `${JSON.stringify(r, null, 1)}\n`);
    }
    if (!("rejected" in r) && r.validation.base_failed === 0)
      // nothing failed before the fix: the hidden test file did not even load, because it imports names
      // only the fix adds. An agent cannot guess those names, so the task would grade the guess.
      r = { id: r.id, rejected: "the hidden tests do not load before the fix (they import names the fix adds)" };
    if (!("rejected" in r)) {
      r.fail_to_pass = [...new Set(r.fail_to_pass)];
      r.pass_to_pass = [...new Set(r.pass_to_pass)].filter((k) => !r.fail_to_pass.includes(k));
    }
    if ("rejected" in r) rejected.push({ id: r.id, title: c.title, rejected: r.rejected });
    else tasks.push(r);
    console.log(`${"rejected" in r ? "✗" : "✓"} ${c.title}${"rejected" in r ? ` — ${r.rejected}` : ""}`);
  }
  let statements: Record<string, string> = {};
  try {
    statements = JSON.parse(readFileSync(STATEMENTS, "utf8"));
  } catch {}
  for (const t of tasks) t.statement = statements[t.id] ?? statementOf(t.title);
  writeFileSync(TASKS, `${JSON.stringify({ candidates: cands.length, tasks, rejected }, null, 1)}\n`);
  console.log(`${tasks.length} tasks, ${rejected.length} rejected`);
}

/** The issue an agent gets: the pull request's title without its commit type, scope, PR number or
 * changelog marker, the way a short Linear ticket reads. */
export function statementOf(title: string): string {
  const s = title
    .replace(/^[a-z]+(\([^)]*\))?!?:\s*/, "")
    .replace(/\s*\(#\d+\)\s*$/, "")
    .replace(/\s*\(no-changelog\)/i, "")
    .trim();
  return s.charAt(0).toUpperCase() + s.slice(1);
}

export function readTasks(): Task[] {
  return (JSON.parse(readFileSync(TASKS, "utf8")) as { tasks: Task[] }).tasks;
}
