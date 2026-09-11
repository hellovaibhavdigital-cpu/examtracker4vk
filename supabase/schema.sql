-- EXAM//OS — Supabase schema
-- Run this once in the Supabase SQL editor (Project → SQL Editor → New query → paste → Run)

create extension if not exists "pgcrypto";

-- Tracked exams. `event_date` is the next thing being counted down to.
create table if not exists exams (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  org text,
  event text not null default 'Application Deadline',
  event_date date not null,
  source_url text,
  status text not null default 'TRACKING', -- TRACKING | APPLIED | COMPLETED | IGNORED
  last_snapshot text,          -- truncated text fingerprint of the source page, for diffing
  last_hash text,               -- sha256 of the full extracted page text
  last_checked timestamptz,
  created_at timestamptz not null default now()
);

-- Exams the sync job has spotted but nobody is tracking yet (Discover tab).
create table if not exists discovered_exams (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  org text,
  event text,
  event_date date,
  source_url text,
  created_at timestamptz not null default now()
);

-- Every sync run writes here: routine checks, detected changes, and errors.
create table if not exists sync_log (
  id bigserial primary key,
  exam_id uuid references exams(id) on delete set null,
  level text not null default 'info', -- info | change | error
  message text not null,
  created_at timestamptz not null default now()
);

create index if not exists sync_log_created_at_idx on sync_log (created_at desc);

-- Row Level Security: this is a single-user personal app, so the anon key
-- (public, safe to embed in the frontend) gets read access everywhere and
-- write access only to the `exams` table (so the UI can add/remove/edit
-- tracked exams). Only the service_role key (used by the GitHub Actions
-- sync script, never shipped to the browser) can write to sync_log and
-- discovered_exams.

alter table exams enable row level security;
alter table discovered_exams enable row level security;
alter table sync_log enable row level security;

create policy "anon can read exams" on exams for select using (true);
create policy "anon can insert exams" on exams for insert with check (true);
create policy "anon can update exams" on exams for update using (true);
create policy "anon can delete exams" on exams for delete using (true);

create policy "anon can read discovered" on discovered_exams for select using (true);
create policy "anon can delete discovered" on discovered_exams for delete using (true);
-- no anon insert policy on discovered_exams: only the sync job (service_role) adds these

create policy "anon can read sync_log" on sync_log for select using (true);
-- no anon insert policy on sync_log: only the sync job (service_role) writes these

-- Seed a couple of real exams so the app isn't empty on first load.
-- Edit or delete these from the UI once you're set up.
insert into exams (name, org, event, event_date, source_url) values
  ('SSC CGL 2026', 'SSC', 'Tier 1 Exam', '2026-09-25', 'https://ssc.gov.in/'),
  ('IBPS PO 2026', 'IBPS', 'Prelims Exam', '2026-10-05', 'https://www.ibps.in/')
on conflict do nothing;
