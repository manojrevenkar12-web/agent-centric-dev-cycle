# 0001 The safety model only lowers

## Decision

An agent's autonomy is decided twice. Before a run, the issue's category sets the highest level an
agent may reach (`config/safety.yaml: categories`): security and migration work stays with a person,
bug fixes and refactors reach "agent, reviewed", tests and docs may become auto-approvable. After the
run, the change itself decides, and every rule can only lower the level:

- a forbidden path (CI workflows, OWNERS, migrations, encryption, `.env`) makes it human only, and the
  service discards the change instead of opening a pull request;
- a sensitive path (auth, permissions, credentials, licence, AI credits) makes it a draft that the
  security owners review;
- a required team in n8n's OWNERS keeps it at "agent, reviewed";
- more than 6 files leaves automated approval, more than 25 makes it a draft;
- the change-risk tier caps it (high risk: draft).

## Why

The two failure modes cost very different amounts. A level that is too low costs review time. A
level that is too high lets an unreviewed change into auth or billing. A rule that can only lower is
easy to reason about and easy to test: no combination of rules raises a change above its category.

## What the history says

Replayed on the 2,800 changes n8n merged in September and October 2026 (`reports/risk.json`), 3.7% of
changes would have been auto-approvable, and none of them needed a revert or a follow-up fix. Drafts
are 44% of changes and 35% of them needed one. The policy is conservative on purpose: automated
approval starts in shadow mode, as n8n's own AI review does (`cubic.yaml: auto_approve_behavior:
shadow`), and the share grows only when the shadow numbers hold.

## What would change it

A month of shadow results where the auto-approvable share's follow-up rate stays under the team's
bar would justify raising `max_files_auto` or letting bug fixes reach auto-approval at low risk.
