/** HTTP API: webhooks in (Linear, GitHub; signed, deduplicated, answered at once), read models out
 * (runs, evidence, metrics, the safety model, the studies) for the console. */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { LEVELS, ROOT, loadConfig } from "@acdc/core";
import Fastify, { type FastifyInstance } from "fastify";
import { eventFromGitHub, issueFromLinear, verifySignature } from "./adapters.js";
import type { Cycle } from "./loop.js";
import { metrics } from "./metrics.js";

export type Secrets = { linearWebhook: string; githubWebhook: string };

const report = (name: string) => {
  const p = join(ROOT, "reports", name);
  return existsSync(p) ? JSON.parse(readFileSync(p, "utf8")) : null;
};

export function build(cycle: Cycle, secrets: Secrets): FastifyInstance {
  const app = Fastify({ logger: false, bodyLimit: 5 * 1024 * 1024 });
  // keep the raw body: signatures are computed over the exact bytes the provider sent
  app.addContentTypeParser("application/json", { parseAs: "buffer" }, (req, body, done) => {
    (req as unknown as { raw_body: Buffer }).raw_body = body as Buffer;
    try {
      done(null, (body as Buffer).length ? JSON.parse((body as Buffer).toString("utf8")) : {});
    } catch (e) {
      done(e as Error, undefined);
    }
  });
  const raw = (req: unknown) => (req as { raw_body?: Buffer }).raw_body ?? Buffer.alloc(0);

  app.get("/healthz", async () => ({ ok: true }));

  app.post("/webhooks/linear", async (req, reply) => {
    if (
      !verifySignature(secrets.linearWebhook, raw(req), req.headers["linear-signature"] as string | undefined)
    )
      return reply.code(401).send({ error: "bad signature" });
    const delivery = String(req.headers["linear-delivery"] ?? "");
    if (!delivery) return reply.code(400).send({ error: "no delivery id" });
    if (!(await cycle.store.firstDelivery("linear", delivery)))
      return reply.code(200).send({ duplicate: true });
    const issue = issueFromLinear(req.body as Parameters<typeof issueFromLinear>[0]);
    if (!issue) return reply.code(200).send({ ignored: true });
    void cycle.enqueue(() => cycle.onIssue(issue)).catch((e) => app.log.error(e));
    return reply.code(202).send({ accepted: issue.key });
  });

  app.post("/webhooks/github", async (req, reply) => {
    if (
      !verifySignature(
        secrets.githubWebhook,
        raw(req),
        req.headers["x-hub-signature-256"] as string | undefined,
        "sha256=",
      )
    )
      return reply.code(401).send({ error: "bad signature" });
    const delivery = String(req.headers["x-github-delivery"] ?? "");
    if (!delivery) return reply.code(400).send({ error: "no delivery id" });
    if (!(await cycle.store.firstDelivery("github", delivery)))
      return reply.code(200).send({ duplicate: true });
    const ev = eventFromGitHub(
      String(req.headers["x-github-event"] ?? ""),
      req.body as Record<string, unknown>,
    );
    if (!ev) return reply.code(200).send({ ignored: true });
    void cycle.enqueue(() => cycle.onGitHub(ev)).catch((e) => app.log.error(e));
    return reply.code(202).send({ accepted: ev.kind });
  });

  app.get("/v1/runs", async (req) => {
    const q = req.query as { state?: string };
    return { runs: await cycle.store.runs({ state: q.state || undefined }) };
  });

  app.get("/v1/runs/:id", async (req, reply) => {
    const { id } = req.params as { id: string };
    if (!/^[0-9a-f-]{36}$/.test(id)) return reply.code(404).send({ error: "no such run" });
    const run = await cycle.store.run(id);
    if (!run) return reply.code(404).send({ error: "no such run" });
    const issue = await cycle.store.issue(run.issue_id);
    return { run, issue, events: await cycle.store.events(id) };
  });

  app.post("/v1/runs/:id/feedback", async (req, reply) => {
    const { id } = req.params as { id: string };
    const b = req.body as { score?: number; comment?: string };
    if (!(await cycle.store.run(id).catch(() => null))) return reply.code(404).send({ error: "no such run" });
    try {
      await cycle.feedback(id, Number(b.score), String(b.comment ?? ""));
    } catch (e) {
      return reply.code(400).send({ error: (e as Error).message });
    }
    return reply.code(201).send({ ok: true });
  });

  app.get("/v1/metrics", async () =>
    metrics(await cycle.store.runs({ limit: 10_000 }), await cycle.store.allEvents()),
  );

  app.get("/v1/policy", async () => {
    const s = loadConfig<Record<string, unknown>>("safety");
    return { levels: LEVELS, ...s };
  });

  app.get("/v1/studies", async () => ({
    risk: report("risk.json"),
    bench: report("bench.json"),
    owners: report("owners-check.json"),
  }));

  app.get("/v1/bench/runs", async () => {
    const { loadRuns } = await import("@acdc/bench/report");
    return {
      runs: loadRuns().map((r) => ({
        task: r.task,
        setup: r.setup,
        resolved: !!r.grade?.resolved,
        ci_pass: !!r.grade?.ci_pass,
        mergeable: !!r.grade?.mergeable,
        overclaim: !!r.grade?.claim.overclaim,
        level: r.grade?.policy.level ?? null,
        cost_usd: r.session.cost_usd,
        seconds: r.session.seconds,
        tests_run: r.session.tests_run,
        evidence: r.evidence,
        judge: r.judge
          ? {
              verdict: r.judge.verdict,
              cause: r.judge.cause,
              accept: r.judge.reviewer_would_accept,
              reason: r.judge.reason,
            }
          : null,
      })),
    };
  });

  return app;
}
