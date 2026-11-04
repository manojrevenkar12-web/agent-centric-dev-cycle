/** The safety model: from a task (category) and a change (files, risk) to the autonomy level an agent
 * gets, the reviewers it needs and anything it must not touch. Settings: config/safety.yaml. */
import { loadConfig } from "./config.js";
import { isTestFile, matchesGlob } from "./glob.js";
import { type OwnersEntry, owningTeams, requiredTeams } from "./owners.js";

export const LEVELS = ["human_only", "agent_draft", "agent_reviewed", "auto_approvable"] as const;
export type Level = (typeof LEVELS)[number];
export type Category =
  | "docs"
  | "tests"
  | "bugfix"
  | "refactor"
  | "feature"
  | "dependency"
  | "security"
  | "migration";
export type RiskTier = "low" | "medium" | "high";

type Safety = {
  categories: Record<Category, { max_level: Level }>;
  forbidden: string[];
  sensitive: { reviewers: string; paths: string[] };
  size: { max_files_auto: number; max_files_reviewed: number };
  risk_tiers: Record<RiskTier, Level>;
};

export type Decision = {
  level: Level;
  allowed: boolean; // may an agent make this change at all (level above human_only, nothing forbidden)
  reasons: string[];
  forbidden: string[];
  sensitive: string[];
  requiredTeams: Record<string, string[]>;
  owners: string[];
};

const rank = (l: Level) => LEVELS.indexOf(l);
const lower = (a: Level, b: Level): Level => (rank(a) <= rank(b) ? a : b);

/** Before a run: may an agent attempt this issue at all, and at most at which level? */
export function preflight(category: Category): Decision {
  const s = loadConfig<Safety>("safety");
  const level = s.categories[category]?.max_level ?? "human_only";
  return {
    level,
    allowed: level !== "human_only",
    reasons: [`category ${category}: at most ${level}`],
    forbidden: [],
    sensitive: [],
    requiredTeams: {},
    owners: [],
  };
}

/** After a run: the change itself decides, and can only lower the level preflight allowed. */
export function decide(
  category: Category,
  files: string[],
  owners: OwnersEntry[],
  risk: RiskTier | null,
): Decision {
  const s = loadConfig<Safety>("safety");
  const d = preflight(category);
  const reasons = [...d.reasons];
  let level = d.level;
  const forbidden = files.filter((f) => s.forbidden.some((p) => matchesGlob(f, p)));
  if (forbidden.length) {
    level = "human_only";
    reasons.push(`touches ${forbidden.length} path(s) agents must never change`);
  }
  const sensitive = files.filter((f) => !isTestFile(f) && s.sensitive.paths.some((p) => matchesGlob(f, p)));
  if (sensitive.length) {
    level = lower(level, "agent_draft");
    reasons.push(`sensitive code (${sensitive.length} file(s)): security owners review a draft`);
  }
  const req = requiredTeams(files, owners);
  if (req.size) {
    level = lower(level, "agent_reviewed");
    reasons.push(`OWNERS requires approval from ${[...req.keys()].join(", ")}`);
  }
  const source = files.filter((f) => !isTestFile(f) && !f.endsWith(".md"));
  if (files.length > s.size.max_files_reviewed) {
    level = lower(level, "agent_draft");
    reasons.push(`${files.length} files: too large to review as an agent change`);
  } else if (files.length > s.size.max_files_auto) {
    level = lower(level, "agent_reviewed");
    reasons.push(`${files.length} files: above the size for automated approval`);
  }
  if (risk) {
    const cap = s.risk_tiers[risk];
    if (rank(cap) < rank(level)) reasons.push(`risk ${risk}: at most ${cap}`);
    level = lower(level, cap);
  }
  if (source.length === 0 && level === "auto_approvable") reasons.push("tests and docs only");
  const reqObj = Object.fromEntries(req);
  if (sensitive.length)
    reqObj[s.sensitive.reviewers] = [...(reqObj[s.sensitive.reviewers] ?? []), ...sensitive];
  return {
    level,
    allowed: level !== "human_only",
    reasons,
    forbidden,
    sensitive,
    requiredTeams: reqObj,
    owners: [...owningTeams(files, owners)].sort(),
  };
}
