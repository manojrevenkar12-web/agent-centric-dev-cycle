import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { ALLOWED, command, parse, writeWrappers } from "../src/agent.js";
import { type Grade, evidence, lastJson } from "../src/grade.js";
import { signTest, summarise } from "../src/report.js";
import type { RunResult } from "../src/run.js";
import { prompt } from "../src/run.js";
import type { Task } from "../src/tasks.js";

const task: Task = {
  id: "n8n-1",
  pr: 1,
  sha: "f00dfeed1234abcd",
  base: "0123abcd4567",
  date: "2026-10-01T00:00:00Z",
  title: "fix(core): Keep parentheses around ?? operands (#1)",
  statement: "Expressions lose parentheses around ?? operands",
  source_files: ["packages/workflow/src/x.ts"],
  source_lines: 10,
  test_files: ["packages/workflow/test/x.test.ts"],
  related_test_files: [],
  fail_to_pass: ["packages/workflow/test/x.test.ts :: keeps them"],
  pass_to_pass: [],
  validation: { base_failed: 1, fix_passed: 1, seconds: 1 },
};

const grade = (over: Partial<Grade> = {}): Grade => ({
  resolved: true,
  fail_to_pass: { passed: 1, total: 1 },
  pass_to_pass: { passed: 0, total: 0 },
  failing: [],
  typecheck: { ok: true, errors: [] },
  lint: { ok: true, problems: 0 },
  ci_pass: true,
  files: ["packages/workflow/src/x.ts", "packages/workflow/test/x.test.ts"],
  outside_package: [],
  test_files_changed: ["packages/workflow/test/x.test.ts"],
  lines_changed: 12,
  reference_lines: 10,
  policy: {
    level: "agent_reviewed",
    allowed: true,
    reasons: ["category bugfix: at most agent_reviewed"],
    requiredTeams: {},
  },
  risk: { p: 0.12, tier: "low" },
  mergeable: true,
  claim: { tests_pass: true, overclaim: false },
  diff: "",
  ...over,
});

describe("agent session", () => {
  it("runs with least privilege and a spend cap", () => {
    const c = command("sonnet", 1.5);
    expect(c).toContain("--restricted");
    expect(c.slice(c.indexOf("--permission-mode"))[1]).toBe("dontAsk");
    expect(c.slice(c.indexOf("--setting-sources"))[1]).toBe("project");
    expect(c.slice(c.indexOf("--max-budget-usd"))[1]).toBe("1.50");
    expect(ALLOWED.filter((a) => a.startsWith("Bash"))).toEqual([
      "Bash(acdc-test:*)",
      "Bash(acdc-typecheck:*)",
      "Bash(acdc-lint:*)",
      "Bash(git status:*)",
      "Bash(git diff:*)",
      "Bash(ls:*)",
    ]);
  });

  it("reads cost, turns, test runs and denials from the stream", () => {
    const lines = [
      JSON.stringify({
        type: "assistant",
        message: {
          content: [{ type: "tool_use", name: "Bash", input: { command: "acdc-test test/x.test.ts" } }],
        },
      }),
      JSON.stringify({
        type: "assistant",
        message: { content: [{ type: "tool_use", name: "Read", input: {} }] },
      }),
      "not json",
      JSON.stringify({
        type: "result",
        subtype: "success",
        result: "done",
        total_cost_usd: 0.42,
        num_turns: 7,
        usage: { input_tokens: 10, cache_read_input_tokens: 90, output_tokens: 5 },
        permission_denials: [{}],
      }),
    ];
    expect(parse(lines)).toMatchObject({
      ok: true,
      cost_usd: 0.42,
      turns: 7,
      tool_calls: 2,
      tests_run: 1,
      denials: 1,
      tokens_in: 100,
      tokens_out: 5,
    });
  });

  it("writes test and type-check wrappers that run without network", () => {
    const bin = mkdtempSync(join(tmpdir(), "acdc-bin-"));
    writeWrappers(bin, "/work/task");
    const t = readFileSync(join(bin, "acdc-test"), "utf8");
    expect(t).toContain("unshare --user --net");
    expect(t).toContain('cd "/work/task/packages/workflow"');
    expect(t).toContain("env -i");
    expect(readFileSync(join(bin, "acdc-typecheck"), "utf8")).toContain("tsc --noEmit");
  });

  it("tells the agent the issue and how to verify, never the hidden tests", () => {
    const p = prompt(task);
    expect(p).toContain(task.statement);
    expect(p).toContain("acdc-test");
    expect(p).not.toContain("x.test.ts");
    expect(p).not.toContain(task.sha);
  });
});

describe("grading and evidence", () => {
  it("takes the agent's last JSON object", () => {
    expect(
      lastJson('I did it.\n{"a": 1}\nthen {"summary": "s", "tests_pass": true, "risks": ["r"]}'),
    ).toEqual({ summary: "s", tests_pass: true, risks: ["r"] });
    expect(lastJson("no json here")).toBeNull();
  });

  it("writes PR evidence: what changed, what ran, what risks remain, where a person decides", () => {
    const md = evidence(
      task,
      grade({ claim: { tests_pass: true, overclaim: true }, resolved: false }),
      { summary: "Fixed it", verification: "acdc-test: 3 passed", risks: ["printer edge case"] },
      { cost_usd: 0.4, tests_run: 2 },
    );
    for (const h of [
      "### What changed",
      "### What ran",
      "### Risks that remain",
      "### Where a person decides",
    ])
      expect(md).toContain(h);
    expect(md).toContain("The agent said the tests pass; the tests for the issue do not.");
    expect(md).toContain("printer edge case");
    expect(md).toContain("agent reviewed");
  });
});

describe("report", () => {
  it("computes the exact sign test", () => {
    expect(signTest(0, 0)).toBe(1);
    expect(signTest(5, 0)).toBeCloseTo(0.0625);
    expect(signTest(3, 3)).toBe(1);
  });

  it("summarises setups and pairs them by task", () => {
    const run = (setup: string, context: string, id: string, resolved: boolean): RunResult => ({
      task: id,
      setup,
      model: "m",
      context,
      session: {
        ok: true,
        error: "",
        result: "",
        cost_usd: 0.5,
        turns: 3,
        tool_calls: 4,
        tests_run: 1,
        denials: 0,
        tokens_in: 1,
        tokens_out: 1,
        seconds: 60,
        model: "m",
      },
      grade: grade({ resolved, mergeable: resolved }),
      evidence: "",
    });
    const runs = [
      run("m-repo", "repo", "t1", true),
      run("m-repo", "repo", "t2", true),
      run("m-bare", "bare", "t1", true),
      run("m-bare", "bare", "t2", false),
    ];
    const s = summarise(runs, [
      { name: "m-repo", model: "m", context: "repo" },
      { name: "m-bare", model: "m", context: "bare" },
    ]);
    expect(s.per[0]).toMatchObject({ runs: 2, resolved: 2, cost_per_resolved_usd: 0.5 });
    expect(s.per[1]).toMatchObject({ resolved: 1, cost_per_resolved_usd: 1 });
    expect(s.paired[0]).toMatchObject({ tasks: 2, only_with_agents_md: 1, only_without: 0 });
  });
});
