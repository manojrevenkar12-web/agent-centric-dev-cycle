-- The record of the agent-centric development cycle: one row per issue an agent was asked to take,
-- one per run of the loop, and an append-only event log that every metric is computed from.

create table if not exists issues (
  id          text primary key,             -- Linear issue id
  key         text not null,                -- e.g. DEV-1234
  title       text not null,
  body        text not null default '',
  labels      jsonb not null default '[]',
  category    text not null,
  created_at  timestamptz not null default now()
);

create table if not exists runs (
  id           uuid primary key,
  issue_id     text not null references issues(id),
  state        text not null check (state in
                 ('queued','blocked','running','failed','rejected','pr_open','changes_requested','merged','closed')),
  level        text,                         -- autonomy level the safety model gave the change
  attempt      int not null default 1,       -- 2 and up: rework after review
  pr_number    int,
  cost_usd     numeric(10,4) not null default 0,
  evidence     text,
  decision     jsonb,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);
create unique index if not exists runs_one_open_per_issue on runs(issue_id)
  where state in ('queued','running','pr_open','changes_requested');
create unique index if not exists runs_pr on runs(pr_number) where pr_number is not null;

create table if not exists events (
  id      bigserial primary key,
  run_id  uuid not null references runs(id),
  at      timestamptz not null default now(),
  kind    text not null,                      -- preflight, agent_finished, pr_opened, ci, review, merged, feedback, ...
  data    jsonb not null default '{}'
);
create index if not exists events_run on events(run_id, id);

-- Webhook deliveries already handled: providers retry, and a retried delivery must not act twice.
create table if not exists deliveries (
  source  text not null,
  id      text not null,
  at      timestamptz not null default now(),
  primary key (source, id)
);

-- The event log is evidence; it is never rewritten.
create or replace function events_append_only() returns trigger language plpgsql as $$
begin
  raise exception 'events are append-only';
end $$;
drop trigger if exists events_no_change on events;
create trigger events_no_change before update or delete on events
  for each row execute function events_append_only();
