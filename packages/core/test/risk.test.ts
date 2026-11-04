import { describe, expect, it } from "vitest";
import { FEATURES, auc, ece, features, fit, parseOwners, predict } from "../src/index.js";

const noHistory = { recentFixes: () => 0 };

describe("risk model", () => {
  it("computes AUC as a rank statistic with ties counted half", () => {
    expect(auc([0.1, 0.2, 0.3, 0.4], [0, 0, 1, 1])).toBe(1);
    expect(auc([0.4, 0.3, 0.2, 0.1], [0, 0, 1, 1])).toBe(0);
    expect(auc([0.5, 0.5, 0.5, 0.5], [0, 1, 0, 1])).toBe(0.5);
    expect(auc([0.1, 0.4, 0.35, 0.8], [0, 0, 1, 1])).toBe(0.75);
  });

  it("measures calibration error", () => {
    expect(ece([0.05, 0.05, 0.95, 0.95], [0, 0, 1, 1])).toBeCloseTo(0.05);
  });

  it("recovers a planted signal from data", () => {
    let s = 7;
    const rnd = () => {
      s = (s * 16807) % 2147483647;
      return s / 2147483647;
    };
    const X: number[][] = [];
    const y: number[] = [];
    for (let i = 0; i < 2000; i++) {
      const a = rnd() * 4;
      const b = rnd();
      X.push([a, b]);
      y.push(rnd() < 1 / (1 + Math.exp(-(1.5 * a - 3))) ? 1 : 0);
    }
    const m = fit(X, y, { l2: 1, epochs: 400, lr: 0.5 });
    expect(m.w[0]).toBeGreaterThan(0.8);
    expect(Math.abs(m.w[1] ?? 1)).toBeLessThan(0.15);
    expect(predict(m, [3.5, 0.5])).toBeGreaterThan(predict(m, [0.5, 0.5]));
  });

  it("builds features only from what is known when the PR opens", () => {
    const owners = parseOwners("* @o/a\npackages/cli/ @o/cli required\n");
    const seen: number[] = [];
    const x = features(
      {
        type: "fix",
        scope: "core",
        subject: "fix(core): Thing (#1)",
        date: "2026-09-04T10:00:00Z",
        files: ["packages/cli/src/a.ts", "packages/cli/test/a.test.ts"],
      },
      owners,
      {
        recentFixes: (_f, before) => {
          seen.push(before);
          return 3;
        },
      },
      [],
    );
    const v = Object.fromEntries(FEATURES.map((f, i) => [f, x[i]]));
    expect(v).toMatchObject({
      has_tests: 1,
      test_share: 0.5,
      required_teams: 1,
      cli: 1,
      type_fix: 1,
      friday: 1,
    }); // 4 September 2026 is a Friday;
    expect(v.log_recent_fixes_30d).toBeCloseTo(Math.log1p(3));
    expect(seen).toEqual([Date.parse("2026-09-04T10:00:00Z")]); // asked only about the time before the change
    expect(
      features(
        { type: "docs", scope: "", subject: "", date: "2026-09-04T10:00:00Z", files: ["a.md"] },
        owners,
        noHistory,
        [],
      )[FEATURES.indexOf("docs_only")],
    ).toBe(1);
  });
});
