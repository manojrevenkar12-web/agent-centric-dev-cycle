/** Train and evaluate the change-risk model on n8n's history, then replay automated approval in shadow mode:
 * on the test months, which changes would the policy have let through without a human, and how many of
 * those needed a revert or a follow-up fix? Compared with the rule a team would write without a model
 * (small change with tests), at the same share of changes. Writes reports/risk.json and config/risk-model.json.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  type Category,
  FEATURES,
  type FileHistory,
  LEVELS,
  ROOT,
  type RiskModel,
  auc,
  decide,
  ece,
  features,
  fit,
  isTestFile,
  loadConfig,
  parseOwners,
  predict,
} from "@acdc/core";
import type { Labelled } from "./history.js";

/** The task category an issue for this change would have carried, from its conventional-commit type. */
export function categoryOf(c: { type: string; scope: string; subject: string }): Category {
  if (/\bdeps?\b|bump|upgrade/i.test(`${c.scope} ${c.subject}`) && c.type !== "feat") return "dependency";
  if (/security|vulnerab|cve-/i.test(c.subject)) return "security";
  switch (c.type) {
    case "fix":
      return "bugfix";
    case "feat":
      return "feature";
    case "docs":
      return "docs";
    case "test":
      return "tests";
    default:
      return "refactor";
  }
}
import { readDataset } from "./dataset.js";

type RiskCfg = {
  train_until: string;
  label_until_days: number;
  l2: number;
  epochs: number;
  learning_rate: number;
  low_tier_share: number;
  high_tier_share: number;
};

export function fileHistory(changes: Pick<Labelled, "type" | "date" | "files">[]): FileHistory {
  const fixes = new Map<string, number[]>();
  for (const c of changes) {
    if (c.type !== "fix") continue;
    const t = Date.parse(c.date);
    for (const f of c.files) if (!isTestFile(f)) fixes.set(f, [...(fixes.get(f) ?? []), t]);
  }
  return {
    recentFixes(file, before, days) {
      const ts = fixes.get(file);
      if (!ts) return 0;
      const from = before - days * 86_400_000;
      let n = 0;
      for (const t of ts) if (t >= from && t < before) n++; // strictly earlier: no look-ahead
      return n;
    },
  };
}

const quantile = (xs: number[], q: number) => {
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.max(0, Math.floor(q * (s.length - 1))))] ?? 0;
};

const rate = (ys: number[]) => (ys.length ? ys.reduce((a, b) => a + b, 0) / ys.length : 0);

/** Wilson 95% interval for a rate. */
export function wilson(k: number, n: number): [number, number] {
  if (!n) return [0, 1];
  const z = 1.96;
  const p = k / n;
  const den = 1 + (z * z) / n;
  const mid = (p + (z * z) / (2 * n)) / den;
  const half = (z * Math.sqrt((p * (1 - p)) / n + (z * z) / (4 * n * n))) / den;
  return [Math.max(0, mid - half), Math.min(1, mid + half)];
}

export function trainRisk(changes: Labelled[], ownersText: string, drop: string[] = []) {
  const cfg = loadConfig<RiskCfg>("risk");
  const safety = loadConfig<{ sensitive: { paths: string[] } }>("safety");
  const owners = parseOwners(ownersText);
  const last = Math.max(...changes.map((c) => Date.parse(c.date)));
  const complete = changes.filter(
    (c) => Date.parse(c.date) <= last - cfg.label_until_days * 86_400_000 && c.type !== "revert",
  );
  const hist = fileHistory(changes);
  const off = new Set(drop.map((d) => FEATURES.indexOf(d as (typeof FEATURES)[number])));
  const X = complete.map((c) =>
    features(c, owners, hist, safety.sensitive.paths).map((v, j) => (off.has(j) ? 0 : v)),
  );
  const y = complete.map((c) => (c.bad ? 1 : 0));
  const split = Date.parse(`${cfg.train_until}T23:59:59Z`);
  const tr = complete
    .map((c, i) => [c, i] as const)
    .filter(([c]) => Date.parse(c.date) <= split)
    .map(([, i]) => i);
  const te = complete
    .map((c, i) => [c, i] as const)
    .filter(([c]) => Date.parse(c.date) > split)
    .map(([, i]) => i);
  const model: RiskModel = fit(
    tr.map((i) => X[i] ?? []),
    tr.map((i) => y[i] ?? 0),
    { l2: cfg.l2, epochs: cfg.epochs, lr: cfg.learning_rate },
  );
  const pTr = tr.map((i) => predict(model, X[i] ?? []));
  model.low = quantile(pTr, cfg.low_tier_share);
  model.high = quantile(pTr, 1 - cfg.high_tier_share);
  const pTe = te.map((i) => predict(model, X[i] ?? []));
  const yTe = te.map((i) => y[i] ?? 0);

  // Naive rule at the same share: the smallest changes that include tests, then the smallest overall.
  const naiveScore = (c: Labelled) => {
    const src = c.files.filter((f) => !isTestFile(f)).length;
    const hasTests = c.files.length > src ? 0 : 1;
    return hasTests * 1000 + src;
  };
  const shadow = (scores: number[], share: number) => {
    const order = scores.map((s, k) => [s, k] as const).sort((a, b) => a[0] - b[0]);
    const take = order.slice(0, Math.round(share * scores.length)).map(([, k]) => k);
    const bad = take.reduce((s, k) => s + (yTe[k] ?? 0), 0);
    return {
      changes: take.length,
      bad,
      rate: take.length ? bad / take.length : 0,
      ci95: wilson(bad, take.length),
    };
  };
  const lowTe = pTe.filter((p) => p <= model.low).length / Math.max(1, pTe.length);
  const naive = te.map((i) => naiveScore(complete[i] as Labelled));
  const tiers = { low: [] as number[], medium: [] as number[], high: [] as number[] };
  pTe.forEach((p, k) =>
    (p <= model.low ? tiers.low : p >= model.high ? tiers.high : tiers.medium).push(yTe[k] ?? 0),
  );
  // The whole safety model replayed on the test months: where would each real change have landed?
  const levels = new Map<string, number[]>();
  const blocked = { forbidden: 0, sensitive: 0, required_review: 0 };
  te.forEach((i, k) => {
    const c = complete[i] as Labelled;
    const p = pTe[k] ?? 0;
    const d = decide(
      categoryOf(c),
      c.files,
      owners,
      p <= model.low ? "low" : p >= model.high ? "high" : "medium",
    );
    levels.set(d.level, [...(levels.get(d.level) ?? []), yTe[k] ?? 0]);
    if (d.forbidden.length) blocked.forbidden++;
    if (d.sensitive.length) blocked.sensitive++;
    if (Object.keys(d.requiredTeams).length) blocked.required_review++;
  });
  const policy = {
    levels: Object.fromEntries(
      LEVELS.map((l) => {
        const v = levels.get(l) ?? [];
        const k = v.reduce((a, b) => a + b, 0);
        return [
          l,
          { share: v.length / te.length, bad_rate: rate(v), changes: v.length, ci95: wilson(k, v.length) },
        ];
      }),
    ),
    touched: blocked,
  };
  const shares = [0.1, 0.2, 0.3];
  const report = {
    data: {
      merged_changes: changes.length,
      labelled: complete.length,
      bad_rate: rate(y),
      train: { changes: tr.length, until: cfg.train_until, bad_rate: rate(tr.map((i) => y[i] ?? 0)) },
      test: {
        changes: te.length,
        from: complete[te[0] ?? 0]?.date.slice(0, 10),
        to: complete[te.at(-1) ?? 0]?.date.slice(0, 10),
        bad_rate: rate(yTe),
      },
    },
    test: {
      auc: auc(pTe, yTe),
      auc_naive_rule: auc(naive, yTe),
      ece: ece(pTe, yTe),
      tiers: Object.fromEntries(
        Object.entries(tiers).map(([k, v]) => [
          k,
          {
            share: v.length / pTe.length,
            bad_rate: rate(v),
            ci95: wilson(
              v.reduce((a, b) => a + b, 0),
              v.length,
            ),
          },
        ]),
      ),
      low_share_on_test: lowTe,
      policy,
      shadow: shares.map((s) => ({ share: s, model: shadow(pTe, s), naive_rule: shadow(naive, s) })),
    },
    weights: FEATURES.map((f, j) => ({ feature: f, weight: model.w[j] ?? 0 })).sort(
      (a, b) => Math.abs(b.weight) - Math.abs(a.weight),
    ),
  };
  return { model, report };
}

export function main() {
  const changes = readDataset();
  const owners = readFileSync(join(ROOT, "data/n8n/OWNERS"), "utf8");
  const { model, report } = trainRisk(changes, owners);
  // Ablation: busy files attract fixes for unrelated reasons, so the hot-file feature partly measures the
  // label's own noise. Without it, how much of the model is left?
  const cold = trainRisk(changes, owners, ["log_recent_fixes_30d"]).report;
  Object.assign(report, {
    ablation_without_file_history: {
      auc: cold.test.auc,
      shadow: cold.test.shadow.map((s) => ({ share: s.share, rate: s.model.rate })),
    },
  });
  writeFileSync(
    join(ROOT, "config/risk-model.json"),
    `${JSON.stringify({ features: FEATURES, ...model }, null, 1)}\n`,
  );
  writeFileSync(join(ROOT, "reports/risk.json"), `${JSON.stringify(report, null, 2)}\n`);
  return report;
}
