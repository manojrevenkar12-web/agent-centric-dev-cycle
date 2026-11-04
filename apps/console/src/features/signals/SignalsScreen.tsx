import { useQuery } from "@tanstack/react-query";
import { api } from "../../shared/api/client";
import type { Metrics } from "../../shared/api/types";
import { Ladder } from "../../shared/ui/Ladder";
import { Empty, ErrorState, Skeleton } from "../../shared/ui/States";
import { pct, usd } from "../../shared/ui/format";

export function SignalsScreen() {
  const q = useQuery({ queryKey: ["metrics"], queryFn: () => api.get<Metrics>("/v1/metrics") });
  return (
    <>
      <h1>Signals</h1>
      <p className="lede">
        Quality and adoption, computed from what happened to each pull request, never from what an agent said
        about it.
      </p>
      {q.isPending && <Skeleton rows={4} label="Loading signals" />}
      {q.isError && <ErrorState what="signals" error={q.error} retry={() => q.refetch()} />}
      {q.isSuccess && q.data.prs_opened === 0 && (
        <Empty title="No pull request yet">
          <p>
            Signals start with the first agent pull request: acceptance, CI, rework and cost need one to
            measure.
          </p>
        </Empty>
      )}
      {q.isSuccess && q.data.prs_opened > 0 && <Figures m={q.data} />}
    </>
  );
}

function Figures({ m }: { m: Metrics }) {
  const total = Object.values(m.levels).reduce((a, b) => a + b, 0);
  return (
    <>
      <ul className="figures" aria-label="Signals">
        <li>
          <strong>{pct(m.reviewer_acceptance_rate)}</strong>
          <span>first review approves</span>
        </li>
        <li>
          <strong>{pct(m.ci_pass_rate)}</strong>
          <span>first CI run green</span>
        </li>
        <li>
          <strong>{pct(m.rework_rate)}</strong>
          <span>reviewed PRs sent back</span>
        </li>
        <li>
          <strong>{pct(m.overclaim_rate)}</strong>
          <span>agent said tests pass, they did not</span>
        </li>
        <li>
          <strong>{usd(m.cost_per_merged_usd)}</strong>
          <span>agent spend per merged PR</span>
        </li>
        <li>
          <strong>{m.satisfaction.mean === null ? "–" : `${m.satisfaction.mean.toFixed(1)} / 5`}</strong>
          <span>developer rating, {m.satisfaction.responses} response(s)</span>
        </li>
      </ul>
      <section>
        <h2>Where agent pull requests landed</h2>
        <Ladder
          label="Pull requests by autonomy level"
          rows={Object.entries(m.levels).map(([level, n]) => ({
            level,
            share: total ? n / total : 0,
            note: `${n} PR(s)`,
          }))}
        />
        <p>
          {m.issues} issue(s) taken, {m.blocked_at_preflight} kept for a person at preflight, {m.prs_opened}{" "}
          pull request(s), {m.merged} merged, {m.handed_over} handed over after review.
        </p>
      </section>
    </>
  );
}
