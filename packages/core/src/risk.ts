/** Change risk: how likely a merged change needs a follow-up fix or a revert, from what is known when the
 * pull request is opened (files, owners, type, how busy the files have been). A logistic regression,
 * so every weight can be read and argued with; trained on n8n's history by packages/bench/src/risk-train.ts.
 */
import { isTestFile, matchesGlob } from "./glob.js";
import { type OwnersEntry, owningTeams, requiredTeams } from "./owners.js";
import type { RiskTier } from "./policy.js";

export type ChangeInput = { type: string; scope: string; subject: string; files: string[]; date: string };
export type FileHistory = { recentFixes: (file: string, beforeMs: number, days: number) => number };

export const FEATURES = [
  "log_files",
  "log_source_files",
  "test_share",
  "has_tests",
  "log_packages",
  "owner_teams",
  "required_teams",
  "sensitive",
  "frontend",
  "cli",
  "nodes",
  "core_engine",
  "ai",
  "ci_or_build",
  "docs_only",
  "type_feat",
  "type_fix",
  "type_refactor",
  "type_perf",
  "type_chore",
  "no_changelog",
  "log_recent_fixes_30d",
  "friday",
] as const;

const pkg = (f: string) => {
  const m = f.match(/^packages\/(@n8n\/[^/]+|frontend\/[^/]+|[^/]+)/);
  return m?.[1] ?? f.split("/")[0] ?? f;
};

export function features(
  c: ChangeInput,
  owners: OwnersEntry[],
  history: FileHistory,
  sensitivePaths: string[],
): number[] {
  const files = c.files;
  const src = files.filter((f) => !isTestFile(f));
  const tests = files.length - src.length;
  const packages = new Set(files.map(pkg));
  const t = Date.parse(c.date);
  const recent = src.reduce((s, f) => s + history.recentFixes(f, t, 30), 0);
  const any = (re: RegExp) => (files.some((f) => re.test(f)) ? 1 : 0);
  const v: Record<(typeof FEATURES)[number], number> = {
    log_files: Math.log1p(files.length),
    log_source_files: Math.log1p(src.length),
    test_share: files.length ? tests / files.length : 0,
    has_tests: tests > 0 ? 1 : 0,
    log_packages: Math.log1p(packages.size),
    owner_teams: owningTeams(files, owners).size,
    required_teams: requiredTeams(files, owners).size,
    sensitive: src.some((f) => sensitivePaths.some((p) => matchesGlob(f, p))) ? 1 : 0,
    frontend: any(/^packages\/frontend\//),
    cli: any(/^packages\/cli\//),
    nodes: any(/^packages\/(nodes-base|@n8n\/nodes-langchain)\//),
    core_engine: any(/^packages\/(core|workflow|@n8n\/engine|@n8n\/expression-runtime)\//),
    ai: any(/(ai|langchain|agent|instance-ai|mcp)/i),
    ci_or_build: any(/^(\.github\/|docker\/|scripts\/)/),
    docs_only: files.length > 0 && files.every((f) => f.endsWith(".md")) ? 1 : 0,
    type_feat: c.type === "feat" ? 1 : 0,
    type_fix: c.type === "fix" ? 1 : 0,
    type_refactor: c.type === "refactor" ? 1 : 0,
    type_perf: c.type === "perf" ? 1 : 0,
    type_chore: ["chore", "ci", "build", "test", "docs"].includes(c.type) ? 1 : 0,
    no_changelog: /no-changelog/i.test(c.subject) ? 1 : 0,
    log_recent_fixes_30d: Math.log1p(recent),
    friday: new Date(t).getUTCDay() === 5 ? 1 : 0,
  };
  return FEATURES.map((k) => v[k]);
}

export type RiskModel = { mean: number[]; std: number[]; w: number[]; b: number; low: number; high: number };

const sigmoid = (z: number) => 1 / (1 + Math.exp(-z));

export function fit(X: number[][], y: number[], opts: { l2: number; epochs: number; lr: number }): RiskModel {
  const d = X[0]?.length ?? 0;
  const mean = Array.from({ length: d }, (_, j) => X.reduce((s, r) => s + (r[j] ?? 0), 0) / X.length);
  const std = Array.from({ length: d }, (_, j) => {
    const m = mean[j] ?? 0;
    const v = X.reduce((s, r) => s + ((r[j] ?? 0) - m) ** 2, 0) / X.length;
    return Math.sqrt(v) || 1;
  });
  const Z = X.map((r) => r.map((x, j) => (x - (mean[j] ?? 0)) / (std[j] ?? 1)));
  const w = new Array(d).fill(0);
  let b = Math.log(y.reduce((a, c) => a + c, 0) / y.length / (1 - y.reduce((a, c) => a + c, 0) / y.length));
  const n = Z.length;
  for (let e = 0; e < opts.epochs; e++) {
    // full-batch gradient descent: deterministic, and the data is small
    const g = new Array(d).fill(0);
    let gb = 0;
    for (let i = 0; i < n; i++) {
      const z = Z[i] ?? [];
      const p = sigmoid(b + z.reduce((s, x, j) => s + x * w[j], 0));
      const err = p - (y[i] ?? 0);
      gb += err;
      for (let j = 0; j < d; j++) g[j] += err * (z[j] ?? 0);
    }
    for (let j = 0; j < d; j++) w[j] -= opts.lr * (g[j] / n + (opts.l2 * w[j]) / n);
    b -= opts.lr * (gb / n);
  }
  return { mean, std, w, b, low: 0, high: 1 };
}

export function predict(m: RiskModel, x: number[]): number {
  return sigmoid(
    m.b + x.reduce((s, v, j) => s + ((v - (m.mean[j] ?? 0)) / (m.std[j] ?? 1)) * (m.w[j] ?? 0), 0),
  );
}

export function tier(m: RiskModel, p: number): RiskTier {
  return p <= m.low ? "low" : p >= m.high ? "high" : "medium";
}

/** Area under the ROC curve (rank statistic, ties counted half). */
export function auc(p: number[], y: number[]): number {
  const idx = p.map((_, i) => i).sort((a, b) => (p[a] ?? 0) - (p[b] ?? 0));
  let rank = 0;
  let sumPos = 0;
  let nPos = 0;
  let i = 0;
  while (i < idx.length) {
    let j = i;
    while (j + 1 < idx.length && p[idx[j + 1] ?? 0] === p[idx[i] ?? 0]) j++;
    const r = (rank + 1 + rank + (j - i + 1)) / 2;
    for (let k = i; k <= j; k++) {
      if (y[idx[k] ?? 0]) {
        sumPos += r;
        nPos++;
      }
    }
    rank += j - i + 1;
    i = j + 1;
  }
  const nNeg = y.length - nPos;
  return nPos && nNeg ? (sumPos - (nPos * (nPos + 1)) / 2) / (nPos * nNeg) : 0.5;
}

export function ece(p: number[], y: number[], bins = 10): number {
  let e = 0;
  for (let b = 0; b < bins; b++) {
    const idx = p
      .map((v, i) => [v, i] as const)
      .filter(([v]) => Math.min(bins - 1, Math.floor(v * bins)) === b);
    if (!idx.length) continue;
    const mp = idx.reduce((s, [v]) => s + v, 0) / idx.length;
    const my = idx.reduce((s, [, i]) => s + (y[i] ?? 0), 0) / idx.length;
    e += (Math.abs(mp - my) * idx.length) / p.length;
  }
  return e;
}
