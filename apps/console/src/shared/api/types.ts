export type RunItem = {
  id: string;
  issue_id: string;
  state: string;
  level: string | null;
  attempt: number;
  pr_number: number | null;
  cost_usd: number;
  created_at: string;
  updated_at: string;
  issue_key: string;
  title: string;
  category: string;
};

export type RunEvent = { id: number; at: string; kind: string; data: Record<string, unknown> };

export type RunDetail = {
  run: RunItem & { evidence: string | null };
  issue: { id: string; key: string; title: string; body: string; labels: string[]; category: string };
  events: RunEvent[];
};

export type Metrics = {
  issues: number;
  blocked_at_preflight: number;
  prs_opened: number;
  merged: number;
  reviewer_acceptance_rate: number | null;
  ci_pass_rate: number | null;
  rework_rate: number | null;
  overclaim_rate: number | null;
  self_verified_rate: number | null;
  handed_over: number;
  cost_usd: number;
  cost_per_merged_usd: number | null;
  median_hours_to_merge: number | null;
  satisfaction: { mean: number | null; responses: number };
  levels: Record<string, number>;
};

export type Policy = {
  levels: string[];
  categories: Record<string, { max_level: string }>;
  forbidden: string[];
  sensitive: { reviewers: string; paths: string[] };
  size: { max_files_auto: number; max_files_reviewed: number };
  risk_tiers: Record<string, string>;
};

type Rate = { changes: number; bad: number; rate: number; ci95: [number, number] };
export type RiskReport = {
  data: {
    merged_changes: number;
    labelled: number;
    bad_rate: number;
    test: { changes: number; from: string; to: string; bad_rate: number };
    train: { until: string };
  };
  test: {
    auc: number;
    auc_naive_rule: number;
    ece: number;
    policy: { levels: Record<string, { share: number; bad_rate: number; changes: number }> };
    shadow: { share: number; model: Rate; naive_rule: Rate }[];
  };
  ablation_without_file_history: { auc: number };
  weights: { feature: string; weight: number }[];
};

export type SetupSummary = {
  setup: string;
  model: string;
  context: string;
  runs: number;
  resolved: number;
  resolved_rate: number;
  resolved_ci95: [number, number];
  ci_pass_rate: number;
  mergeable_rate: number;
  self_verified_rate: number;
  overclaim_rate: number;
  cost_usd: number;
  cost_per_resolved_usd: number | null;
  median_seconds: number;
};
export type BenchReport = {
  tasks: number;
  spent_usd: number;
  per: SetupSummary[];
  paired: {
    model: string;
    tasks: number;
    only_with_agents_md: number;
    only_without: number;
    p_value: number;
  }[];
};
export type Studies = {
  risk: RiskReport | null;
  bench: BenchReport | null;
  owners: { owner_agreement: number; files: number; required_agreement: number; changes: number } | null;
};

export type BenchRun = {
  task: string;
  setup: string;
  resolved: boolean;
  ci_pass: boolean;
  mergeable: boolean;
  overclaim: boolean;
  level: string | null;
  cost_usd: number;
  seconds: number;
  tests_run: number;
  evidence: string;
};
