/** Isolated checkouts of n8n for one task: a sparse git worktree at a commit, with the installed
 * dependencies linked in read-only, and test runs without network (a new user and network namespace).
 *
 * The agent works in this checkout and nowhere else: its file tools are confined to it, its shell can
 * run only the wrapper commands written next to it, and it starts with an empty environment.
 */
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { isTestFile, loadConfig } from "@acdc/core";

export type BenchCfg = {
  package: string; // the package under test, e.g. packages/workflow
  sparse: string[];
  skip_projects: string[]; // vitest projects not run (the isolated-vm engine needs a native build)
  envs: { from: string; dir: string }[]; // installed dependency trees by era; "" is the repository itself
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

/** The installed dependencies that fit a commit: the newest environment installed at or before it.
 * Dependencies change over months (a package removed, a test runner upgraded), so one install cannot
 * run the whole history; validation shows which tasks an environment can run. */
export function envFor(repo: string, sha: string): string {
  const date = git(repo, ["show", "-s", "--format=%cI", sha]).trim();
  const envs = [...benchCfg().envs].sort((a, b) => a.from.localeCompare(b.from));
  let dir = repo;
  for (const e of envs) if (e.from <= date) dir = e.dir || repo;
  return dir;
}

/** A fresh sparse worktree at `sha`, with the dependencies of its era linked in. */
export function checkout(repo: string, sha: string, name: string): string {
  const cfg = benchCfg();
  const dir = join(cfg.work_dir, name);
  remove(repo, dir);
  mkdirSync(dirname(dir), { recursive: true });
  git(repo, ["worktree", "prune"]);
  git(repo, ["worktree", "add", "-f", "--detach", "--no-checkout", dir, sha]);
  git(dir, ["sparse-checkout", "set", "--cone", ...cfg.sparse]);
  git(dir, ["checkout", "--quiet", sha]);
  const env = envFor(repo, sha);
  for (const nm of ["node_modules", join(cfg.package, "node_modules")]) {
    const target = join(env, nm);
    if (existsSync(target) && !existsSync(join(dir, nm))) symlinkSync(target, join(dir, nm));
  }
  return dir;
}

/** The vitest projects the checkout's own config defines, less the ones we cannot run. */
export function projectsFor(dir: string): string[] {
  const cfg = benchCfg();
  const text = readFileSync(join(dir, cfg.package, "vitest.config.ts"), "utf8");
  const names = [
    ...[...text.matchAll(/name:\s*['"]([\w-]+)['"]/g)].map((m) => m[1] as string),
    ...[...text.matchAll(/engineProject\(\s*['"](\w+)['"]\s*\)/g)].map((m) => `${m[1]}-engine`),
  ];
  return [...new Set(names)].filter((n) => !cfg.skip_projects.includes(n));
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
  if (!files.length) throw new Error("runTests needs test files: without them vitest runs the whole suite");
  const cfg = benchCfg();
  const pkg = join(dir, cfg.package);
  const out = join(dir, ".acdc-vitest.json");
  rmSync(out, { force: true });
  const rel = files.map((f) => f.replace(`${cfg.package}/`, ""));
  const t0 = Date.now();
  const [bin, ...args] = isolate([
    join(pkg, "node_modules/.bin/vitest"),
    "run",
    ...projectsFor(dir).flatMap((p) => ["--project", p]),
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
  // the package's own TypeScript, or the workspace root's where the package does not install one
  const own = join(pkg, "node_modules/.bin/tsc");
  const tsc = existsSync(own) ? own : join(dir, "node_modules/.bin/tsc");
  const r = spawnSync(tsc, ["--noEmit", "-p", "tsconfig.json"], {
    cwd: pkg,
    encoding: "utf8",
    timeout: 300_000,
    env: { PATH: process.env.PATH ?? "", HOME: "/tmp" },
  });
  const errors = `${r.stdout}${r.stderr}`.split("\n").filter((l) => /error TS\d+/.test(l));
  return { ok: r.status === 0, errors: errors.slice(0, 300) };
}

/** Lint the changed files with n8n's oxlint config. */
/** Lint the changed files with n8n's oxlint config, as installed in the main checkout (`repo`): older
 * environments do not have the linter's plugins built, and today's rules apply to every setup alike. */
export function lint(
  dir: string,
  files: string[],
  repo: string,
): { ok: boolean; problems: number; output: string; errors: string[] } {
  const cfg = benchCfg();
  const pkg = join(dir, cfg.package);
  const abs = files
    .filter((f) => f.startsWith(`${cfg.package}/`) && f.endsWith(".ts"))
    .map((f) => join(dir, f));
  if (!abs.length) return { ok: true, problems: 0, output: "", errors: [] };
  const own = join(repo, cfg.package);
  const r = spawnSync(join(own, "node_modules/.bin/oxlint"), ["-c", join(own, "oxlint.config.mts"), ...abs], {
    cwd: pkg,
    encoding: "utf8",
    timeout: 120_000,
    env: { PATH: process.env.PATH ?? "", HOME: "/tmp" },
  });
  const out = `${r.stdout}${r.stderr}`;
  const problems = out.split("\n").filter((l) => /: error /.test(l)).length;
  const errors = out
    .split("\n")
    .filter((l) => /: error /.test(l))
    .map((l) => l.replace(`${dir}/`, ""));
  return {
    ok: r.status === 0 && problems === 0,
    problems: problems || (r.status === 0 ? 0 : 1),
    output: out.slice(-2000),
    errors,
  };
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

/** An error without its position, so the same error before and after an edit compares equal. */
export const errorKey = (e: string) => e.replace(/\(\d+,\d+\)/, "").replace(/:\d+:\d+:/, ":");

/** Type check and lint with the change, and the same checks on the commit it started from: only errors
 * the change introduced count against it. Some old commits do not type-check against today's
 * dependencies, and an agent is not graded on that. */
export function checksAgainstBase(dir: string, files: string[], repo: string) {
  const src = files.filter((f) => !isTestFile(f));
  const after = { tc: typecheck(dir), ln: lint(dir, src, repo) };
  const saved = new Map(files.map((f) => [f, existsSync(join(dir, f)) ? readFileSync(join(dir, f)) : null]));
  for (const f of files) {
    try {
      writeFileSync(join(dir, f), git(dir, ["show", `HEAD:${f}`]));
    } catch {
      rmSync(join(dir, f), { force: true }); // new in the change
    }
  }
  const before = {
    tc: typecheck(dir),
    ln: lint(
      dir,
      src.filter((f) => existsSync(join(dir, f))),
      repo,
    ),
  };
  for (const [f, c] of saved) {
    if (c === null) rmSync(join(dir, f), { force: true });
    else {
      mkdirSync(dirname(join(dir, f)), { recursive: true });
      writeFileSync(join(dir, f), c);
    }
  }
  const fresh = (a: string[], b: string[]) => {
    const old = new Set(b.map(errorKey));
    return a.filter((e) => !old.has(errorKey(e)));
  };
  const tcNew = fresh(after.tc.errors, before.tc.errors);
  const lnNew = fresh(after.ln.errors, before.ln.errors);
  return {
    typecheck: {
      ok: tcNew.length === 0 && (after.tc.ok || after.tc.errors.length > 0),
      errors: tcNew.slice(0, 30),
      preexisting: before.tc.errors.length,
    },
    // n8n's type-aware lint needs tsgolint, which older eras' installs do not have: say so, do not pass it
    lint: /tsgolint/i.test(after.ln.output)
      ? { ok: true, problems: 0, preexisting: 0, unavailable: true }
      : { ok: lnNew.length === 0, problems: lnNew.length, preexisting: before.ln.errors.length },
  };
}
