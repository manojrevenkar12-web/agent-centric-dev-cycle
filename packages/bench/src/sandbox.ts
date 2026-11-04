/** Isolated checkouts of n8n for one task: a sparse git worktree at a commit, with the installed
 * dependencies linked in read-only, and test runs without network (a new user and network namespace).
 *
 * The agent works in this checkout and nowhere else: its file tools are confined to it, its shell can
 * run only the wrapper commands written next to it, and it starts with an empty environment.
 */
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { loadConfig } from "@acdc/core";

export type BenchCfg = {
  package: string; // the package under test, e.g. packages/workflow
  sparse: string[];
  projects: string[]; // vitest projects to run (the isolated-vm project needs a native build)
  work_dir: string;
  test_timeout_s: number;
  network_isolation: boolean;
};

export const benchCfg = () => loadConfig<BenchCfg>("bench");

const git = (repo: string, args: string[], input?: string) =>
  execFileSync("git", ["-C", repo, ...args], {
    encoding: "utf8",
    maxBuffer: 256 * 1024 * 1024,
    input,
    stdio: ["pipe", "pipe", "pipe"],
  });

/** A fresh sparse worktree at `sha`; dependencies come from the main checkout's install. */
export function checkout(repo: string, sha: string, name: string): string {
  const cfg = benchCfg();
  const dir = join(cfg.work_dir, name);
  remove(repo, dir);
  mkdirSync(dirname(dir), { recursive: true });
  git(repo, ["worktree", "prune"]);
  git(repo, ["worktree", "add", "-f", "--detach", "--no-checkout", dir, sha]);
  git(dir, ["sparse-checkout", "set", "--cone", ...cfg.sparse]);
  git(dir, ["checkout", "--quiet", sha]);
  for (const nm of ["node_modules", join(cfg.package, "node_modules")]) {
    const target = join(repo, nm);
    if (existsSync(target) && !existsSync(join(dir, nm))) symlinkSync(target, join(dir, nm));
  }
  return dir;
}

export function remove(repo: string, dir: string) {
  if (!existsSync(dir)) return;
  try {
    git(repo, ["worktree", "remove", "--force", dir]);
  } catch {
    rmSync(dir, { recursive: true, force: true });
    git(repo, ["worktree", "prune"]);
  }
}

/** Files of `sha` written over the checkout (used to add a fix's tests, or the fix itself). */
export function applyFiles(repo: string, dir: string, sha: string, files: string[]) {
  for (const f of files) {
    const p = join(dir, f);
    let content: string | null = null;
    try {
      content = git(repo, ["show", `${sha}:${f}`]);
    } catch {
      content = null; // deleted in that commit
    }
    if (content === null) rmSync(p, { force: true });
    else {
      mkdirSync(dirname(p), { recursive: true });
      writeFileSync(p, content);
    }
  }
}

export type TestResult = { name: string; file: string; status: "passed" | "failed" | "skipped" };
export type TestRun = { ok: boolean; results: TestResult[]; error: string; seconds: number };

const isolate = (cmd: string[]) =>
  benchCfg().network_isolation ? ["unshare", "--user", "--net", "--map-root-user", ...cmd] : cmd;

/** Run vitest on some test files without network and return per-test results. */
export function runTests(dir: string, files: string[]): TestRun {
  const cfg = benchCfg();
  const pkg = join(dir, cfg.package);
  const out = join(dir, ".acdc-vitest.json");
  rmSync(out, { force: true });
  const rel = files.map((f) => f.replace(`${cfg.package}/`, ""));
  const t0 = Date.now();
  const [bin, ...args] = isolate([
    join(pkg, "node_modules/.bin/vitest"),
    "run",
    ...cfg.projects.flatMap((p) => ["--project", p]),
    "--reporter=json",
    `--outputFile=${out}`,
    "--passWithNoTests",
    ...rel,
  ]);
  const r = spawnSync(bin as string, args, {
    cwd: pkg,
    encoding: "utf8",
    timeout: cfg.test_timeout_s * 1000,
    env: {
      PATH: process.env.PATH ?? "/usr/bin:/bin",
      HOME: "/tmp",
      CI: "true",
      NODE_OPTIONS: "--max-old-space-size=3072",
    },
    maxBuffer: 64 * 1024 * 1024,
  });
  const seconds = (Date.now() - t0) / 1000;
  if (!existsSync(out))
    return { ok: false, results: [], error: `${r.error ?? ""}${(r.stderr ?? "").slice(-1500)}`, seconds };
  const j = JSON.parse(readFileSync(out, "utf8")) as {
    testResults: {
      name: string;
      message?: string;
      assertionResults: { fullName: string; status: string }[];
    }[];
  };
  const results: TestResult[] = [];
  const errors: string[] = [];
  for (const f of j.testResults) {
    const file = f.name.replace(`${pkg}/`, `${cfg.package}/`);
    if (!f.assertionResults.length && f.message) errors.push(`${file}: ${f.message.slice(0, 300)}`);
    for (const a of f.assertionResults)
      results.push({
        name: a.fullName,
        file,
        status: a.status === "passed" ? "passed" : a.status === "failed" ? "failed" : "skipped",
      });
  }
  return { ok: r.status === 0, results, error: errors.join("\n").slice(0, 3000), seconds };
}

/** Type-check the package (n8n's own tsconfig). */
export function typecheck(dir: string): { ok: boolean; errors: string[] } {
  const pkg = join(dir, benchCfg().package);
  const r = spawnSync(join(pkg, "node_modules/.bin/tsc"), ["--noEmit", "-p", "tsconfig.json"], {
    cwd: pkg,
    encoding: "utf8",
    timeout: 300_000,
    env: { PATH: process.env.PATH ?? "", HOME: "/tmp" },
  });
  const errors = `${r.stdout}${r.stderr}`.split("\n").filter((l) => /error TS\d+/.test(l));
  return { ok: r.status === 0, errors: errors.slice(0, 30) };
}

/** Lint the changed files with n8n's oxlint config. */
export function lint(dir: string, files: string[]): { ok: boolean; problems: number; output: string } {
  const cfg = benchCfg();
  const pkg = join(dir, cfg.package);
  const rel = files
    .filter((f) => f.startsWith(`${cfg.package}/`) && f.endsWith(".ts"))
    .map((f) => f.replace(`${cfg.package}/`, ""));
  if (!rel.length) return { ok: true, problems: 0, output: "" };
  const r = spawnSync(join(pkg, "node_modules/.bin/oxlint"), ["-c", "oxlint.config.mts", ...rel], {
    cwd: pkg,
    encoding: "utf8",
    timeout: 120_000,
    env: { PATH: process.env.PATH ?? "", HOME: "/tmp" },
  });
  const out = `${r.stdout}${r.stderr}`;
  const problems = out.split("\n").filter((l) => /: error /.test(l)).length;
  return { ok: r.status === 0 && problems === 0, problems: problems || (r.status === 0 ? 0 : 1), output: out.slice(-2000) };
}

/** What changed in the checkout against its commit (tracked and new files, excluding our own files). */
export function changedFiles(dir: string): string[] {
  const out = git(dir, ["status", "--porcelain", "--untracked-files=all"]);
  return out
    .split("\n")
    .filter(Boolean)
    .map((l) => l.slice(3).replace(/^.* -> /, ""))
    .filter((f) => !f.startsWith(".acdc") && !/(^|\/)node_modules$/.test(f))
    .sort();
}

export function diff(dir: string): string {
  git(dir, ["add", "-A", "--intent-to-add", "."]);
  return git(dir, [
    "diff",
    "--",
    ".",
    ":(exclude).acdc*",
    ":(exclude)node_modules",
    ":(exclude)**/node_modules",
  ]);
}
