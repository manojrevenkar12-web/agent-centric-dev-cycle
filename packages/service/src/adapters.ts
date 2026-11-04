/** Linear and GitHub: webhook verification and the few calls the loop makes. Each has a real client
 * (fetch) and the interface the loop depends on, so tests run against fakes. */
import { createHmac, timingSafeEqual } from "node:crypto";
import { type Category, loadConfig } from "@acdc/core";
import type { Issue } from "./store.js";

export type ServiceCfg = {
  trigger_label: string;
  max_rework: number;
  branch_prefix: string;
  concurrency: number;
  model: string;
  budget_per_run_usd: number;
  timeout_s: number;
  categories: Record<string, Category>;
  github: { repo: string; base: string };
  linear: { api: string };
};
export const serviceCfg = () => loadConfig<ServiceCfg>("service");

/** HMAC-SHA256 over the raw body, compared in constant time. */
export function verifySignature(
  secret: string,
  raw: Buffer | string,
  signature: string | undefined,
  prefix = "",
): boolean {
  if (!secret || !signature) return false;
  const want = Buffer.from(prefix + createHmac("sha256", secret).update(raw).digest("hex"));
  const got = Buffer.from(signature);
  return want.length === got.length && timingSafeEqual(want, got);
}

export function categoryFor(labels: string[]): Category {
  const map = serviceCfg().categories;
  for (const [label, cat] of Object.entries(map))
    if (labels.some((l) => l.toLowerCase() === label)) return cat;
  return "feature";
}

type LinearIssuePayload = {
  action: string;
  type: string;
  data: {
    id: string;
    identifier: string;
    title: string;
    description?: string | null;
    labels?: { name: string }[];
  };
};

/** The issue from a Linear webhook, or null when it is not one for the loop. */
export function issueFromLinear(payload: LinearIssuePayload): Issue | null {
  if (payload.type !== "Issue" || !["create", "update"].includes(payload.action)) return null;
  const labels = (payload.data.labels ?? []).map((l) => l.name);
  if (!labels.some((l) => l.toLowerCase() === serviceCfg().trigger_label)) return null;
  return {
    id: payload.data.id,
    key: payload.data.identifier,
    title: payload.data.title,
    body: payload.data.description ?? "",
    labels,
    category: categoryFor(labels),
  };
}

export type GitHubEvent =
  | { kind: "ci"; pr: number; conclusion: string }
  | {
      kind: "review";
      pr: number;
      state: "approved" | "changes_requested" | "commented";
      body: string;
      reviewer: string;
    }
  | { kind: "closed"; pr: number; merged: boolean };

// biome-ignore lint/suspicious/noExplicitAny: GitHub payloads are read field by field and checked
export function eventFromGitHub(name: string, p: Record<string, any>): GitHubEvent | null {
  if (name === "check_suite" && p.action === "completed") {
    const pr = p.check_suite?.pull_requests?.[0]?.number;
    return pr ? { kind: "ci", pr, conclusion: String(p.check_suite.conclusion) } : null;
  }
  if (name === "pull_request_review" && p.action === "submitted") {
    const state = String(p.review?.state ?? "").toLowerCase();
    if (!["approved", "changes_requested", "commented"].includes(state)) return null;
    return {
      kind: "review",
      pr: p.pull_request.number,
      state: state as "approved",
      body: p.review.body ?? "",
      reviewer: p.review.user?.login ?? "",
    };
  }
  if (name === "pull_request" && p.action === "closed")
    return { kind: "closed", pr: p.pull_request.number, merged: !!p.pull_request.merged };
  return null;
}

export interface Tracker {
  comment(issueId: string, body: string): Promise<void>;
}

export interface CodeHost {
  openPr(pr: { branch: string; title: string; body: string; draft: boolean; teams: string[] }): Promise<{
    number: number;
  }>;
  comment(pr: number, body: string): Promise<void>;
}

export class LinearClient implements Tracker {
  constructor(private readonly key: string) {}
  async comment(issueId: string, body: string) {
    const r = await fetch(serviceCfg().linear.api, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: this.key },
      body: JSON.stringify({
        query: "mutation($input: CommentCreateInput!) { commentCreate(input: $input) { success } }",
        variables: { input: { issueId, body } },
      }),
    });
    if (!r.ok) throw new Error(`Linear ${r.status}`);
  }
}

export class GitHubClient implements CodeHost {
  constructor(private readonly token: string) {}
  private async call(path: string, body: unknown) {
    const r = await fetch(`https://api.github.com/repos/${serviceCfg().github.repo}${path}`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${this.token}`,
        accept: "application/vnd.github+json",
        "content-type": "application/json",
      },
      body: JSON.stringify(body),
    });
    if (!r.ok) throw new Error(`GitHub ${r.status} on ${path}`);
    return (await r.json()) as Record<string, unknown>;
  }
  async openPr(pr: { branch: string; title: string; body: string; draft: boolean; teams: string[] }) {
    const created = await this.call("/pulls", {
      title: pr.title,
      head: pr.branch,
      base: serviceCfg().github.base,
      body: pr.body,
      draft: pr.draft,
    });
    const number = Number(created.number);
    const slugs = pr.teams.map((t) => t.split("/")[1]).filter(Boolean);
    if (slugs.length) await this.call(`/pulls/${number}/requested_reviewers`, { team_reviewers: slugs });
    return { number };
  }
  async comment(pr: number, body: string) {
    await this.call(`/issues/${pr}/comments`, { body });
  }
}
