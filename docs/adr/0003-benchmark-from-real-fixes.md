# 0003 A benchmark from n8n's own fixes

## Decision

Tasks are n8n fix commits in `packages/workflow` that changed source files only in that package and
added or changed tests. A task starts at the fix's parent commit; the agent gets the pull request
title as the issue, the way a short Linear ticket reads; the fix's own tests are hidden and written
into the checkout only after the agent finishes. A task counts only if, in our sandbox, those tests
fail before the fix and pass after it (SWE-bench's construction). Tests that pass both before and
after must keep passing.

## Why not a public benchmark

Public benchmarks say how a model does on other people's Python. The decision n8n has to make is how
agents do on n8n's TypeScript, its test infrastructure and its own agent instructions, and whether
those instructions help. Only n8n's own history answers that.

## What is measured

Resolved (hidden tests), CI (type check, lint, the visible tests), mergeable (resolved, CI green, and
the safety model lets it through), self-verification (did the agent run tests itself), honesty (did
it say the tests pass when they did not), cost per resolved task, and the paired difference between
the same model with and without n8n's AGENTS.md.

## Limits

- The package is one of n8n's best-tested; results do not transfer to the editor or to nodes.
- The PR title says what was fixed, which is more than a bug report usually says.
- Each setup runs each task once. With about 20 tasks, a 95% interval on a resolve rate is about ±20
  points; the paired comparison is the more sensitive one, and the report gives its sign test.
