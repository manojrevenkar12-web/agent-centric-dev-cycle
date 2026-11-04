/** Agreement check: our OWNERS matcher against n8n's own (.github/scripts/owners/owners.mjs) on every file
 * in the repository and on the files of every recent change. The policy relies on the same answer the
 * merge gate gives, so any disagreement is a bug here. */
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { owningEntry, parseOwners, requiredTeams } from "@acdc/core";
import { readDataset } from "./dataset.js";

type Theirs = {
  parseOwnersContent: (c: string) => { pattern: string; team: string; required: boolean }[];
  findOwningEntry: (f: string, e: unknown[]) => { team: string } | undefined;
  resolveRequiredTeams: (files: string[], e: unknown[]) => Map<string, string[]> | Set<string> | string[];
};

export async function ownersCheck(repo: string) {
  const theirs = (await import(
    pathToFileURL(join(repo, ".github/scripts/owners/owners.mjs")).href
  )) as Theirs;
  const text = readFileSync(join(repo, "OWNERS"), "utf8");
  const ours = parseOwners(text);
  const their = theirs.parseOwnersContent(text);
  const files = execFileSync("git", ["-C", repo, "ls-tree", "-r", "--name-only", "HEAD"], {
    encoding: "utf8",
    maxBuffer: 256 * 1024 * 1024,
  })
    .split("\n")
    .filter(Boolean);
  const ownerDiff = files.filter(
    (f) => owningEntry(f, ours)?.team !== theirs.findOwningEntry(f, their)?.team,
  );
  const keys = (r: Map<string, string[]> | Set<string> | string[]) =>
    [...(r instanceof Map ? r.keys() : r)].sort().join(",");
  const changes = readDataset().filter((c) => c.date >= "2026-09-01");
  const reqDiff = changes.filter(
    (c) => keys(requiredTeams(c.files, ours)) !== keys(theirs.resolveRequiredTeams(c.files, their)),
  );
  return {
    entries: { ours: ours.length, theirs: their.length },
    files: files.length,
    owner_disagreements: ownerDiff.slice(0, 20),
    owner_agreement: 1 - ownerDiff.length / files.length,
    changes: changes.length,
    required_disagreements: reqDiff.slice(0, 20).map((c) => c.sha),
    required_agreement: 1 - reqDiff.length / Math.max(1, changes.length),
  };
}
