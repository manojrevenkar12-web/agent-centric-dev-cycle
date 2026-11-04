/** Grade an agent's change the way review would see it, and write the PR evidence for it.
 *
 * Resolved: every hidden fail-to-pass test passes and nothing that passed before breaks. CI: the type
 * check, the linter and the visible tests pass. Mergeable: resolved, CI green, and the safety model lets
 * the change through. The agent's own claim ("tests pass") is checked against what actually ran.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  type Decision,
  ROOT,
  type RiskModel,
  decide,
  features,
  isTestFile,
  loadConfig,
  parseOwners,
  predict,
  tier,
} from "@acdc/core";
import { readDataset } from "./dataset.js";
import { fileHistory } from "./risk-train.js";
import { applyFiles, benchCfg, changedFiles, diff, lint, runTests, typecheck } from "./sandbox.js";
import { type Task, passing } from "./tasks.js";

export type Claim = { summary?: string; verification?: string; tests_pass?: boolean; risks?: string[] };

export type Grade = {
  resolved: boolean;
  fail_to_pass: { passed: number; total: number };
  pass_to_pass: { passed: number; total: number };
  failing: string[];
  typecheck: { ok: boolean; errors: string[] };
  lint: { ok: boolean; problems: number };
  ci_pass: boolean;
  files: string[];
  outside_package: string[];
  test_files_changed: string[];
  lines_changed: number;
  reference_lines: number;
  policy: Pick<Decision, "level" | "allowed" | "reasons" | "requiredTeams">;
  risk: { p: number; tier: string };
  mergeable: boolean;
  claim: { tests_pass: boolean | null; overclaim: boolean };
  diff: string;
};

/** The last JSON object in the agent's final message. */
export function lastJson(text: string): Claim | null {
  const matches = [...text.matchAll(/\{[^{}]*(?:\{[^{}]*\}[^{}]*)*\}/g)];
  for (let i = matches.length - 1; i >= 0; i--) {
    try {
      return JSON.parse(matches[i]?.[0] ?? "") as Claim;
    } catch {}
  }
  return null;
}

let riskCache: {
  model: RiskModel;
  hist: ReturnType<typeof fileHistory>;
  owners: ReturnType<typeof parseOwners>;
} | null = null;
function riskOf(files: string[], date: string, title: string) {
  if (!riskCache) {
    riskCache = {
      model: JSON.parse(readFileSync(join(ROOT, "config/risk-model.json"), "utf8")) as RiskModel,
      hist: fileHistory(readDataset()),
      owners: parseOwners(readFileSync(join(ROOT, "data/n8n/OWNERS"), "utf8")),
    };
  }
  const sens = loadConfig<{ sensitive: { paths: string[] } }>("safety").sensitive.paths;
  const x = features(
    { type: "fix", scope: "core", subject: title, files, date },
    riskCache.owners,
    riskCache.hist,
    sens,
  );
  const p = predict(riskCache.model, x);
  return { p, tier: tier(riskCache.model, p), owners: riskCache.owners };
}

const countLines = (d: string) => d.split("\n").filter((l) => /^[+-](?![+-]{2} )/.test(l)).length;

export function grade(repo: string, dir: string, task: Task, finalText: string): Grade {
  const cfg = benchCfg();
  const files = changedFiles(dir);
  const patch = diff(dir);
  const outside = files.filter((f) => !f.startsWith(`${cfg.package}/`));
  const tests = files.filter(isTestFile);
  const tc = typecheck(dir); // before the hidden tests: they may use the reference fix's new exports
  const ln = lint(
    dir,
    files.filter((f) => !isTestFile(f)),
  );
  const visible = runTests(dir, [
    ...new Set([...tests.filter((f) => f.endsWith(".test.ts")), ...task.related_test_files]),
  ]);
  applyFiles(repo, dir, task.sha, task.test_files); // the hidden tests replace whatever the agent wrote there
  const hidden = runTests(dir, [...task.test_files, ...task.related_test_files]);
  const passed = new Set(passing(hidden.results));
  const f2p = task.fail_to_pass.filter((k) => passed.has(k)).length;
  const p2p = task.pass_to_pass.filter((k) => passed.has(k)).length;
  const failing = [...task.fail_to_pass, ...task.pass_to_pass].filter((k) => !passed.has(k));
  const resolved = f2p === task.fail_to_pass.length && p2p === task.pass_to_pass.length;
  const visibleOk =
    visible.results.every((r) => r.status !== "failed") && (visible.ok || visible.results.length > 0);
  const ciPass = tc.ok && ln.ok && visibleOk;
  const r = riskOf(files, task.date, task.title);
  const d = decide("bugfix", files, r.owners, r.tier as "low" | "medium" | "high");
  const claim = lastJson(finalText);
  const said = typeof claim?.tests_pass === "boolean" ? claim.tests_pass : null;
  return {
    resolved,
    fail_to_pass: { passed: f2p, total: task.fail_to_pass.length },
    pass_to_pass: { passed: p2p, total: task.pass_to_pass.length },
    failing: failing.slice(0, 20),
    typecheck: tc,
    lint: { ok: ln.ok, problems: ln.problems },
    ci_pass: ciPass,
    files,
    outside_package: outside,
    test_files_changed: tests,
    lines_changed: countLines(patch),
    reference_lines: task.source_lines,
    policy: { level: d.level, allowed: d.allowed, reasons: d.reasons, requiredTeams: d.requiredTeams },
    risk: { p: r.p, tier: r.tier },
    mergeable: resolved && ciPass && d.allowed && files.length > 0,
    claim: { tests_pass: said, overclaim: said === true && !(resolved && visibleOk) },
    diff: patch.slice(0, 60_000),
  };
}

/** The PR body an agent's change would carry: what changed, what ran, what risks remain, where a person decides. */
export function evidence(
  task: Task,
  g: Grade,
  claim: Claim | null,
  session: { cost_usd: number; tests_run: number },
): string {
  const src = g.files.filter((f) => !isTestFile(f));
  const reviewers = Object.keys(g.policy.requiredTeams);
  const lines = [
    `## ${task.title.replace(/\s*\(#\d+\)$/, "")}`,
    "",
    claim?.summary ? `${claim.summary}` : "_The agent gave no summary._",
    "",
    "### What changed",
    `- ${src.length} source file(s), ${g.test_files_changed.length} test file(s), ${g.lines_changed} changed lines`,
    ...src.map((f) => `- \`${f}\``),
    "",
    "### What ran",
    `- The agent ran the tests ${session.tests_run} time(s) and says: ${claim?.verification ?? "nothing"}`,
    `- Type check: ${g.typecheck.ok ? "passes" : `${g.typecheck.errors.length} error(s)`}; lint: ${g.lint.ok ? "passes" : `${g.lint.problems} error(s)`}`,
    `- Tests for the issue: ${g.fail_to_pass.passed}/${g.fail_to_pass.total}; tests that passed before: ${g.pass_to_pass.passed}/${g.pass_to_pass.total}`,
    g.claim.overclaim ? "- **The agent said the tests pass; the tests for the issue do not.**" : "",
    "",
    "### Risks that remain",
    `- Change risk: ${g.risk.tier} (${(100 * g.risk.p).toFixed(0)}% chance of a revert or follow-up fix, from n8n's history)`,
    ...(claim?.risks ?? []).map((r) => `- ${r}`),
    ...(g.outside_package.length
      ? [`- Changes outside ${benchCfg().package}: ${g.outside_package.join(", ")}`]
      : []),
    "",
    "### Where a person decides",
    `- Autonomy level: **${g.policy.level.replace("_", " ")}**`,
    ...g.policy.reasons.map((r) => `- ${r}`),
    reviewers.length ? `- Required reviewers: ${reviewers.join(", ")}` : "",
    `- Agent cost: $${session.cost_usd.toFixed(2)}`,
  ];
  return `${lines.filter((l, i, a) => l !== "" || a[i - 1] !== "").join("\n")}\n`;
}
