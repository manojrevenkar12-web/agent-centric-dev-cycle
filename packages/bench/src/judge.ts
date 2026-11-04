/** Why a run failed, read by a model that sees what a senior reviewer would: the issue, the fix n8n
 * merged, the agent's change and the hidden tests that still fail. Hidden tests say whether a change
 * matches the merged fix; they cannot say whether a different change would also have been accepted,
 * or whether the issue gave the agent enough to go on. The judge's verdicts are reported next to the
 * tests, never instead of them.
 *
 *   pnpm acdc judge            judges every run that has a change and no verdict yet
 */
import { execFileSync, spawn } from "node:child_process";
import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { isTestFile, loadConfig } from "@acdc/core";
import { lastJson } from "./grade.js";
import { RUNS, type RunResult } from "./run.js";
import { type Task, readTasks } from "./tasks.js";

export const VERDICTS = ["solves", "partial", "wrong"] as const;
export const CAUSES = ["missed_case", "wrong_cause", "underspecified", "tests_too_strict", "none"] as const;
export type Verdict = {
  verdict: (typeof VERDICTS)[number]; // does the agent's change solve the issue as stated?
  cause: (typeof CAUSES)[number]; // why the hidden tests fail, when they do
  reviewer_would_accept: boolean;
  reason: string;
  model: string;
  cost_usd: number;
};

type JudgeCfg = { model: string; budget_usd: number };

export function judgePrompt(task: Task, refDiff: string, agentDiff: string, failing: string[]): string {
  return `You review a pull request for n8n. Answer only with one JSON object.

The issue the engineer was given:
${task.statement}

The fix n8n merged for it (source files only):
\`\`\`diff
${refDiff.slice(0, 20_000)}
\`\`\`

The engineer's change:
\`\`\`diff
${agentDiff.slice(0, 20_000)}
\`\`\`

Hidden tests from the merged fix that still fail on the engineer's change:
${failing.length ? failing.map((f) => `- ${f}`).join("\n") : "- none"}

Decide:
- "verdict": "solves" if the change fixes the issue as stated, "partial" if it fixes part of it, "wrong" if it does not.
- "cause": why the hidden tests fail: "missed_case" (a case the issue implies was not handled), "wrong_cause" (the change does not address the real cause), "underspecified" (the tests need a name, value or behaviour the issue does not mention and the code does not suggest), "tests_too_strict" (the change is a valid fix the tests reject for incidental reasons), or "none" if no test fails.
- "reviewer_would_accept": would a careful n8n reviewer approve this change for this issue as it is?
- "reason": one or two sentences.

{"verdict": "...", "cause": "...", "reviewer_would_accept": true, "reason": "..."}`;
}

function ask(
  model: string,
  budget: number,
  prompt: string,
): Promise<{ text: string; cost: number; model: string }> {
  return new Promise((resolve, reject) => {
    const p = spawn(
      process.env.ACDC_AGENT_BIN ?? "claude",
      [
        "-p",
        "--model",
        model,
        "--output-format",
        "json",
        "--tools",
        "",
        "--max-budget-usd",
        budget.toFixed(2),
        "--no-session-persistence",
        "--strict-mcp-config",
        "--setting-sources",
        "project",
      ],
      {
        env: { HOME: process.env.HOME ?? "/root", PATH: process.env.PATH ?? "" },
        cwd: "/tmp",
        stdio: ["pipe", "pipe", "pipe"],
      },
    );
    let out = "";
    p.stdout.on("data", (d: Buffer) => {
      out += d.toString();
    });
    p.on("close", () => {
      try {
        const j = JSON.parse(out) as {
          result?: string;
          total_cost_usd?: number;
          modelUsage?: Record<string, unknown>;
        };
        resolve({
          text: j.result ?? "",
          cost: Number(j.total_cost_usd ?? 0),
          model: Object.keys(j.modelUsage ?? {})[0] ?? model,
        });
      } catch (e) {
        reject(new Error(`judge gave no JSON: ${out.slice(0, 300)} ${e}`));
      }
    });
    p.stdin.end(prompt);
  });
}

export async function judgeAll(repo: string) {
  const cfg = loadConfig<{ judge: JudgeCfg }>("bench").judge;
  const tasks = new Map(readTasks().map((t) => [t.id, t]));
  for (const setup of readdirSync(RUNS, { withFileTypes: true }).filter((d) => d.isDirectory())) {
    for (const f of readdirSync(join(RUNS, setup.name)).filter((x) => x.endsWith(".json"))) {
      const path = join(RUNS, setup.name, f);
      const r = JSON.parse(readFileSync(path, "utf8")) as RunResult & { judge?: Verdict };
      const task = tasks.get(r.task);
      if (r.judge || !task || !r.grade?.diff) continue;
      const ref = execFileSync("git", ["-C", repo, "diff", task.base, task.sha, "--", ...task.source_files], {
        encoding: "utf8",
      });
      const agentSrc = r.grade.diff
        .split(/^(?=diff --git )/m)
        .filter((h) => !isTestFile(h.match(/^diff --git a\/(\S+)/)?.[1] ?? ""))
        .join("");
      const a = await ask(
        cfg.model,
        cfg.budget_usd,
        judgePrompt(task, ref, agentSrc || r.grade.diff, r.grade.failing),
      );
      const j = lastJson(a.text) as Partial<Verdict> | null;
      if (!j || !VERDICTS.includes(j.verdict as Verdict["verdict"])) {
        console.log(`${setup.name} ${r.task}: no verdict`);
        continue;
      }
      r.judge = {
        verdict: j.verdict as Verdict["verdict"],
        cause: (CAUSES.includes(j.cause as Verdict["cause"]) ? j.cause : "none") as Verdict["cause"],
        reviewer_would_accept: !!j.reviewer_would_accept,
        reason: String(j.reason ?? "").slice(0, 600),
        model: a.model,
        cost_usd: a.cost,
      };
      writeFileSync(path, `${JSON.stringify(r, null, 1)}\n`);
      console.log(
        `${setup.name} ${r.task}: ${r.judge.verdict}, ${r.judge.cause}, accept ${r.judge.reviewer_would_accept}`,
      );
    }
  }
}
