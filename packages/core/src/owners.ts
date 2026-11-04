/** n8n's OWNERS file: `<pattern> <@org/team> [required]`, last match wins. A team is required for a
 * change when its `required` entry wins for a changed file that is not a test file. */
import { isTestFile } from "./glob.js";

export type OwnersEntry = { pattern: string; team: string; required: boolean; line: number };

const TEAM = /^@[\w.-]+\/[\w.-]+$/;

export function parseOwners(content: string): OwnersEntry[] {
  const out: OwnersEntry[] = [];
  content.split("\n").forEach((raw, i) => {
    const hash = raw.match(/(^|\s)#/);
    const line = (hash ? raw.slice(0, hash.index) : raw).trim();
    if (!line) return;
    const [pattern, ...tokens] = line.split(/\s+/);
    let team: string | null = null;
    let required = false;
    for (const t of tokens) {
      if (TEAM.test(t)) {
        if (team) throw new Error(`OWNERS line ${i + 1}: only one team per pattern`);
        team = t;
      } else if (t === "required") required = true;
      else throw new Error(`OWNERS line ${i + 1}: unknown token "${t}"`);
    }
    if (!team || !pattern) throw new Error(`OWNERS line ${i + 1}: no team for "${pattern}"`);
    out.push({ pattern, team, required, line: i + 1 });
  });
  return out;
}

export function matches(file: string, pattern: string): boolean {
  if (pattern === "*") return true;
  if (pattern.endsWith("/")) return file.startsWith(pattern);
  return file === pattern;
}

export function owningEntry(file: string, entries: OwnersEntry[]): OwnersEntry | undefined {
  for (let i = entries.length - 1; i >= 0; i--) {
    const e = entries[i];
    if (e && matches(file, e.pattern)) return e;
  }
  return undefined;
}

export function requiredTeams(files: Iterable<string>, entries: OwnersEntry[]): Map<string, string[]> {
  const out = new Map<string, string[]>();
  for (const f of [...files].sort()) {
    if (isTestFile(f)) continue;
    const e = owningEntry(f, entries);
    if (!e?.required) continue;
    out.set(e.team, [...(out.get(e.team) ?? []), f]);
  }
  return out;
}

export function owningTeams(files: Iterable<string>, entries: OwnersEntry[]): Set<string> {
  const out = new Set<string>();
  for (const f of files) {
    const e = owningEntry(f, entries);
    if (e) out.add(e.team);
  }
  return out;
}
