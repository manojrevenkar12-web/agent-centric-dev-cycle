import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { api } from "../../shared/api/client";
import type { BenchRun, Studies } from "../../shared/api/types";
import { Evidence } from "../../shared/ui/Evidence";
import { Empty, ErrorState, Skeleton } from "../../shared/ui/States";
import { pct, usd } from "../../shared/ui/format";

export function BenchScreen() {
  const studies = useQuery({ queryKey: ["studies"], queryFn: () => api.get<Studies>("/v1/studies") });
  const runs = useQuery({
    queryKey: ["bench-runs"],
    queryFn: () => api.get<{ runs: BenchRun[] }>("/v1/bench/runs"),
  });
  const [pick, setPick] = useState<{ task: string; setup: string } | null>(null);
  const failed = studies.isError ? studies : runs.isError ? runs : null;
  return (
    <>
      <h1>Benchmark</h1>
      <p className="lede">
        Real n8n fixes replayed as issues: each agent starts at the commit before the fix, and the fix's own
        tests, hidden from it, decide whether it solved the problem.
      </p>
      {(studies.isPending || runs.isPending) && <Skeleton rows={6} label="Loading the benchmark" />}
      {failed && <ErrorState what="the benchmark" error={failed.error} retry={() => failed.refetch()} />}
      {studies.isSuccess && runs.isSuccess && (!studies.data.bench || runs.data.runs.length === 0) && (
        <Empty title="No benchmark run yet">
          <p>
            Run <code>pnpm acdc run</code> with an n8n checkout, then <code>pnpm acdc report</code>.
          </p>
        </Empty>
      )}
      {studies.isSuccess && runs.isSuccess && studies.data.bench && runs.data.runs.length > 0 && (
        <Results studies={studies.data} runs={runs.data.runs} pick={pick} setPick={setPick} />
      )}
    </>
  );
}

function Results({
  studies,
  runs,
  pick,
  setPick,
}: {
  studies: Studies;
  runs: BenchRun[];
  pick: { task: string; setup: string } | null;
  setPick: (p: { task: string; setup: string }) => void;
}) {
  const bench = studies.bench as NonNullable<Studies["bench"]>;
  const setups = bench.per.map((p) => p.setup);
  const tasks = [...new Set(runs.map((r) => r.task))].sort();
  const cell = new Map(runs.map((r) => [`${r.task}|${r.setup}`, r]));
  const chosen = pick ? cell.get(`${pick.task}|${pick.setup}`) : undefined;
  return (
    <>
      <section aria-labelledby="setups-title">
        <h2 id="setups-title">
          {bench.tasks} tasks, each setup once, {usd(bench.spent_usd)} spent
        </h2>
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th scope="col">Setup</th>
                <th scope="col" className="num">
                  Resolved
                </th>
                <th scope="col">95% interval</th>
                <th scope="col" className="num">
                  CI green
                </th>
                <th scope="col" className="num">
                  Mergeable
                </th>
                <th scope="col" className="num">
                  Ran tests itself
                </th>
                <th scope="col" className="num">
                  Said pass, wasn't
                </th>
                <th scope="col" className="num">
                  Per resolved
                </th>
              </tr>
            </thead>
            <tbody>
              {bench.per.map((p) => (
                <tr key={p.setup}>
                  <th scope="row">
                    {p.model}, {p.context === "repo" ? "with AGENTS.md" : "without"}
                  </th>
                  <td className="num">
                    {p.resolved} of {p.runs}
                  </td>
                  <td>
                    {pct(p.resolved_ci95[0])} to {pct(p.resolved_ci95[1])}
                  </td>
                  <td className="num">{pct(p.ci_pass_rate)}</td>
                  <td className="num">{pct(p.mergeable_rate)}</td>
                  <td className="num">{pct(p.self_verified_rate)}</td>
                  <td className="num">{pct(p.overclaim_rate)}</td>
                  <td className="num">{usd(p.cost_per_resolved_usd)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>
      <section aria-labelledby="paired-title">
        <h2 id="paired-title">Does n8n's AGENTS.md help?</h2>
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th scope="col">Model</th>
                <th scope="col" className="num">
                  Tasks
                </th>
                <th scope="col" className="num">
                  Solved only with it
                </th>
                <th scope="col" className="num">
                  Solved only without
                </th>
                <th scope="col" className="num">
                  Sign test p
                </th>
              </tr>
            </thead>
            <tbody>
              {bench.paired.map((p) => (
                <tr key={p.model}>
                  <th scope="row">{p.model}</th>
                  <td className="num">{p.tasks}</td>
                  <td className="num">{p.only_with_agents_md}</td>
                  <td className="num">{p.only_without}</td>
                  <td className="num">{p.p_value.toFixed(2)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>
      <section aria-labelledby="matrix-title">
        <h2 id="matrix-title">Every run</h2>
        <p>Choose a run to read the pull request evidence it would have carried.</p>
        <div className="table-wrap">
          <table className="matrix">
            <thead>
              <tr>
                <th scope="col">Task</th>
                {setups.map((s) => (
                  <th scope="col" key={s}>
                    {s}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {tasks.map((t) => (
                <tr key={t}>
                  <th scope="row">
                    <span className="path">{t}</span>
                  </th>
                  {setups.map((s) => {
                    const r = cell.get(`${t}|${s}`);
                    if (!r)
                      return (
                        <td key={s}>
                          <span className="visually-hidden">not run</span>–
                        </td>
                      );
                    const on = pick?.task === t && pick.setup === s;
                    return (
                      <td key={s}>
                        <button
                          type="button"
                          className="cell"
                          data-ok={r.resolved}
                          aria-pressed={on}
                          aria-label={`${t}, ${s}: ${r.resolved ? "resolved" : "not resolved"}`}
                          onClick={() => setPick({ task: t, setup: s })}
                        >
                          {r.resolved ? "✓" : "✗"}
                        </button>
                      </td>
                    );
                  })}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>
      {chosen && (
        <section className="panel" aria-labelledby="ev-title">
          <h2 id="ev-title">
            {chosen.task}, {chosen.setup}: {chosen.resolved ? "resolved" : "not resolved"}
          </h2>
          <p className="state-word">
            {usd(chosen.cost_usd)}, {Math.round(chosen.seconds / 60)} min, ran tests {chosen.tests_run}{" "}
            time(s)
          </p>
          <Evidence markdown={chosen.evidence} />
        </section>
      )}
    </>
  );
}
