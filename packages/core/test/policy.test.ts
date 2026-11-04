import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  ROOT,
  decide,
  isTestFile,
  matchesGlob,
  owningEntry,
  parseOwners,
  preflight,
  requiredTeams,
} from "../src/index.js";

const OWNERS = parseOwners(readFileSync(join(ROOT, "data/n8n/OWNERS"), "utf8"));

describe("glob grammar (n8n's glob.mjs)", () => {
  it.each([
    ["packages/cli/src/auth/jwt.ts", "packages/cli/src/auth/**", true],
    ["packages/cli/src/auth", "packages/cli/src/auth/**", false],
    ["a/b/c.test.ts", "**/*.test.ts", true],
    ["c.test.ts", "**/*.test.ts", true],
    ["a/b.ts", "a/*.ts", true],
    ["a/x/b.ts", "a/*.ts", false],
    ["packages/cli/src/services/ai-gateway.service.ts", "packages/cli/src/services/ai-gateway*.ts", true],
    ["file.(x).ts", "file.(x).ts", true],
  ])("%s ~ %s is %s", (path, pattern, want) => expect(matchesGlob(path, pattern)).toBe(want));

  it("knows test files the way n8n's CI does", () => {
    expect(isTestFile("packages/workflow/test/expression.test.ts")).toBe(true);
    expect(isTestFile("packages/workflow/src/__snapshots__/x.snap")).toBe(true);
    expect(isTestFile("packages/workflow/src/expression.ts")).toBe(false);
  });
});

describe("OWNERS", () => {
  it("parses n8n's file and rejects malformed lines", () => {
    expect(OWNERS.length).toBeGreaterThan(300);
    expect(() => parseOwners("packages/a/ @n8n-io/x maybe")).toThrow(/unknown token/);
    expect(() => parseOwners("packages/a/")).toThrow(/no team/);
    expect(() => parseOwners("a/ @o/x @o/y")).toThrow(/one team/);
  });

  it("lets the last matching entry win and ignores required teams for test files", () => {
    const e = parseOwners("* @o/default\npackages/ @o/pkg\npackages/x/ @o/x required\n");
    expect(owningEntry("packages/x/a.ts", e)?.team).toBe("@o/x");
    expect(owningEntry("packages/y/a.ts", e)?.team).toBe("@o/pkg");
    expect(owningEntry("README.md", e)?.team).toBe("@o/default");
    expect([...requiredTeams(["packages/x/a.ts", "packages/x/test/a.test.ts"], e)]).toEqual([
      ["@o/x", ["packages/x/a.ts"]],
    ]);
    expect(requiredTeams(["packages/x/test/a.test.ts"], e).size).toBe(0);
  });

  it("requires migration review for a migration", () => {
    const f = "packages/@n8n/db/src/migrations/common/1760000000000-AddThing.ts";
    expect([...requiredTeams([f], OWNERS).keys()]).toContain("@n8n-io/migrations-review");
  });
});

describe("safety model", () => {
  it("never lets an agent attempt security or migration work", () => {
    expect(preflight("security").allowed).toBe(false);
    expect(preflight("migration").allowed).toBe(false);
    expect(preflight("bugfix")).toMatchObject({ allowed: true, level: "agent_reviewed" });
  });

  it("drops to human_only when a diff touches a forbidden path, whatever the category", () => {
    const d = decide("docs", ["docs/x.md", ".github/workflows/ci.yml"], OWNERS, "low");
    expect(d).toMatchObject({ level: "human_only", allowed: false, forbidden: [".github/workflows/ci.yml"] });
  });

  it("makes sensitive code a draft reviewed by security owners", () => {
    const d = decide("bugfix", ["packages/cli/src/auth/auth.service.ts"], OWNERS, "low");
    expect(d.level).toBe("agent_draft");
    expect(d.requiredTeams["@n8n-io/iam"]).toEqual(["packages/cli/src/auth/auth.service.ts"]);
  });

  it("allows automated approval only for small, low-risk test or docs changes", () => {
    const test = ["packages/workflow/test/expression.test.ts"];
    expect(decide("tests", test, OWNERS, "low").level).toBe("auto_approvable");
    expect(decide("tests", test, OWNERS, "medium").level).toBe("agent_reviewed");
    expect(decide("bugfix", test, OWNERS, "low").level).toBe("agent_reviewed");
    const many = Array.from({ length: 7 }, (_, i) => `packages/workflow/test/t${i}.test.ts`);
    expect(decide("tests", many, OWNERS, "low").level).toBe("agent_reviewed");
    const huge = Array.from({ length: 26 }, (_, i) => `packages/workflow/src/f${i}.ts`);
    expect(decide("refactor", huge, OWNERS, null).level).toBe("agent_draft");
  });

  it("can only lower the level preflight allowed", () => {
    for (const c of ["docs", "tests", "bugfix", "refactor", "feature", "dependency"] as const) {
      const pre = preflight(c).level;
      const after = decide(c, ["README.md"], OWNERS, "low").level;
      const order = ["human_only", "agent_draft", "agent_reviewed", "auto_approvable"];
      expect(order.indexOf(after)).toBeLessThanOrEqual(order.indexOf(pre));
    }
  });
});
