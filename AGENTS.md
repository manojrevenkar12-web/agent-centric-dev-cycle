# Working in this repository

ACDC is the agent-centric development cycle for a large TypeScript monorepo (n8n): a safety model
that decides what agents may do, a change-risk model trained on the repository's own history, a
benchmark built from real fixes, and a service that takes Linear issues through agent runs to
pull requests with evidence. See README.md for what each part measured.

## Fast feedback

```sh
pnpm install
pnpm test                 # unit tests and the history study (seconds); service tests need ACDC_TEST_DATABASE_URL
pnpm typecheck && pnpm lint
cd apps/console && pnpm test && pnpm e2e    # console unit tests, then Playwright with axe
```

The studies need an n8n checkout with history since November 2025 in `N8N_REPO`:

```sh
pnpm acdc history         # mine and label merged changes -> data/history.jsonl.gz
pnpm acdc risk            # train the change-risk model, replay the safety model -> reports/risk.json
pnpm acdc owners-check    # our OWNERS matcher against n8n's own -> reports/owners-check.json
pnpm acdc tasks           # mine and validate benchmark tasks -> data/tasks/tasks.json
pnpm acdc run             # agents on the tasks, within the spend cap -> reports/runs/
pnpm acdc report          # reports/bench.json and reports/RESULTS.md
```

## Invariants

- **The safety model only lowers.** `decide()` starts from the level the issue's category allows and
  every rule can only lower it. Forbidden paths make a change `human_only`, and the service discards it
  instead of opening a pull request. `packages/core/test/policy.test.ts` checks this.
- **OWNERS means what n8n's merge gate says it means.** `packages/core/src/owners.ts` must agree with
  `.github/scripts/owners/owners.mjs` on every file. Run `pnpm acdc owners-check` after changing it.
- **No look-ahead in the risk model.** Features use only what is known when a pull request opens; file
  history counts fixes strictly before the change. The split is by time, never random.
- **Agents never see the grader.** The hidden tests come from the fix commit and are written into the
  checkout only after the agent has finished. The prompt never names them (`bench.test.ts` checks).
- **Least privilege for agents.** File tools stay in the checkout (`--restricted`); the shell runs only
  the wrappers in `packages/bench/src/agent.ts`; tests run without network; the environment is empty.
  Add a command to `ALLOWED` only with a test that shows why.
- **First attempts are the results.** `pnpm acdc run` never reruns a task a setup already has. Use
  `--force` only to rerun everything for a new setup version, and say so in the report.
- **Metrics come from events, not claims.** `packages/service/src/metrics.ts` reads the event log; an
  agent's "tests pass" is compared with what ran, never counted as a pass. Events are append-only.
- **Settings live in `config/`** (safety.yaml, risk.yaml, bench.yaml, service.yaml), not in code.
- **Generated files are generated.** `reports/*.json`, `reports/RESULTS.md`, `config/risk-model.json`,
  `data/history.jsonl.gz` and `data/tasks/` come from the commands above; do not edit them by hand.

## Where things are

- `packages/core`: globs, OWNERS, the safety model, the change-risk model.
- `packages/bench`: history mining and labels, the risk study, task mining and validation, the sandbox,
  the agent runner, grading and PR evidence, the report, the production executor.
- `packages/service`: PostgreSQL store, Linear and GitHub adapters, the loop, metrics, the HTTP API.
- `apps/console`: the React console (feature folders under `src/features`).
- `docs/adr`: the decisions and what would change them.
