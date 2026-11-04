import { useQuery } from "@tanstack/react-query";
import { api } from "../../shared/api/client";
import type { Policy, Studies } from "../../shared/api/types";
import { Ladder } from "../../shared/ui/Ladder";
import { Empty, ErrorState, Skeleton } from "../../shared/ui/States";
import { levelName, pct } from "../../shared/ui/format";

export function SafetyScreen() {
  const policy = useQuery({ queryKey: ["policy"], queryFn: () => api.get<Policy>("/v1/policy") });
  const studies = useQuery({ queryKey: ["studies"], queryFn: () => api.get<Studies>("/v1/studies") });
  const failed = policy.isError ? policy : studies.isError ? studies : null;
  return (
    <>
      <h1>Safety model</h1>
      <p className="lede">
        Which work an agent may attempt, what it must never touch, and where a person decides. A change can
        only lower the level its issue allowed.
      </p>
      {(policy.isPending || studies.isPending) && <Skeleton rows={6} label="Loading the safety model" />}
      {failed && <ErrorState what="the safety model" error={failed.error} retry={() => failed.refetch()} />}
      {policy.isSuccess && studies.isSuccess && <Body policy={policy.data} studies={studies.data} />}
    </>
  );
}

function Body({ policy, studies }: { policy: Policy; studies: Studies }) {
  const risk = studies.risk;
  return (
    <>
      <section aria-labelledby="replay-title">
        <h2 id="replay-title">Replayed on n8n's own history</h2>
        {risk ? (
          <>
            <p>
              Where the {risk.data.test.changes} changes merged from {risk.data.test.from} to{" "}
              {risk.data.test.to} would have landed, and how many of them later needed a revert or a follow-up
              fix.
            </p>
            <Ladder
              label="Changes by autonomy level"
              rows={Object.entries(risk.test.policy.levels).map(([level, v]) => ({
                level,
                share: v.share,
                note: `${pct(v.share)} of changes, ${pct(v.bad_rate)} needed a fix`,
              }))}
            />
          </>
        ) : (
          <Empty title="No history replay yet">
            <p>
              Run <code>pnpm acdc risk</code> to train the change-risk model and replay the safety model.
            </p>
          </Empty>
        )}
      </section>
      {risk && (
        <section aria-labelledby="shadow-title">
          <h2 id="shadow-title">Automated approval in shadow mode</h2>
          <p>
            If a share of changes were approved without a person, how many bad ones would get through: the
            change-risk model (AUC {risk.test.auc.toFixed(2)}) against the rule a team would write without
            one, small changes with tests first (AUC {risk.test.auc_naive_rule.toFixed(2)}).
          </p>
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th scope="col">Approved without a person</th>
                  <th scope="col" className="num">
                    Bad, risk model
                  </th>
                  <th scope="col" className="num">
                    Bad, size-and-tests rule
                  </th>
                </tr>
              </thead>
              <tbody>
                {risk.test.shadow.map((s) => (
                  <tr key={s.share}>
                    <th scope="row">{pct(s.share)} of changes</th>
                    <td className="num">
                      {pct(s.model.rate, 1)} ({s.model.bad} of {s.model.changes})
                    </td>
                    <td className="num">
                      {pct(s.naive_rule.rate, 1)} ({s.naive_rule.bad} of {s.naive_rule.changes})
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      )}
      <section aria-labelledby="cat-title">
        <h2 id="cat-title">What an agent may attempt</h2>
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th scope="col">Issue category</th>
                <th scope="col">At most</th>
              </tr>
            </thead>
            <tbody>
              {Object.entries(policy.categories).map(([c, v]) => (
                <tr key={c}>
                  <th scope="row">{c}</th>
                  <td>
                    <span className="level" data-level={v.max_level}>
                      {levelName(v.max_level)}
                    </span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <p>
          More than {policy.size.max_files_auto} files drops a change below automated approval; more than{" "}
          {policy.size.max_files_reviewed} makes it a draft.
        </p>
      </section>
      <section aria-labelledby="never-title">
        <h2 id="never-title">Never touched by an agent</h2>
        <ul className="paths">
          {policy.forbidden.map((p) => (
            <li key={p} className="path">
              {p}
            </li>
          ))}
        </ul>
      </section>
      <section aria-labelledby="sens-title">
        <h2 id="sens-title">Sensitive: a draft, reviewed by {policy.sensitive.reviewers}</h2>
        <ul className="paths">
          {policy.sensitive.paths.map((p) => (
            <li key={p} className="path">
              {p}
            </li>
          ))}
        </ul>
        {studies.owners && (
          <p>
            Ownership comes from n8n's OWNERS file. The matcher here agrees with n8n's own on{" "}
            {pct(studies.owners.owner_agreement, 1)} of {studies.owners.files.toLocaleString("en")} files and
            on the required reviewers of {pct(studies.owners.required_agreement, 1)} of{" "}
            {studies.owners.changes.toLocaleString("en")} recent changes.
          </p>
        )}
      </section>
    </>
  );
}
