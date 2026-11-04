/** The executor the loop service uses in production: the benchmark's sandbox, on the current main
 * branch instead of a historical commit. The agent's claim is never the check: after the agent, the
 * executor runs the tests the change touched, the type check and the linter itself. */
import { execFileSync } from "node:child_process";
import { rmSync } from "node:fs";
import { join } from "node:path";
import { isTestFile } from "@acdc/core";
import { runAgent, writeWrappers } from "./agent.js";
import { lastJson } from "./grade.js";
import { benchCfg, changedFiles, checkout, lint, remove, runTests, typecheck } from "./sandbox.js";

export type IssueLike = { key: string; title: string; body: string };

export function issuePrompt(issue: IssueLike, feedback?: string): string {
  const pkg = benchCfg().package;
  return `You are an engineer at n8n working on Linear issue ${issue.key} in the n8n monorepo, which is checked out here.

${issue.title}

${issue.body}
${feedback ? `\nA reviewer asked for changes to your pull request:\n\n${feedback}\n` : ""}
Work the way you would for a real pull request: find the cause, make the smallest change that fixes it, add or update tests.
Verify it: \`acdc-test <test files>\` runs ${pkg}'s vitest tests without network; \`acdc-typecheck\` type-checks it.
\`git status\` and \`git diff\` are available. No other commands are.

When you are done, end your reply with one JSON object on its own line:
{"summary": "...", "verification": "what you ran and what it showed", "tests_pass": true or false, "risks": ["..."]}
`;
}

export class SandboxExecutor {
  constructor(
    readonly repo: string,
    readonly opts: { model: string; budget: number; timeoutS: number; push: boolean; base: string },
  ) {}

  async run(issue: IssueLike, o: { runId: string; attempt: number; branch: string; feedback?: string }) {
    const git = (dir: string, args: string[]) =>
      execFileSync("git", ["-C", dir, ...args], { encoding: "utf8" });
    const start = o.attempt > 1 ? o.branch : this.opts.base;
    const dir = checkout(this.repo, start, `run-${o.runId}-${o.attempt}`);
    const bin = join(benchCfg().work_dir, `run-${o.runId}-bin`);
    try {
      writeWrappers(bin, dir);
      const s = await runAgent({
        prompt: issuePrompt(issue, o.feedback),
        cwd: dir,
        binDir: bin,
        model: this.opts.model,
        budget: this.opts.budget,
        timeoutS: this.opts.timeoutS,
        transcript: join(benchCfg().work_dir, "transcripts", `${o.runId}-${o.attempt}.jsonl`),
      });
      const files = changedFiles(dir);
      const tests = runTests(
        dir,
        files.filter((f) => isTestFile(f) && f.endsWith(".test.ts")),
      );
      const checks = {
        tests: tests.results.length > 0 && tests.results.every((r) => r.status !== "failed"),
        typecheck: typecheck(dir).ok,
        lint: lint(
          dir,
          files.filter((f) => !isTestFile(f)),
        ).ok,
      };
      if (files.length) {
        git(dir, ["checkout", "-B", o.branch]);
        git(dir, ["add", "-A", "--", ...files]);
        git(dir, [
          "-c",
          "user.name=acdc",
          "-c",
          "user.email=acdc@users.noreply.github.com",
          "commit",
          "-qm",
          `${issue.title}\n\n${issue.key}`,
        ]);
        if (this.opts.push)
          git(dir, [
            "push",
            "-q",
            "origin",
            `${o.branch}:${o.branch}`,
            ...(o.attempt > 1 ? [] : ["--force-with-lease"]),
          ]);
      }
      return {
        ok: s.ok,
        error: s.error,
        branch: o.branch,
        files,
        cost_usd: s.cost_usd,
        tests_run: s.tests_run,
        checks,
        claim: lastJson(s.result),
      };
    } finally {
      remove(this.repo, dir);
      rmSync(bin, { recursive: true, force: true });
    }
  }
}
