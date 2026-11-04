import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { api } from "../../shared/api/client";
import type { RunDetail, RunItem } from "../../shared/api/types";
import { Evidence } from "../../shared/ui/Evidence";
import { Ladder } from "../../shared/ui/Ladder";
import { Empty, ErrorState, Skeleton } from "../../shared/ui/States";
import { STATE_NAMES, levelName, usd, when } from "../../shared/ui/format";

const FILTERS = ["", "pr_open", "changes_requested", "merged", "blocked", "rejected", "failed"];

export function LoopScreen({ id }: { id: string | null }) {
  const [state, setState] = useState("");
  const runs = useQuery({
    queryKey: ["runs", state],
    queryFn: () => api.get<{ runs: RunItem[] }>(`/v1/runs${state ? `?state=${state}` : ""}`),
  });
  const list = runs.data?.runs ?? [];
  const selected = id ?? list[0]?.id ?? null;
  return (
    <>
      <h1>Agent runs</h1>
      <p className="lede">
        Every Linear issue labelled for an agent, what the safety model allowed, and the pull request it led
        to.
      </p>
      <div className="filter">
        <label htmlFor="state-filter">Show</label>
        <select id="state-filter" value={state} onChange={(e) => setState(e.target.value)}>
          {FILTERS.map((f) => (
            <option key={f} value={f}>
              {f ? STATE_NAMES[f] : "All runs"}
            </option>
          ))}
        </select>
      </div>
      {runs.isPending && <Skeleton label="Loading runs" />}
      {runs.isError && <ErrorState what="runs" error={runs.error} retry={() => runs.refetch()} />}
      {runs.isSuccess && list.length === 0 && (
        <Empty title={state ? "No run in this state" : "No issue has reached an agent yet"}>
          <p>
            {state
              ? "Choose another state, or show all runs."
              : "Label a Linear issue “agent” and the loop takes it: preflight, an agent run, then a pull request with evidence."}
          </p>
        </Empty>
      )}
      {runs.isSuccess && list.length > 0 && (
        <div className="split">
          <ul className="runs" aria-label="Runs">
            {list.map((r) => (
              <li key={r.id}>
                <a href={`#/runs/${r.id}`} aria-current={r.id === selected ? "true" : undefined}>
                  <span>
                    <span className="key">{r.issue_key}</span> {r.title}
                  </span>
                  <span className="level" data-level={r.level ?? "human_only"}>
                    {levelName(r.level)}
                  </span>
                  <span className="state-word">{STATE_NAMES[r.state] ?? r.state}</span>
                  <span className="state-word">{r.pr_number ? `#${r.pr_number}` : ""}</span>
                </a>
              </li>
            ))}
          </ul>
          {selected && <RunPanel id={selected} />}
        </div>
      )}
    </>
  );
}

function RunPanel({ id }: { id: string }) {
  const q = useQuery({ queryKey: ["run", id], queryFn: () => api.get<RunDetail>(`/v1/runs/${id}`) });
  if (q.isPending) return <Skeleton rows={8} label="Loading the run" />;
  if (q.isError) return <ErrorState what="the run" error={q.error} retry={() => q.refetch()} />;
  const { run, issue, events } = q.data;
  const pre = events.find((e) => e.kind === "preflight")?.data.level as string | undefined;
  return (
    <article className="panel" aria-labelledby="run-title">
      <p className="state-word">
        {issue.key}, {issue.category} work: {(STATE_NAMES[run.state] ?? run.state).toLowerCase()}
        {run.pr_number ? `, pull request #${run.pr_number}` : ""}, {usd(run.cost_usd)} agent spend
      </p>
      <h2 id="run-title">{issue.title}</h2>
      {pre && (
        <Ladder
          label="Autonomy for this change"
          rows={[
            { level: pre, note: "the issue allowed" },
            ...(run.level && run.level !== pre ? [{ level: run.level, note: "the change earned" }] : []),
          ]}
          marker={{ from: pre, to: run.level ?? pre }}
        />
      )}
      {run.evidence ? (
        <Evidence markdown={run.evidence} />
      ) : (
        <Empty title="No pull request evidence">
          <p>
            {run.state === "blocked"
              ? "The safety model kept this issue for a person."
              : "The agent did not produce a change to review."}
          </p>
        </Empty>
      )}
      <h3>What happened</h3>
      <ol className="timeline" aria-label="Events">
        {events.map((e) => (
          <li key={e.id}>
            <time dateTime={e.at}>{when(e.at)}</time>
            <span>{describe(e.kind, e.data)}</span>
          </li>
        ))}
      </ol>
      {run.pr_number !== null && <Feedback id={id} />}
    </article>
  );
}

export function describe(kind: string, d: Record<string, unknown>): string {
  switch (kind) {
    case "preflight":
      return d.allowed
        ? `Preflight: ${d.category} work, at most ${levelName(String(d.level))}`
        : `Preflight: ${d.category} work is for a person`;
    case "agent_finished":
      return d.ok
        ? `Agent finished attempt ${d.attempt}: ${(d.files as string[]).length} file(s), ran tests ${d.tests_run} time(s), $${Number(d.cost_usd).toFixed(2)}`
        : `Agent stopped without a change${d.error ? ` (${d.error})` : ""}`;
    case "decision":
      return `Safety model: ${levelName(String(d.level))}`;
    case "pr_opened":
      return `Pull request #${d.pr} opened${d.draft ? " as a draft" : ""}`;
    case "ci":
      return `CI: ${d.conclusion}`;
    case "review":
      return `Review by ${d.reviewer}: ${String(d.state).replace("_", " ")}`;
    case "reworked":
      return `Agent answered the review (attempt ${d.attempt})`;
    case "handed_over":
      return "Handed over to a person after the last allowed rework";
    case "merged":
      return "Merged";
    case "feedback":
      return `Developer feedback: ${d.score} of 5`;
    default:
      return kind.replace("_", " ");
  }
}

function Feedback({ id }: { id: string }) {
  const client = useQueryClient();
  const [score, setScore] = useState("4");
  const [comment, setComment] = useState("");
  const m = useMutation({
    mutationFn: () => api.post(`/v1/runs/${id}/feedback`, { score: Number(score), comment }),
    onSuccess: () => {
      setComment("");
      client.invalidateQueries({ queryKey: ["run", id] });
    },
  });
  return (
    <section aria-labelledby="fb-title">
      <h3 id="fb-title">How useful was this pull request?</h3>
      <form
        className="feedback"
        onSubmit={(e) => {
          e.preventDefault();
          m.mutate();
        }}
      >
        <label>
          Score
          <select value={score} onChange={(e) => setScore(e.target.value)}>
            {["1", "2", "3", "4", "5"].map((s) => (
              <option key={s}>{s}</option>
            ))}
          </select>
        </label>
        <label>
          Comment
          <input type="text" value={comment} onChange={(e) => setComment(e.target.value)} />
        </label>
        <button type="submit" disabled={m.isPending}>
          Save feedback
        </button>
      </form>
      {m.isSuccess && <output>Feedback saved.</output>}
      {m.isError && <p role="alert">Feedback not saved: {(m.error as Error).message}</p>}
    </section>
  );
}
