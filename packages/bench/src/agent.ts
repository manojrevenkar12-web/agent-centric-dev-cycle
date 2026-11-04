/** One coding-agent session (Claude Code, headless) in a task's checkout.
 *
 * Least privilege: file tools confined to the checkout (--restricted); the shell may run only the
 * wrapper commands below (tests without network, the type check, git status/diff); anything else is
 * refused without asking and recorded as a denial. The session starts with an empty environment
 * (HOME and PATH), no user settings, skills or MCP servers, and a hard spend cap.
 */
import { spawn } from "node:child_process";
import { chmodSync, createWriteStream, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { benchCfg, projectsFor } from "./sandbox.js";

export type Session = {
  ok: boolean;
  error: string;
  result: string;
  cost_usd: number;
  turns: number;
  tool_calls: number;
  tests_run: number; // how often the agent ran tests itself: self-verification
  denials: number;
  tokens_in: number;
  tokens_out: number;
  seconds: number;
  model: string; // the model that actually served the session
};

export const ALLOWED = [
  "Read",
  "Edit",
  "Write",
  "Glob",
  "Grep",
  "Bash(acdc-test:*)",
  "Bash(acdc-typecheck:*)",
  "Bash(acdc-lint:*)",
  "Bash(git status:*)",
  "Bash(git diff:*)",
  "Bash(ls:*)",
];

/** The commands an agent's shell may run, written outside the checkout and put first on its PATH. */
export function writeWrappers(binDir: string, checkoutDir: string, repo: string) {
  const cfg = benchCfg();
  const pkg = join(checkoutDir, cfg.package);
  mkdirSync(binDir, { recursive: true });
  const net = cfg.network_isolation ? "unshare --user --net --map-root-user " : "";
  const projects = projectsFor(checkoutDir)
    .map((p) => `--project ${p}`)
    .join(" ");
  const own = join(repo, cfg.package);
  const scripts = {
    "acdc-test": `#!/bin/sh
# Run the package's tests without network. Usage: acdc-test [test files or name filters]
cd "${pkg}" || exit 2
files=""
for a in "$@"; do files="$files \${a#${cfg.package}/}"; done
exec ${net}env -i PATH="$PATH" HOME=/tmp CI=true NODE_OPTIONS=--max-old-space-size=3072 ./node_modules/.bin/vitest run ${projects} --reporter=dot $files
`,
    "acdc-lint": `#!/bin/sh
# Lint files with n8n's oxlint config. Usage: acdc-lint <source files>
cd "${pkg}" || exit 2
files=""
for a in "$@"; do files="$files \${a#${cfg.package}/}"; done
exec env -i PATH="$PATH" HOME=/tmp ${own}/node_modules/.bin/oxlint -c ${own}/oxlint.config.mts $files
`,
    "acdc-typecheck": `#!/bin/sh
# Type-check the package. Usage: acdc-typecheck
cd "${pkg}" || exit 2
exec env -i PATH="$PATH" HOME=/tmp ./node_modules/.bin/tsc --noEmit -p tsconfig.json
`,
  };
  for (const [name, body] of Object.entries(scripts)) {
    writeFileSync(join(binDir, name), body);
    chmodSync(join(binDir, name), 0o755);
  }
}

export function command(model: string, budget: number): string[] {
  return [
    process.env.ACDC_AGENT_BIN ?? "claude",
    "-p",
    "--model",
    model,
    "--output-format",
    "stream-json",
    "--verbose",
    "--restricted",
    "--tools",
    "Read,Edit,Write,Glob,Grep,Bash",
    "--allowedTools",
    ...ALLOWED,
    "--permission-mode",
    "dontAsk",
    "--setting-sources",
    "project",
    "--disable-slash-commands",
    "--strict-mcp-config",
    "--no-session-persistence",
    "--max-budget-usd",
    budget.toFixed(2),
  ];
}

export function parse(lines: string[]): Omit<Session, "seconds"> {
  const s: Omit<Session, "seconds"> = {
    ok: false,
    error: "",
    result: "",
    cost_usd: 0,
    turns: 0,
    tool_calls: 0,
    tests_run: 0,
    denials: 0,
    tokens_in: 0,
    tokens_out: 0,
    model: "",
  };
  for (const line of lines) {
    let ev: Record<string, unknown>;
    try {
      ev = JSON.parse(line);
    } catch {
      continue;
    }
    if (ev.type === "assistant") {
      const content = ((ev.message as { content?: unknown[] })?.content ?? []) as {
        type: string;
        name?: string;
        input?: { command?: string };
      }[];
      for (const c of content) {
        if (c.type !== "tool_use") continue;
        s.tool_calls++;
        if (c.name === "Bash" && /\bacdc-test\b/.test(c.input?.command ?? "")) s.tests_run++;
      }
    } else if (ev.type === "system" && ev.subtype === "init") {
      s.model = String(ev.model ?? "");
    } else if (ev.type === "result") {
      const u = (ev.usage ?? {}) as Record<string, number>;
      s.ok = ev.subtype === "success" && !ev.is_error;
      s.error = s.ok ? "" : String(ev.subtype ?? "error");
      s.result = String(ev.result ?? "");
      s.cost_usd = Number(ev.total_cost_usd ?? 0);
      s.turns = Number(ev.num_turns ?? 0);
      s.tokens_in =
        (u.input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0);
      s.tokens_out = u.output_tokens ?? 0;
      s.denials = ((ev.permission_denials as unknown[]) ?? []).length;
    }
  }
  return s;
}

export function runAgent(opts: {
  prompt: string;
  cwd: string;
  binDir: string;
  model: string;
  budget: number;
  timeoutS: number;
  transcript: string;
}): Promise<Session> {
  mkdirSync(dirname(opts.transcript), { recursive: true });
  const [bin, ...args] = command(opts.model, opts.budget);
  const env: Record<string, string> = {
    HOME: process.env.HOME ?? "/root",
    PATH: `${opts.binDir}:${process.env.PATH ?? "/usr/bin:/bin"}`,
  };
  if (process.env.ACDC_FAKE_SCRIPT) env.ACDC_FAKE_SCRIPT = process.env.ACDC_FAKE_SCRIPT;
  const t0 = Date.now();
  return new Promise((resolve) => {
    // the prompt goes on stdin: command lines are visible to every process on the machine
    const p = spawn(bin as string, args, {
      cwd: opts.cwd,
      env,
      stdio: ["pipe", "pipe", "pipe"],
      detached: true,
    });
    const out = createWriteStream(opts.transcript);
    const lines: string[] = [];
    let buf = "";
    let err = "";
    let timedOut = false;
    p.stdout.on("data", (d: Buffer) => {
      out.write(d);
      buf += d.toString();
      const parts = buf.split("\n");
      buf = parts.pop() ?? "";
      lines.push(...parts);
    });
    p.stderr.on("data", (d: Buffer) => {
      err = (err + d.toString()).slice(-2000);
    });
    const timer = setTimeout(() => {
      timedOut = true;
      try {
        process.kill(-(p.pid as number), "SIGKILL");
      } catch {}
    }, opts.timeoutS * 1000);
    p.on("close", (code) => {
      clearTimeout(timer);
      if (buf) lines.push(buf);
      out.end();
      const s = parse(lines);
      const session: Session = { ...s, seconds: Math.round((Date.now() - t0) / 1000) };
      if (timedOut) {
        session.ok = false;
        session.error = "timeout";
        session.cost_usd = Math.max(session.cost_usd, opts.budget); // a killed session reports no cost
      } else if (!lines.length) {
        session.error = `no output (exit ${code}): ${err.trim().slice(0, 300)}`;
      } else if (!lines.some((l) => l.includes('"type":"result"'))) {
        // the CLI exited before it reported a result: an infrastructure failure, not the model's answer
        session.error = `ended without a result (exit ${code}): ${err.trim().slice(0, 300)}`;
      }
      resolve(session);
    });
    p.stdin.end(opts.prompt);
  });
}
