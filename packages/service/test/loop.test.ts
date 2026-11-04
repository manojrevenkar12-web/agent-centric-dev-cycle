import { createHmac } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { ROOT, parseOwners } from "@acdc/core";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  type CodeHost,
  type Tracker,
  eventFromGitHub,
  issueFromLinear,
  verifySignature,
} from "../src/adapters.js";
import { Cycle, type ExecResult, type Executor } from "../src/loop.js";
import { metrics } from "../src/metrics.js";
import { build } from "../src/server.js";
import { type Issue, Store } from "../src/store.js";

const URL = process.env.ACDC_TEST_DATABASE_URL;
const OWNERS = parseOwners(readFileSync(join(ROOT, "data/n8n/OWNERS"), "utf8"));

describe("webhook adapters", () => {
  it("verifies HMAC signatures in constant time and rejects anything else", () => {
    const body = '{"a":1}';
    const sig = createHmac("sha256", "s3cret").update(body).digest("hex");
    expect(verifySignature("s3cret", body, sig)).toBe(true);
    expect(verifySignature("s3cret", body, `sha256=${sig}`, "sha256=")).toBe(true);
    expect(verifySignature("s3cret", `${body} `, sig)).toBe(false);
    expect(verifySignature("", body, sig)).toBe(false);
    expect(verifySignature("s3cret", body, undefined)).toBe(false);
  });

  it("takes only labelled Linear issues and maps labels to categories", () => {
    const p = (labels: string[]) => ({
      action: "create",
      type: "Issue",
      data: { id: "i1", identifier: "DEV-1", title: "t", labels: labels.map((name) => ({ name })) },
    });
    expect(issueFromLinear(p(["Bug"]))).toBeNull();
    expect(issueFromLinear(p(["agent", "Bug"]))?.category).toBe("bugfix");
    expect(issueFromLinear(p(["agent", "security", "bug"]))?.category).toBe("security");
    expect(issueFromLinear(p(["agent"]))?.category).toBe("feature");
    expect(issueFromLinear({ ...p(["agent"]), type: "Comment" })).toBeNull();
  });

  it("reads CI, review and merge events from GitHub", () => {
    expect(
      eventFromGitHub("check_suite", {
        action: "completed",
        check_suite: { conclusion: "failure", pull_requests: [{ number: 7 }] },
      }),
    ).toEqual({ kind: "ci", pr: 7, conclusion: "failure" });
    expect(
      eventFromGitHub("pull_request_review", {
        action: "submitted",
        review: { state: "CHANGES_REQUESTED", body: "add a test", user: { login: "r" } },
        pull_request: { number: 7 },
      }),
    ).toMatchObject({ kind: "review", state: "changes_requested" });
    expect(
      eventFromGitHub("pull_request", { action: "closed", pull_request: { number: 7, merged: true } }),
    ).toEqual({ kind: "closed", pr: 7, merged: true });
    expect(eventFromGitHub("push", {})).toBeNull();
  });
});

class FakeTracker implements Tracker {
  comments: { issue: string; body: string }[] = [];
  async comment(issue: string, body: string) {
    this.comments.push({ issue, body });
  }
}
class FakeHost implements CodeHost {
  prs: { branch: string; title: string; body: string; draft: boolean; teams: string[] }[] = [];
  comments: { pr: number; body: string }[] = [];
  async openPr(pr: FakeHost["prs"][number]) {
    this.prs.push(pr);
    return { number: 100 + this.prs.length };
  }
  async comment(pr: number, body: string) {
    this.comments.push({ pr, body });
  }
}
class FakeExecutor implements Executor {
  calls: { attempt: number; feedback?: string }[] = [];
  constructor(public result: (attempt: number) => Partial<ExecResult>) {}
  async run(_i: Issue, o: { attempt: number; branch: string; feedback?: string }): Promise<ExecResult> {
    this.calls.push({ attempt: o.attempt, feedback: o.feedback });
    return {
      ok: true,
      branch: o.branch,
      files: ["packages/workflow/src/expression.ts", "packages/workflow/test/expression.test.ts"],
      cost_usd: 0.4,
      tests_run: 2,
      checks: { tests: true, typecheck: true, lint: true },
      claim: {
        summary: "Fixed the printer",
        verification: "acdc-test: 120 passed",
        tests_pass: true,
        risks: [],
      },
      ...this.result(o.attempt),
    };
  }
}

const issue = (over: Partial<Issue> = {}): Issue => ({
  id: `i-${Math.random().toString(36).slice(2)}`,
  key: "DEV-42",
  title: "Expressions lose parentheses",
  body: "Repro: …",
  labels: ["agent", "bug"],
  category: "bugfix",
  ...over,
});

describe.skipIf(!URL)("the loop on PostgreSQL", () => {
  let store: Store;
  let tracker: FakeTracker;
  let host: FakeHost;
  let exec: FakeExecutor;
  let cycle: Cycle;
  const lowRisk = () => ({ p: 0.05, tier: "low" as const });

  beforeAll(async () => {
    store = Store.connect(URL as string);
    await store.pool.query("drop table if exists events, deliveries, runs, issues cascade");
    await store.migrate();
  });
  afterAll(async () => store.close());
  beforeEach(async () => {
    await store.pool.query("alter table events disable trigger events_no_change");
    await store.pool.query("truncate events, deliveries, runs, issues");
    await store.pool.query("alter table events enable trigger events_no_change");
    tracker = new FakeTracker();
    host = new FakeHost();
    exec = new FakeExecutor(() => ({}));
    cycle = new Cycle(store, tracker, host, exec, OWNERS, lowRisk);
  });

  it("takes a bug from issue to a reviewed PR with evidence", async () => {
    const run = await cycle.onIssue(issue());
    expect(run).toMatchObject({ state: "pr_open", level: "agent_reviewed", pr_number: 101 });
    expect(host.prs[0]?.draft).toBe(false);
    expect(host.prs[0]?.body).toContain("### Where a person decides");
    expect(host.prs[0]?.body).toContain("Closes DEV-42");
    expect(tracker.comments.at(-1)?.body).toContain("#101");
    expect((await store.events(run?.id as string)).map((e) => e.kind)).toEqual([
      "preflight",
      "agent_finished",
      "decision",
      "pr_opened",
    ]);
  });

  it("never lets an agent start security work, and says why on the issue", async () => {
    const run = await cycle.onIssue(issue({ category: "security", labels: ["agent", "security"] }));
    expect(run?.state).toBe("blocked");
    expect(exec.calls).toHaveLength(0);
    expect(tracker.comments[0]?.body).toMatch(/will not take this issue/);
  });

  it("discards a change that touches a forbidden path instead of opening a PR", async () => {
    exec.result = () => ({ files: ["packages/workflow/src/x.ts", ".github/workflows/ci.yml"] });
    const run = await cycle.onIssue(issue());
    expect(run?.state).toBe("rejected");
    expect(host.prs).toHaveLength(0);
  });

  it("opens sensitive changes as drafts with security reviewers", async () => {
    exec.result = () => ({ files: ["packages/cli/src/auth/auth.service.ts"] });
    const run = await cycle.onIssue(issue());
    expect(run?.level).toBe("agent_draft");
    expect(host.prs[0]).toMatchObject({ draft: true });
    expect(host.prs[0]?.teams).toContain("@n8n-io/iam");
  });

  it("starts one run per issue even when Linear sends the update twice", async () => {
    const i = issue();
    exec.result = () => ({ ok: false, files: [] });
    await store.upsertIssue(i);
    const a = await store.createRun(i.id);
    const b = await store.createRun(i.id);
    expect(a).not.toBeNull();
    expect(b).toBeNull();
  });

  it("answers review with a rework, then hands over to a person", async () => {
    const run = await cycle.onIssue(issue());
    const pr = run?.pr_number as number;
    await cycle.onGitHub({
      kind: "review",
      pr,
      state: "changes_requested",
      body: "cover the ?? case",
      reviewer: "r1",
    });
    expect(exec.calls.at(-1)).toEqual({ attempt: 2, feedback: "cover the ?? case" });
    expect(host.comments.at(-1)?.body).toMatch(/^Rework 1 after review/);
    await cycle.onGitHub({
      kind: "review",
      pr,
      state: "changes_requested",
      body: "still not",
      reviewer: "r1",
    });
    await cycle.onGitHub({ kind: "review", pr, state: "changes_requested", body: "again", reviewer: "r1" });
    expect(exec.calls).toHaveLength(3); // the first run and two reworks (max_rework: 2)
    expect(host.comments.at(-1)?.body).toMatch(/A person takes it from here/);
    expect((await store.run(run?.id as string))?.state).toBe("changes_requested");
  });

  it("flags an agent that says the tests pass when they do not", async () => {
    exec.result = () => ({ checks: { tests: false, typecheck: true, lint: true } });
    await cycle.onIssue(issue());
    expect(host.prs[0]?.body).toContain(
      "The agent said the tests pass; the executor's run says they do not.",
    );
  });

  it("computes acceptance, CI, rework, cost and satisfaction from events", async () => {
    const a = await cycle.onIssue(issue());
    const b = await cycle.onIssue(issue({ key: "DEV-43" }));
    await cycle.onGitHub({ kind: "ci", pr: a?.pr_number as number, conclusion: "success" });
    await cycle.onGitHub({ kind: "ci", pr: b?.pr_number as number, conclusion: "failure" });
    await cycle.onGitHub({
      kind: "review",
      pr: a?.pr_number as number,
      state: "approved",
      body: "",
      reviewer: "r",
    });
    await cycle.onGitHub({
      kind: "review",
      pr: b?.pr_number as number,
      state: "changes_requested",
      body: "x",
      reviewer: "r",
    });
    await cycle.onGitHub({ kind: "closed", pr: a?.pr_number as number, merged: true });
    await cycle.feedback(a?.id as string, 4, "saved me an hour");
    const m = metrics(await store.runs(), await store.allEvents());
    expect(m).toMatchObject({
      prs_opened: 2,
      merged: 1,
      reviewer_acceptance_rate: 0.5,
      ci_pass_rate: 0.5,
      rework_rate: 0.5,
    });
    expect(m.cost_usd).toBeCloseTo(1.2); // two runs and one rework at $0.40
    expect(m.cost_per_merged_usd).toBeCloseTo(1.2);
    expect(m.satisfaction).toEqual({ mean: 4, responses: 1 });
    await expect(cycle.feedback(a?.id as string, 9, "")).rejects.toThrow(/1 to 5/);
  });

  it("keeps the event log append-only", async () => {
    const run = await cycle.onIssue(issue());
    await expect(
      store.pool.query("update events set kind = 'x' where run_id = $1", [run?.id]),
    ).rejects.toThrow(/append-only/);
    await expect(store.pool.query("delete from events where run_id = $1", [run?.id])).rejects.toThrow(
      /append-only/,
    );
  });

  it("marks runs interrupted by a restart as failed", async () => {
    const i = issue();
    await store.upsertIssue(i);
    const r = await store.createRun(i.id);
    await store.update(r?.id as string, { state: "running" });
    expect(await cycle.recover()).toBe(1);
    expect((await store.run(r?.id as string))?.state).toBe("failed");
  });

  describe("HTTP", () => {
    const secrets = { linearWebhook: "lin", githubWebhook: "gh" };
    const sign = (s: string, b: string) => createHmac("sha256", s).update(b).digest("hex");

    it("rejects unsigned webhooks, accepts signed ones once, and serves the run", async () => {
      const app = build(cycle, secrets);
      const body = JSON.stringify({
        action: "create",
        type: "Issue",
        data: {
          id: "lin-1",
          identifier: "DEV-7",
          title: "Fix it",
          labels: [{ name: "agent" }, { name: "bug" }],
        },
      });
      const headers = { "content-type": "application/json", "linear-delivery": "d1" };
      expect(
        (
          await app.inject({
            method: "POST",
            url: "/webhooks/linear",
            payload: body,
            headers: { ...headers, "linear-signature": "nope" },
          })
        ).statusCode,
      ).toBe(401);
      const ok = await app.inject({
        method: "POST",
        url: "/webhooks/linear",
        payload: body,
        headers: { ...headers, "linear-signature": sign("lin", body) },
      });
      expect(ok.statusCode).toBe(202);
      const again = await app.inject({
        method: "POST",
        url: "/webhooks/linear",
        payload: body,
        headers: { ...headers, "linear-signature": sign("lin", body) },
      });
      expect(again.json()).toEqual({ duplicate: true });
      await cycle.enqueue(async () => undefined); // let the queued run finish
      const runs = (await app.inject({ url: "/v1/runs" })).json().runs;
      expect(runs).toHaveLength(1);
      const one = (await app.inject({ url: `/v1/runs/${runs[0].id}` })).json();
      expect(one.issue.key).toBe("DEV-7");
      expect(one.events.map((e: { kind: string }) => e.kind)).toContain("pr_opened");
      expect((await app.inject({ url: "/v1/runs/not-a-uuid" })).statusCode).toBe(404);
      const gh = JSON.stringify({
        action: "completed",
        check_suite: { conclusion: "success", pull_requests: [{ number: runs[0].pr_number }] },
      });
      const ci = await app.inject({
        method: "POST",
        url: "/webhooks/github",
        payload: gh,
        headers: {
          "content-type": "application/json",
          "x-github-event": "check_suite",
          "x-github-delivery": "g1",
          "x-hub-signature-256": `sha256=${sign("gh", gh)}`,
        },
      });
      expect(ci.statusCode).toBe(202);
      await cycle.enqueue(async () => undefined);
      expect((await app.inject({ url: "/v1/metrics" })).json().ci_pass_rate).toBe(1);
      expect(
        (await app.inject({ method: "POST", url: `/v1/runs/${runs[0].id}/feedback`, payload: { score: 0 } }))
          .statusCode,
      ).toBe(400);
      expect((await app.inject({ url: "/v1/policy" })).json().categories.security.max_level).toBe(
        "human_only",
      );
    });
  });
});
