/** PostgreSQL store for issues, runs and the append-only event log. */
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";

export type RunState =
  | "queued"
  | "blocked"
  | "running"
  | "failed"
  | "rejected"
  | "pr_open"
  | "changes_requested"
  | "merged"
  | "closed";

export type Issue = {
  id: string;
  key: string;
  title: string;
  body: string;
  labels: string[];
  category: string;
};
export type Run = {
  id: string;
  issue_id: string;
  state: RunState;
  level: string | null;
  attempt: number;
  pr_number: number | null;
  cost_usd: number;
  evidence: string | null;
  decision: unknown;
  created_at: string;
  updated_at: string;
};
export type Event = { id: number; run_id: string; at: string; kind: string; data: Record<string, unknown> };

export class Store {
  constructor(readonly pool: pg.Pool) {}

  static connect(url: string) {
    return new Store(new pg.Pool({ connectionString: url, max: 10 }));
  }

  async migrate() {
    const sql = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "schema.sql"), "utf8");
    await this.pool.query(sql);
  }

  async close() {
    await this.pool.end();
  }

  /** true the first time a delivery is seen, false for a provider's retry */
  async firstDelivery(source: string, id: string): Promise<boolean> {
    const r = await this.pool.query(
      "insert into deliveries(source, id) values ($1, $2) on conflict do nothing",
      [source, id],
    );
    return r.rowCount === 1;
  }

  async upsertIssue(i: Issue) {
    await this.pool.query(
      `insert into issues(id, key, title, body, labels, category) values ($1,$2,$3,$4,$5,$6)
       on conflict (id) do update set title = excluded.title, body = excluded.body, labels = excluded.labels, category = excluded.category`,
      [i.id, i.key, i.title, i.body, JSON.stringify(i.labels), i.category],
    );
  }

  async issue(id: string): Promise<Issue | null> {
    const r = await this.pool.query(
      "select id, key, title, body, labels, category from issues where id = $1",
      [id],
    );
    return (r.rows[0] as Issue) ?? null;
  }

  /** A new run, unless the issue already has one in flight (the unique index decides, not a read). */
  async createRun(issueId: string, attempt = 1): Promise<Run | null> {
    try {
      const r = await this.pool.query(
        "insert into runs(id, issue_id, state, attempt) values ($1, $2, 'queued', $3) returning *",
        [randomUUID(), issueId, attempt],
      );
      return toRun(r.rows[0]);
    } catch (e) {
      if ((e as { code?: string }).code === "23505") return null;
      throw e;
    }
  }

  async update(
    id: string,
    fields: Partial<Pick<Run, "state" | "level" | "pr_number" | "cost_usd" | "evidence" | "decision">>,
  ) {
    const keys = Object.keys(fields) as (keyof typeof fields)[];
    if (!keys.length) return;
    const sets = keys.map((k, i) => `${k} = $${i + 2}`).join(", ");
    const vals = keys.map((k) => (k === "decision" ? JSON.stringify(fields[k]) : fields[k]));
    await this.pool.query(`update runs set ${sets}, updated_at = now() where id = $1`, [id, ...vals]);
  }

  async addCost(id: string, usd: number) {
    await this.pool.query("update runs set cost_usd = cost_usd + $2, updated_at = now() where id = $1", [
      id,
      usd,
    ]);
  }

  async event(runId: string, kind: string, data: Record<string, unknown> = {}) {
    await this.pool.query("insert into events(run_id, kind, data) values ($1, $2, $3)", [
      runId,
      kind,
      JSON.stringify(data),
    ]);
  }

  async run(id: string): Promise<Run | null> {
    const r = await this.pool.query("select * from runs where id = $1", [id]);
    return r.rows[0] ? toRun(r.rows[0]) : null;
  }

  async runByPr(pr: number): Promise<Run | null> {
    const r = await this.pool.query("select * from runs where pr_number = $1", [pr]);
    return r.rows[0] ? toRun(r.rows[0]) : null;
  }

  async runs(
    filter: { state?: string; limit?: number } = {},
  ): Promise<(Run & { issue_key: string; title: string; category: string })[]> {
    const r = await this.pool.query(
      `select runs.*, issues.key as issue_key, issues.title, issues.category from runs join issues on issues.id = runs.issue_id
       where ($1::text is null or runs.state = $1) order by runs.created_at desc limit $2`,
      [filter.state ?? null, filter.limit ?? 100],
    );
    return r.rows.map((row) => ({
      ...toRun(row),
      issue_key: row.issue_key,
      title: row.title,
      category: row.category,
    }));
  }

  async events(runId: string): Promise<Event[]> {
    const r = await this.pool.query(
      "select id, run_id, at, kind, data from events where run_id = $1 order by id",
      [runId],
    );
    return r.rows.map((e) => ({ ...e, id: Number(e.id), at: new Date(e.at).toISOString() }));
  }

  async allEvents(): Promise<Event[]> {
    const r = await this.pool.query("select id, run_id, at, kind, data from events order by id");
    return r.rows.map((e) => ({ ...e, id: Number(e.id), at: new Date(e.at).toISOString() }));
  }
}

function toRun(row: Record<string, unknown>): Run {
  return {
    ...(row as unknown as Run),
    cost_usd: Number(row.cost_usd),
    created_at: new Date(row.created_at as string).toISOString(),
    updated_at: new Date(row.updated_at as string).toISOString(),
  };
}
