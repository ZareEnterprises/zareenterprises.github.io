-- EMN student login — a completely separate Supabase project from AMBRA's.
-- Run this once in this project's SQL Editor (Settings > API confirms this
-- is project gpoddvcrsdkpgfmyniqu, not AMBRA's lnodvezexfsmeasfndys).
--
-- Security model matches AMBRA's own panel for now: RLS is left OFF and
-- access rules are enforced in the page JS (role read from `students`,
-- checked before showing admin-only UI) plus in the invite-student Edge
-- Function (the only place that can actually create accounts or change
-- roles). Not a hard security boundary yet, same tradeoff AMBRA made.

-- 1. One row per person who can sign in — mirrors auth.users 1:1.
--    role: 'admin' | 'professor' | 'student'
--    status: 'pending' (invited, hasn't set a password yet) | 'active'
create table if not exists public.students (
  id uuid primary key references auth.users(id) on delete cascade,
  email text not null,
  full_name text,
  role text not null default 'student',
  status text not null default 'pending',
  created_at timestamptz not null default now()
);

-- 2. Daily practice time, per tool, per student. One row per
--    (student, tool, day) — the heartbeat in each tool just adds seconds to
--    today's row instead of creating a new one per session.
create table if not exists public.practice_activity (
  id uuid primary key default gen_random_uuid(),
  student_id uuid not null references public.students(id) on delete cascade,
  tool text not null, -- 'sight-melody' | 'interview-prep'
  activity_date date not null default current_date,
  seconds int not null default 0,
  updated_at timestamptz not null default now(),
  unique (student_id, tool, activity_date)
);
create index if not exists practice_activity_student_idx on public.practice_activity(student_id);

alter table public.students disable row level security;
alter table public.practice_activity disable row level security;
