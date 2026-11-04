# ACDC: from promising experiments to the way n8n builds software

A technical proposal for engineering leadership. It says what to build first, what to buy, what to
measure, and what would make us stop. The numbers come from this repository's studies on n8n's own
history (`reports/RESULTS.md`); where a number is missing, the proposal says how it will be measured.

## The problem, stated narrowly

Agents already automate most of the cycle on one Developer Platform project. Taking that to the
whole monorepo fails in three predictable ways, each of which has happened somewhere else first:

1. **Review becomes the bottleneck.** Agents open pull requests faster than people can judge them,
   and reviewers cannot tell a careful change from a confident one. The cost moves; it does not fall.
2. **Trust breaks on one incident.** One agent change to auth, billing or a migration that slips
   through review ends the programme, whatever the averages say.
3. **Nobody can say whether it works.** "Lines of AI code" and anecdotes do not survive a budget
   review. Without a baseline, every claim is an opinion.

So the order of work is: make review cheaper and safer first, then widen what agents may do, and
measure both against n8n's own history before and after.

## What to build first (quarter 1)

| Work | Why first | Done when |
|---|---|---|
| **Safety model as code** (`config/safety.yaml`) with Security | It decides where agents may work at all; every later step depends on it | Security has reviewed the forbidden and sensitive paths; the OWNERS matcher agrees with the merge gate on every file |
| **PR evidence on every agent PR** | It is the cheapest way to cut review time: what changed, what ran, what risk remains, where a person decides | Reviewers rate evidence useful on 4 of 5 PRs (in-PR feedback) |
| **Change risk in shadow mode** next to cubic's shadow auto-approve | Automated approval should be earned on history before it is switched on | Four weeks of shadow results with the follow-up rate of the would-be auto-approved share under the agreed bar |
| **Benchmark from our own fixes**, run on every model or harness change | Model and tool choices are made on n8n's code, not on public leaderboards | A weekly run, one table, and a decision written against it |

## What to buy, and what not to

- **Coding agent and model: buy.** Claude Code, OpenCode and the models move faster than any internal
  effort. What we own is the harness around them: sandbox, safety model, evidence, benchmark.
  Switching cost stays low because the harness talks to the agent through one command line.
- **AI review (cubic): keep, and measure.** It runs in shadow today. The benchmark's judge-versus-tests
  table is the template for measuring it: where it disagrees with what merged and what followed.
- **Sandboxes: build thin, on what CI already has.** Worktrees, namespaces and an egress proxy cover
  the threat model for unit-level work. Buy a managed sandbox when agents need full stacks
  (databases, queues) per task; the executor interface is where that plugs in.
- **Do not build** a second orchestration layer on top of Linear and GitHub. The loop is a small,
  stateless service over webhooks; Linear stays the source of work and GitHub the source of truth.

## AI spend

Spend is reported per merged change, not per token, and by setup. The benchmark gives the price of
a resolved task per model; the service gives the price of a merged pull request in production. A
model upgrade is justified when it lowers cost per merged change or raises the resolve rate on the
benchmark enough to pay for itself in review time. The total cap and the per-run cap live in config
and are enforced by a ledger, not by trust.

## Signals and what each one decides

| Signal | Source | Decides |
|---|---|---|
| Reviewer acceptance (first review approves) | GitHub reviews | Whether a task category widens or narrows |
| CI pass rate (first run green) | Check suites | Whether self-verification is good enough to skip a human retry loop |
| Rework rate (sent back at least once) | Reviews | Whether issues are specified well enough; feeds issue templates |
| Said-pass-but-failed rate | Agent claim vs executor checks | Whether reviewers can rely on the agent's own summary |
| Follow-up within 7 days | Git history (the risk label) | Whether auto-approval stays on |
| Cost per merged change | Ledger | Model and harness choices |
| Developer rating | In-PR feedback | Adoption; a falling rating stops expansion |

## Phases and the line we will not cross

1. **Shadow** (now): agents draft and are reviewed; nothing is auto-approved; risk and evidence are
   computed and compared with what happens.
2. **Earned autonomy**: tests and docs changes at low risk may be auto-approved once the shadow
   numbers hold; bug fixes stay reviewed.
3. **Beyond engineering**: PMs and designers file a well-defined issue and get a reviewed pull
   request; the safety model is the same, the reviewers are the owning team.

Security, migrations, CI configuration, OWNERS and encryption stay human-only in every phase.
Changing that is a decision for Security and engineering leadership, written down, not a config edit.

## What would make us stop or change course

- The follow-up rate of agent changes is higher than that of human changes in the same tier.
- Reviewer time per merged change does not fall within a quarter.
- Developers rate agent pull requests below 3 of 5 for a month.
- A forbidden path is touched by an agent change that reaches review (the loop should make this
  impossible; if it happens, the loop is wrong).
