import AxeBuilder from "@axe-core/playwright";
import { type Page, type Route, expect, test } from "@playwright/test";
import benchRuns from "./fixtures/bench-runs.json" with { type: "json" };
import metrics from "./fixtures/metrics.json" with { type: "json" };
import policy from "./fixtures/policy.json" with { type: "json" };
import run from "./fixtures/run.json" with { type: "json" };
import runs from "./fixtures/runs.json" with { type: "json" };
import studies from "./fixtures/studies.json" with { type: "json" };

type Handler = (route: Route) => Promise<void>;

async function mockApi(page: Page, overrides: Record<string, Handler> = {}) {
  const posts: { path: string; body: unknown }[] = [];
  await page.route("**/v1/**", async (route) => {
    const p = new URL(route.request().url()).pathname;
    for (const [key, h] of Object.entries(overrides))
      if (p === key || p.startsWith(`${key}/`)) return h(route);
    if (route.request().method() === "POST") {
      posts.push({ path: p, body: route.request().postDataJSON() });
      return route.fulfill({ status: 201, json: { ok: true } });
    }
    if (p === "/v1/runs") return route.fulfill({ json: runs });
    if (p.startsWith("/v1/runs/")) return route.fulfill({ json: run });
    if (p === "/v1/metrics") return route.fulfill({ json: metrics });
    if (p === "/v1/policy") return route.fulfill({ json: policy });
    if (p === "/v1/studies") return route.fulfill({ json: studies });
    if (p === "/v1/bench/runs") return route.fulfill({ json: benchRuns });
    return route.fulfill({ status: 404, json: { error: "no such endpoint" } });
  });
  return posts;
}

async function accessible(page: Page) {
  await page.waitForFunction(() => document.getAnimations().every((a) => a.playState !== "running"));
  const r = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21aa"]).analyze();
  expect(r.violations.map((v) => `${v.id}: ${v.nodes.length}`)).toEqual([]);
}

test("runs open on the newest run with its ladder, evidence and events", async ({ page }) => {
  await mockApi(page);
  await page.goto("/");
  await expect(page.getByRole("heading", { name: "Agent runs" })).toBeVisible();
  await expect(page.getByRole("list", { name: "Runs" }).getByRole("listitem")).toHaveCount(runs.runs.length);
  await expect(page.getByRole("heading", { name: run.issue.title })).toBeVisible();
  await expect(page.getByRole("list", { name: "Autonomy for this change" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "What ran" })).toBeVisible();
  await expect(page.getByRole("list", { name: "Events" }).getByRole("listitem")).toHaveCount(
    run.events.length,
  );
  await accessible(page);
});

test("feedback on a pull request is saved and confirmed", async ({ page }) => {
  const posts = await mockApi(page);
  await page.goto(`/#/runs/${run.run.id}`);
  await page.getByLabel("Score").selectOption("5");
  await page.getByLabel("Comment").fill("Clear evidence, quick review");
  await page.getByRole("button", { name: "Save feedback" }).click();
  await expect(page.getByRole("status")).toHaveText("Feedback saved.");
  expect(posts[0]).toEqual({
    path: `/v1/runs/${run.run.id}/feedback`,
    body: { score: 5, comment: "Clear evidence, quick review" },
  });
});

test("runs show a skeleton while loading and say what to do when there are none", async ({ page }) => {
  await mockApi(page, {
    "/v1/runs": async (route) => {
      await new Promise((r) => setTimeout(r, 700));
      return route.fulfill({ json: { runs: [] } });
    },
  });
  await page.goto("/");
  await expect(page.getByLabel("Loading runs")).toBeVisible();
  await expect(page.getByRole("heading", { name: "No issue has reached an agent yet" })).toBeVisible();
});

test("a failed load explains itself and retries", async ({ page }) => {
  let calls = 0;
  await mockApi(page, {
    "/v1/metrics": async (route) => {
      calls += 1;
      if (calls <= 2) return route.fulfill({ status: 503, json: { error: "database restarting" } });
      return route.fulfill({ json: metrics });
    },
  });
  await page.goto("/#/signals");
  await expect(page.getByRole("alert")).toContainText("database restarting");
  await page.getByRole("button", { name: "Try again" }).click();
  await expect(page.getByRole("list", { name: "Signals" })).toBeVisible();
  await accessible(page);
});

test("the benchmark shows each setup, the AGENTS.md comparison and a run's evidence", async ({ page }) => {
  await mockApi(page);
  await page.goto("/#/bench");
  await expect(page.getByRole("heading", { name: "Does n8n's AGENTS.md help?" })).toBeVisible();
  const first = benchRuns.runs[0] as (typeof benchRuns.runs)[number];
  await page.getByRole("button", { name: new RegExp(`^${first.task}, ${first.setup}:`) }).click();
  await expect(
    page.getByRole("heading", { name: new RegExp(`^${first.task}, ${first.setup}`) }),
  ).toBeVisible();
  await accessible(page);
});

test("the safety model shows the history replay and what agents never touch", async ({ page }) => {
  await mockApi(page);
  await page.goto("/#/safety");
  await expect(
    page.getByRole("list", { name: "Changes by autonomy level" }).getByRole("listitem"),
  ).toHaveCount(4);
  await expect(page.getByRole("heading", { name: "Never touched by an agent" })).toBeVisible();
  await expect(page.getByText(".github/workflows/**")).toBeVisible();
  await accessible(page);
});

test("dark mode stays accessible", async ({ page }) => {
  await page.emulateMedia({ colorScheme: "dark" });
  await mockApi(page);
  for (const hash of ["#/runs", "#/safety"]) {
    await page.goto(`/${hash}`);
    await page.waitForLoadState("networkidle");
    await accessible(page);
  }
});

test("works on a phone without sideways scrolling", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await mockApi(page);
  for (const hash of ["#/runs", "#/signals", "#/bench", "#/safety"]) {
    await page.goto(`/${hash}`);
    await page.waitForLoadState("networkidle");
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
    expect(overflow, hash).toBeLessThanOrEqual(0);
  }
});
