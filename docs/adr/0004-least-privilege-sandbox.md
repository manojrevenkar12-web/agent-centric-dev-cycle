# 0004 What an agent can reach

## Decision

An agent session is Claude Code in headless mode inside a sparse git worktree of the task's commit:

- file tools are confined to the worktree (`--restricted`);
- the shell runs only `acdc-test` (vitest for the package, in a new user and network namespace),
  `acdc-typecheck`, `git status`, `git diff` and `ls`; everything else is refused without asking and
  recorded as a denial (`--permission-mode dontAsk`);
- the environment is HOME and PATH only: no tokens, no cloud credentials, no user settings, skills or
  MCP servers (`--setting-sources project --strict-mcp-config --disable-slash-commands`);
- every session has a spend cap (`--max-budget-usd`), and the run stops when the ledger reaches the
  total cap.

The installed dependencies are linked in read-only from the main checkout, so a session never
installs anything.

## Why not containers per task

A container per task is the right production answer and the executor can move to one without
changing the loop. Here the cost is the install: n8n's dependency tree is large, and the sandbox
needs the same installed tree in every task. Namespaces give the property that matters for tests (no
network) at no cost.

## What is still open

The agent process itself needs network to reach the model. A production executor would route it
through an egress proxy that allows only the model API, which is the remaining gap between this
sandbox and one that can hold secrets nearby.
