import { readFileSync } from "node:fs";
import { join } from "node:path";
import { ROOT } from "@acdc/core";
import { describe, expect, it } from "vitest";
import { readDataset } from "../src/dataset.js";
import { type Change, label, parseLog } from "../src/history.js";
import { categoryOf, fileHistory, trainRisk, wilson } from "../src/risk-train.js";

const c = (i: number, subject: string, files: string[], day: number): Change => ({
  sha: `s${i}`,
  date: new Date(Date.UTC(2026, 8, day)).toISOString(),
  subject,
  pr: i,
  type: subject.match(/^(\w+)/)?.[1] ?? "other",
  scope: "",
  files,
});

describe("history", () => {
  it("parses git log with name-only", () => {
    const raw =
      "@@a1\t2026-09-01T10:00:00+00:00\tfix(core): Do it (#12)\n\npackages/core/a.ts\npackages/core/test/a.test.ts\n@@b2\t2026-09-02T10:00:00+00:00\tdocs: Readme (#13)\n\nREADME.md\n";
    const [a, b] = parseLog(raw);
    expect(a).toMatchObject({
      sha: "a1",
      type: "fix",
      scope: "core",
      pr: 12,
      files: ["packages/core/a.ts", "packages/core/test/a.test.ts"],
    });
    expect(b).toMatchObject({ type: "docs", pr: 13, files: ["README.md"] });
  });

  it("labels reverts and small follow-up fixes, not unrelated or late fixes", () => {
    const rows = label(
      [
        c(
          1,
          "feat(editor): Add canvas zoom presets (#1)",
          ["packages/editor/zoom.ts", "packages/editor/menu.ts"],
          1,
        ),
        c(2, "fix(editor): Zoom presets overflow (#2)", ["packages/editor/zoom.ts"], 3), // follow-up of 1
        c(3, "feat(core): Add retry budget to the engine (#3)", ["packages/core/retry.ts"], 4),
        c(4, 'chore: Revert "Add retry budget to the engine" (#4)', ["packages/core/retry.ts"], 5), // reverts 3
        c(5, "feat(cli): Add flag parsing (#5)", ["packages/cli/flags.ts"], 6),
        c(
          6,
          "fix(cli): Many things (#6)",
          ["packages/cli/flags.ts", "a.ts", "b.ts", "c.ts", "d.ts", "e.ts"],
          7,
        ), // too big
        c(7, "feat(nodes): Add a node (#7)", ["packages/nodes/x.ts"], 8),
        c(8, "fix(nodes): Node bug (#8)", ["packages/nodes/x.ts"], 20), // too late
      ],
      7,
    );
    const by = Object.fromEntries(rows.map((r) => [r.sha, r]));
    expect(by.s1).toMatchObject({ followup: true, bad: true, followupBy: ["s2"] });
    expect(by.s3).toMatchObject({ reverted: true, bad: true });
    expect(by.s5?.bad).toBe(false);
    expect(by.s7?.bad).toBe(false);
  });

  it("counts a file's earlier fixes without looking ahead", () => {
    const rows = label([c(1, "fix: a (#1)", ["x.ts"], 1), c(2, "fix: b (#2)", ["x.ts"], 10)], 7);
    const h = fileHistory(rows);
    expect(h.recentFixes("x.ts", Date.parse(rows[1]?.date ?? ""), 30)).toBe(1);
    expect(h.recentFixes("x.ts", Date.parse(rows[0]?.date ?? ""), 30)).toBe(0);
  });

  it("maps a change to the category its issue would carry", () => {
    expect(categoryOf({ type: "chore", scope: "deps", subject: "chore(deps): Bump x" })).toBe("dependency");
    expect(categoryOf({ type: "fix", scope: "core", subject: "fix(core): x" })).toBe("bugfix");
    expect(categoryOf({ type: "feat", scope: "", subject: "feat: upgrade to y" })).toBe("feature");
  });

  it("gives Wilson intervals that contain the rate", () => {
    const [lo, hi] = wilson(5, 100);
    expect(lo).toBeLessThan(0.05);
    expect(hi).toBeGreaterThan(0.05);
    expect(wilson(0, 104)[0]).toBe(0);
  });
});

describe("the study on n8n's committed history", () => {
  const rows = readDataset();
  const owners = readFileSync(join(ROOT, "data/n8n/OWNERS"), "utf8");
  const { report } = trainRisk(rows, owners);

  it("splits by time and beats the size-and-tests rule on the later months", () => {
    expect(report.data.merged_changes).toBeGreaterThan(10_000);
    expect((report.data.test.from ?? "") >= "2026-09-01").toBe(true);
    expect(report.test.auc).toBeGreaterThan(report.test.auc_naive_rule + 0.1);
    for (const s of report.test.shadow) expect(s.model.rate).toBeLessThan(s.naive_rule.rate);
  });

  it("is reproduced exactly by the committed report", () => {
    const committed = JSON.parse(readFileSync(join(ROOT, "reports/risk.json"), "utf8"));
    expect(committed.test.auc).toBeCloseTo(report.test.auc, 10);
    expect(committed.test.policy).toEqual(report.test.policy);
  });
});
