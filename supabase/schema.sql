-- ============================================================================
-- AMBRA panel — users, projects & permissions schema
-- Run this once in the Supabase SQL editor (Project → SQL Editor → New query).
-- Safe to re-run: every object uses IF NOT EXISTS / ON CONFLICT where it matters.
--
-- Order matters here: every table is created first (sections 1-5), and RLS is
-- enabled with all policies added only at the end (section 7) — a couple of
-- those policies reference other tables in this file, and CREATE POLICY
-- resolves those references immediately, so the referenced table must already
-- exist by the time its policy is created.
-- ============================================================================


-- ----------------------------------------------------------------------------
-- 1. profiles — one row per auth.users row, plus app-level fields.
-- ----------------------------------------------------------------------------

create table if not exists public.profiles (
  id uuid primary key references auth.users(id) on delete cascade
);

-- `profiles` is a common table name — if one already existed in this project
-- (from an earlier setup attempt, a template, etc.) the CREATE TABLE above
-- was a no-op and it may be missing columns this schema needs. Add them here
-- so the script works whether the table is brand new or pre-existing.
alter table public.profiles add column if not exists full_name text;
alter table public.profiles add column if not exists avatar_url text;
alter table public.profiles add column if not exists is_admin boolean not null default false;
alter table public.profiles add column if not exists created_at timestamptz not null default now();

-- Auto-create a profile row whenever someone signs up in Supabase Auth
-- (including when the invite-user Edge Function creates an account).
create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into public.profiles (id, email, full_name)
  values (new.id, new.email, new.raw_user_meta_data ->> 'full_name')
  on conflict (id) do update set email = excluded.email;
  return new;
end;
$$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

-- security definer so it can read profiles.is_admin without re-triggering
-- profiles' own RLS policies (which would otherwise recurse into this check).
create or replace function public.is_admin()
returns boolean
language sql
security definer
set search_path = public
stable
as $$
  select coalesce((select is_admin from public.profiles where id = auth.uid()), false);
$$;


-- ----------------------------------------------------------------------------
-- 2. projects
-- ----------------------------------------------------------------------------

create table if not exists public.projects (
  id uuid primary key default gen_random_uuid(),
  slug text unique not null,          -- matches the page's permalink, e.g. 'palante' -> /palante/
  name text not null,
  is_template boolean not null default false,
  href text,                          -- real page path if one exists yet, e.g. '/palante/'
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create or replace function public.set_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

drop trigger if exists projects_set_updated_at on public.projects;
create trigger projects_set_updated_at
  before update on public.projects
  for each row execute function public.set_updated_at();


-- ----------------------------------------------------------------------------
-- 3. panel_bands — belong to a project (a project can have more than one
--    act). Named panel_bands, NOT bands: this Supabase project already has a
--    `bands` table that /palante reads and writes directly (the event's band
--    picker) — reusing that name here would collide with a live table.
-- ----------------------------------------------------------------------------

create table if not exists public.panel_bands (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references public.projects(id) on delete cascade,
  name text not null,
  created_at timestamptz not null default now()
);

create index if not exists panel_bands_project_id_idx on public.panel_bands(project_id);


-- ----------------------------------------------------------------------------
-- 4. project_members — a user's role, status & per-section permissions on a
--    project. `permissions` mirrors the panel's PERM_COUNT_KEYS object shape
--    exactly: { setlist, lineup, band, members, rehearsals, sound, stage,
--    lightning } each set to 'view' | 'edit' | 'none'.
-- ----------------------------------------------------------------------------

create table if not exists public.project_members (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references public.projects(id) on delete cascade,
  user_id uuid not null references public.profiles(id) on delete cascade,
  role text not null default 'Viewer',   -- free text: presets (Admin/Editor/Viewer/Team/Partner/Client) or a custom role name
  status text not null default 'pending' check (status in ('active', 'pending', 'inactive')),
  permissions jsonb not null default '{}'::jsonb,
  invited_at timestamptz not null default now(),
  unique (project_id, user_id)
);

create index if not exists project_members_user_id_idx on public.project_members(user_id);
create index if not exists project_members_project_id_idx on public.project_members(project_id);

-- Rejects any permissions payload with an unknown section key or a value
-- outside view/edit/none — this is what actually enforces valid permissions
-- at the database level, no matter what the client sends.
create or replace function public.is_valid_project_permissions(perms jsonb)
returns boolean
language plpgsql
immutable
as $$
declare
  allowed_keys text[] := array['setlist', 'lineup', 'band', 'members', 'rehearsals', 'sound', 'stage', 'lightning'];
  k text;
  v text;
begin
  for k, v in select * from jsonb_each_text(perms) loop
    if not (k = any(allowed_keys)) then
      return false;
    end if;
    if v not in ('view', 'edit', 'none') then
      return false;
    end if;
  end loop;
  return true;
end;
$$;

alter table public.project_members
  drop constraint if exists project_members_permissions_valid;
alter table public.project_members
  add constraint project_members_permissions_valid
  check (public.is_valid_project_permissions(permissions));


-- ----------------------------------------------------------------------------
-- 5. project_member_bands — which bands (within the project) a member has
--    access to. Only meaningful when a project has more than one band.
-- ----------------------------------------------------------------------------

create table if not exists public.project_member_bands (
  project_member_id uuid not null references public.project_members(id) on delete cascade,
  band_id uuid not null references public.panel_bands(id) on delete cascade,
  primary key (project_member_id, band_id)
);

create index if not exists project_member_bands_band_id_idx on public.project_member_bands(band_id);


-- ----------------------------------------------------------------------------
-- 6. Seed data — the one real project that exists today.
-- ----------------------------------------------------------------------------

insert into public.projects (slug, name, is_template, href)
values ('palante', 'Pa''Lante 2026', true, '/palante/')
on conflict (slug) do nothing;


-- ----------------------------------------------------------------------------
-- 7. Row Level Security — enabled and policied last, now that every table
--    these policies reference exists.
-- ----------------------------------------------------------------------------

alter table public.profiles enable row level security;

drop policy if exists "profiles are viewable by any authenticated user" on public.profiles;
create policy "profiles are viewable by any authenticated user"
  on public.profiles for select
  to authenticated
  using (true);

drop policy if exists "users can update their own profile" on public.profiles;
create policy "users can update their own profile"
  on public.profiles for update
  to authenticated
  using (auth.uid() = id)
  with check (auth.uid() = id);

drop policy if exists "admins can manage any profile" on public.profiles;
create policy "admins can manage any profile"
  on public.profiles for all
  to authenticated
  using (public.is_admin())
  with check (public.is_admin());

alter table public.projects enable row level security;

drop policy if exists "admins manage all projects" on public.projects;
create policy "admins manage all projects"
  on public.projects for all
  to authenticated
  using (public.is_admin())
  with check (public.is_admin());

drop policy if exists "members can view their projects" on public.projects;
create policy "members can view their projects"
  on public.projects for select
  to authenticated
  using (
    exists (
      select 1 from public.project_members pm
      where pm.project_id = projects.id and pm.user_id = auth.uid()
    )
  );

alter table public.panel_bands enable row level security;

drop policy if exists "admins manage all panel bands" on public.panel_bands;
create policy "admins manage all panel bands"
  on public.panel_bands for all
  to authenticated
  using (public.is_admin())
  with check (public.is_admin());

drop policy if exists "members can view panel bands of their projects" on public.panel_bands;
create policy "members can view panel bands of their projects"
  on public.panel_bands for select
  to authenticated
  using (
    exists (
      select 1 from public.project_members pm
      where pm.project_id = panel_bands.project_id and pm.user_id = auth.uid()
    )
  );

alter table public.project_members enable row level security;

drop policy if exists "admins manage all project members" on public.project_members;
create policy "admins manage all project members"
  on public.project_members for all
  to authenticated
  using (public.is_admin())
  with check (public.is_admin());

drop policy if exists "members can view their own membership" on public.project_members;
create policy "members can view their own membership"
  on public.project_members for select
  to authenticated
  using (user_id = auth.uid());

alter table public.project_member_bands enable row level security;

drop policy if exists "admins manage all member band assignments" on public.project_member_bands;
create policy "admins manage all member band assignments"
  on public.project_member_bands for all
  to authenticated
  using (public.is_admin())
  with check (public.is_admin());

drop policy if exists "members can view their own band assignments" on public.project_member_bands;
create policy "members can view their own band assignments"
  on public.project_member_bands for select
  to authenticated
  using (
    exists (
      select 1 from public.project_members pm
      where pm.id = project_member_bands.project_member_id and pm.user_id = auth.uid()
    )
  );


-- ----------------------------------------------------------------------------
-- 8. Bootstrap — run this part AFTER you've logged in at /ambra/ at least
--    once (so your row exists in auth.users / profiles). Replace the email
--    with the one you log in with, then run just this block.
-- ----------------------------------------------------------------------------

update public.profiles
set is_admin = true
where id = (select id from auth.users where email = 'ddavilaxr@gmail.com');

insert into public.project_members (project_id, user_id, role, status, permissions)
select p.id, u.id, 'Admin', 'active',
  '{"setlist":"edit","lineup":"edit","band":"edit","members":"edit","rehearsals":"edit","sound":"edit","stage":"edit","lightning":"edit"}'::jsonb
from public.projects p, auth.users u
where p.slug = 'palante' and u.email = 'ddavilaxr@gmail.com'
on conflict (project_id, user_id) do nothing;
