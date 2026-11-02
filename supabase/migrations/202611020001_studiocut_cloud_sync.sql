create table if not exists public.studiocut_projects (
  owner_id uuid not null references auth.users(id) on delete cascade,
  client_id text not null,
  name text not null check (char_length(name) between 1 and 200),
  revision integer not null check (revision > 0),
  project_data jsonb not null check (jsonb_typeof(project_data) = 'object'),
  updated_at timestamptz not null default now(),
  primary key (owner_id, client_id)
);

create table if not exists public.studiocut_project_versions (
  owner_id uuid not null references auth.users(id) on delete cascade,
  client_id text not null,
  revision integer not null check (revision > 0),
  name text not null,
  project_data jsonb not null check (jsonb_typeof(project_data) = 'object'),
  created_at timestamptz not null default now(),
  primary key (owner_id, client_id, revision)
);

alter table public.studiocut_projects enable row level security;
alter table public.studiocut_project_versions enable row level security;

drop policy if exists "Owners read their projects" on public.studiocut_projects;
create policy "Owners read their projects"
  on public.studiocut_projects for select
  to authenticated
  using (owner_id = (select auth.uid()));

drop policy if exists "Owners read project versions" on public.studiocut_project_versions;
create policy "Owners read project versions"
  on public.studiocut_project_versions for select
  to authenticated
  using (owner_id = (select auth.uid()));

revoke all on public.studiocut_projects from anon, authenticated;
grant select on public.studiocut_projects to authenticated;
revoke all on public.studiocut_project_versions from anon, authenticated;
grant select on public.studiocut_project_versions to authenticated;

create or replace function public.sync_studiocut_project(
  p_client_id text,
  p_name text,
  p_project_data jsonb,
  p_expected_revision integer
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_owner uuid := auth.uid();
  v_project public.studiocut_projects%rowtype;
  v_revision integer;
  v_now timestamptz := now();
begin
  if v_owner is null then
    raise exception 'Authentication required' using errcode = '28000';
  end if;
  if p_client_id is null or p_client_id !~ '^[0-9]{1,16}$' then
    raise exception 'Invalid local project identifier' using errcode = '22023';
  end if;
  if p_name is null or char_length(p_name) not between 1 and 200 then
    raise exception 'Project name must be 1 to 200 characters' using errcode = '22023';
  end if;
  if p_project_data is null or jsonb_typeof(p_project_data) <> 'object' then
    raise exception 'Project data must be a JSON object' using errcode = '22023';
  end if;
  if p_expected_revision is null or p_expected_revision < 0 then
    raise exception 'Expected project revision must be zero or greater' using errcode = '22023';
  end if;
  if octet_length(p_project_data::text) > 2000000 then
    raise exception 'Project metadata exceeds the 2 MB limit' using errcode = '22023';
  end if;

  select *
    into v_project
    from public.studiocut_projects
   where owner_id = v_owner and client_id = p_client_id
   for update;

  if not found then
    if p_expected_revision <> 0 then
      return jsonb_build_object('status', 'conflict', 'revision', 0);
    end if;
    insert into public.studiocut_projects
      (owner_id, client_id, name, revision, project_data, updated_at)
    values
      (v_owner, p_client_id, p_name, 1, p_project_data, v_now);
    insert into public.studiocut_project_versions
      (owner_id, client_id, revision, name, project_data, created_at)
    values
      (v_owner, p_client_id, 1, p_name, p_project_data, v_now);
    return jsonb_build_object('status', 'synced', 'revision', 1, 'updated_at', v_now);
  end if;

  if p_expected_revision <> v_project.revision then
    return jsonb_build_object(
      'status', 'conflict',
      'revision', v_project.revision,
      'updated_at', v_project.updated_at
    );
  end if;

  insert into public.studiocut_project_versions
    (owner_id, client_id, revision, name, project_data, created_at)
  values
    (v_owner, p_client_id, v_project.revision, v_project.name, v_project.project_data, v_now)
  on conflict (owner_id, client_id, revision) do nothing;

  v_revision := v_project.revision + 1;
  update public.studiocut_projects
     set name = p_name,
         revision = v_revision,
         project_data = p_project_data,
         updated_at = v_now
   where owner_id = v_owner and client_id = p_client_id;

  insert into public.studiocut_project_versions
    (owner_id, client_id, revision, name, project_data, created_at)
  values
    (v_owner, p_client_id, v_revision, p_name, p_project_data, v_now)
  on conflict (owner_id, client_id, revision) do nothing;

  delete from public.studiocut_project_versions
   where owner_id = v_owner
     and client_id = p_client_id
     and revision not in (
       select version.revision
         from public.studiocut_project_versions as version
        where version.owner_id = v_owner and version.client_id = p_client_id
        order by version.revision desc
        limit 25
     );

  return jsonb_build_object('status', 'synced', 'revision', v_revision, 'updated_at', v_now);
end;
$$;

revoke all on function public.sync_studiocut_project(text, text, jsonb, integer) from public, anon;
grant execute on function public.sync_studiocut_project(text, text, jsonb, integer) to authenticated;

insert into storage.buckets (id, name, public)
values ('project-media', 'project-media', false)
on conflict (id) do update set public = false;

drop policy if exists "Owners upload private project media" on storage.objects;
create policy "Owners upload private project media"
  on storage.objects for insert to authenticated
  with check (
    bucket_id = 'project-media'
    and (storage.foldername(name))[1] = (select auth.uid())::text
  );

drop policy if exists "Owners read private project media" on storage.objects;
create policy "Owners read private project media"
  on storage.objects for select to authenticated
  using (
    bucket_id = 'project-media'
    and (storage.foldername(name))[1] = (select auth.uid())::text
  );

drop policy if exists "Owners replace their private project media" on storage.objects;
create policy "Owners replace their private project media"
  on storage.objects for update to authenticated
  using (
    bucket_id = 'project-media'
    and (storage.foldername(name))[1] = (select auth.uid())::text
  )
  with check (
    bucket_id = 'project-media'
    and (storage.foldername(name))[1] = (select auth.uid())::text
  );
