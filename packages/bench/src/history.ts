/** n8n's merged changes from git history: what changed, who owns it, and what happened next.
 *
 * An outcome is "bad" when the change was reverted, or when a fix touched one of its source files within
 * `followup_days` (a follow-up fix). That second label is a proxy with known noise: busy files get fixes
 * for unrelated reasons. It is what the history can say without the PR discussion.
 */
import { execFileSync } from "node:child_process";
import { isTestFile, loadConfig } from "@acdc/core";

export type Change = {
  sha: string;
  date: string; // ISO
  subject: string;
  pr: number | null;
  type: string;
  scope: string;
  files: string[];
};

export type Labelled = Change & { reverted: boolean; followup: boolean; bad: boolean; followupBy: string[] };

const SUBJECT = /^(?<type>[a-z]+)(?:\((?<scope>[^)]*)\))?!?:/;
const FOLLOWUP_MAX_FILES = 5;
const IGNORED = /(^|\/)(pnpm-lock\.yaml|package\.json|CHANGELOG\.md|en\.json|index\.ts)$/;

export function parseLog(raw: string): Change[] {
  const out: Change[] = [];
  for (const block of raw.split("\n@@").map((b) => b.replace(/^@@/, ""))) {
    const [head, ...rest] = block.split("\n");
    if (!head) continue;
    const [sha, date, ...subj] = head.split("\t");
    const subject = subj.join("\t");
    if (!sha || !date) continue;
    const m = subject.match(SUBJECT);
    const pr = subject.match(/\(#(\d+)\)\s*$/);
    out.push({
      sha,
      date,
      subject,
      pr: pr ? Number(pr[1]) : null,
      type: m?.groups?.type ?? "other",
      scope: m?.groups?.scope ?? "",
      files: rest.map((l) => l.trim()).filter(Boolean),
    });
  }
  return out;
}

export function readHistory(repo: string, since: string): Change[] {
  const raw = execFileSync(
    "git",
    [
      "-C",
      repo,
      "log",
      "--first-parent",
      `--since=${since}`,
      "--format=@@%H%x09%aI%x09%s",
      "--name-only",
      "HEAD",
    ],
    { maxBuffer: 512 * 1024 * 1024, encoding: "utf8" },
  );
  return parseLog(raw).reverse(); // oldest first
}

export function label(changes: Change[], followupDays?: number): Labelled[] {
  const days = followupDays ?? loadConfig<{ followup_days: number }>("risk").followup_days;
  const ms = days * 86_400_000;
  const byFile = new Map<string, number[]>(); // file -> indices of later fixes
  changes.forEach((c, i) => {
    if (c.type !== "fix") return;
    for (const f of c.files)
      if (!isTestFile(f) && !IGNORED.test(f)) byFile.set(f, [...(byFile.get(f) ?? []), i]);
  });
  // n8n writes reverts as `type(scope): Revert "<subject>"` or `Revert - <subject>`
  const bare = (subject: string) =>
    subject
      .replace(SUBJECT, "")
      .replace(/\s*\(#\d+\)\s*$/, "")
      .replace(/\s*\(no-changelog\)/i, "")
      .trim()
      .toLowerCase();
  const reverts = changes
    .map((c) => ({
      c,
      m: c.subject.match(/\brevert\b\s*[-:]?\s*"?([^"]+?)"?\s*(\(no-changelog\))?\s*(\(#\d+\))?$/i),
    }))
    .filter((r) => r.m?.[1] && !/^(fix|feat).*\breverting\b/i.test(r.c.subject))
    .map((r) => ({ date: Date.parse(r.c.date), target: (r.m?.[1] ?? "").trim().toLowerCase() }));
  return changes.map((c, i) => {
    const t = Date.parse(c.date);
    const own = bare(c.subject);
    const reverted = reverts.some(
      (r) =>
        r.date > t &&
        r.target.length > 12 &&
        own.length > 12 &&
        own.includes(r.target.replace(/^.*?:\s*/, "")),
    );
    const by = new Set<string>();
    const mine = new Set(c.files.filter((x) => !isTestFile(x) && !IGNORED.test(x)));
    for (const f of mine) {
      for (const j of byFile.get(f) ?? []) {
        const later = changes[j];
        if (!later || j <= i || Date.parse(later.date) - t > ms) continue;
        // a follow-up is a small fix aimed at this change: most of its source files are ones this change touched
        const fixSrc = later.files.filter((x) => !isTestFile(x) && !IGNORED.test(x));
        const overlap = fixSrc.filter((x) => mine.has(x)).length;
        if (fixSrc.length <= FOLLOWUP_MAX_FILES && overlap / fixSrc.length >= 0.5) by.add(later.sha);
      }
    }
    const followup = by.size > 0;
    return { ...c, reverted, followup, bad: reverted || followup, followupBy: [...by] };
  });
}
