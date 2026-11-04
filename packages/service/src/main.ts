/** Start the loop service. Secrets come from the environment only; nothing has a default. */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileHistory, readHistory } from "@acdc/bench";
import { SandboxExecutor } from "@acdc/bench/executor";
import { ROOT, type RiskModel, features, loadConfig, parseOwners, predict, tier } from "@acdc/core";
import { GitHubClient, LinearClient, serviceCfg } from "./adapters.js";
import { Cycle } from "./loop.js";
import { build } from "./server.js";
import { Store } from "./store.js";

const need = (k: string) => {
  const v = process.env[k];
  if (!v) throw new Error(`${k} is not set`);
  return v;
};

const cfg = serviceCfg();
const store = Store.connect(need("ACDC_DATABASE_URL"));
await store.migrate();
const repo = need("N8N_REPO");
const owners = parseOwners(readFileSync(join(repo, "OWNERS"), "utf8"));
const model = JSON.parse(readFileSync(join(ROOT, "config/risk-model.json"), "utf8")) as RiskModel;
const sensitive = loadConfig<{ sensitive: { paths: string[] } }>("safety").sensitive.paths;
// the busiest-files feature needs the last month of fixes; read it from git at start and refresh hourly
let hist = fileHistory(readHistory(repo, "45 days ago"));
setInterval(() => {
  hist = fileHistory(readHistory(repo, "45 days ago"));
}, 3_600_000).unref();
const cycle = new Cycle(
  store,
  new LinearClient(need("LINEAR_API_KEY")),
  new GitHubClient(need("GITHUB_TOKEN")),
  new SandboxExecutor(repo, {
    model: cfg.model,
    budget: cfg.budget_per_run_usd,
    timeoutS: cfg.timeout_s,
    push: process.env.ACDC_PUSH === "1",
    base: cfg.github.base,
  }),
  owners,
  (files, title) => {
    const p = predict(
      model,
      features(
        { type: "fix", scope: "", subject: title, files, date: new Date().toISOString() },
        owners,
        hist,
        sensitive,
      ),
    );
    return { p, tier: tier(model, p) };
  },
);
const recovered = await cycle.recover();
const app = build(cycle, {
  linearWebhook: need("LINEAR_WEBHOOK_SECRET"),
  githubWebhook: need("GITHUB_WEBHOOK_SECRET"),
});
await app.listen({ port: Number(process.env.PORT ?? 8080), host: "0.0.0.0" });
console.log(
  `acdc service on :${process.env.PORT ?? 8080}${recovered ? `, ${recovered} interrupted run(s) marked failed` : ""}`,
);
