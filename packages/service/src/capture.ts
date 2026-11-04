/** Record the console's e2e fixtures from the API, over a database filled by replay.ts.
 *
 *   ACDC_DATABASE_URL=... tsx src/replay.ts sonnet-repo && ACDC_DATABASE_URL=... tsx src/capture.ts
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ROOT, parseOwners } from "@acdc/core";
import { Cycle } from "./loop.js";
import { build } from "./server.js";
import { Store } from "./store.js";

const url = process.env.ACDC_DATABASE_URL;
if (!url) throw new Error("ACDC_DATABASE_URL is not set");
const store = Store.connect(url);
const none = async () => {
  throw new Error("capture never runs agents");
};
const cycle = new Cycle(
  store,
  { comment: none },
  { openPr: none, comment: none },
  { run: none },
  parseOwners(readFileSync(join(ROOT, "data/n8n/OWNERS"), "utf8")),
  () => ({ p: 0, tier: "low" }),
);
const app = build(cycle, { linearWebhook: "unused", githubWebhook: "unused" });
const out = join(ROOT, "apps/console/e2e/fixtures");
mkdirSync(out, { recursive: true });
const get = async (path: string) => (await app.inject({ url: path })).json();
const runs = await get("/v1/runs");
// the newest run that reached a pull request, so the detail shows evidence and the feedback form
const withPr = runs.runs.find((r: { pr_number: number | null }) => r.pr_number !== null) ?? runs.runs[0];
runs.runs = [withPr, ...runs.runs.filter((r: { id: string }) => r.id !== withPr.id)];
const fixtures: Record<string, unknown> = {
  runs,
  run: await get(`/v1/runs/${withPr.id}`),
  metrics: await get("/v1/metrics"),
  policy: await get("/v1/policy"),
  studies: await get("/v1/studies"),
  "bench-runs": await get("/v1/bench/runs"),
};
for (const [name, body] of Object.entries(fixtures))
  writeFileSync(join(out, `${name}.json`), `${JSON.stringify(body, null, 1)}\n`);
await store.close();
console.log(`wrote ${Object.keys(fixtures).length} fixtures to ${out}`);
