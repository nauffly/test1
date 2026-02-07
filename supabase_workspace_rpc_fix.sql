-- Supabase-side fix pack for workspace features expected by app.js.
-- Run this in Supabase SQL Editor as a privileged role.

begin;

-- Helper: owner check for workspace actions.
create or replace function public.javi_is_workspace_owner(p_workspace_id uuid)
returns boolean
language sql
security definer
set search_path = public
as $$
  select exists (
    select 1
    from public.workspace_members wm
    where wm.workspace_id = p_workspace_id
      and wm.user_id = auth.uid()
      and lower(coalesce(wm.role, '')) = 'owner'
  );
$$;

-- Robust member display-name updater used by app fallback/RPC calls.
create or replace function public.javi_set_member_display_name(
  p_workspace_id uuid,
  p_display_name text,
  p_user_id uuid default auth.uid()
)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if p_workspace_id is null then
    raise exception 'workspace id required';
  end if;
  if coalesce(trim(p_display_name), '') = '' then
    raise exception 'display name required';
  end if;

  -- Allow self-update or owner update.
  if p_user_id <> auth.uid() and not public.javi_is_workspace_owner(p_workspace_id) then
    raise exception 'not allowed';
  end if;

  update public.workspace_members
     set display_name = trim(p_display_name)
   where workspace_id = p_workspace_id
     and user_id = p_user_id;

  -- Optional profile mirror (best effort if profiles table exists).
  begin
    insert into public.profiles (id, display_name, updated_at)
    values (p_user_id, trim(p_display_name), now())
    on conflict (id) do update
      set display_name = excluded.display_name,
          updated_at = now();
  exception when undefined_table then
    null;
  end;
end;
$$;

-- Optional member-list RPC for stricter RLS setups.
create or replace function public.javi_list_workspace_members(p_workspace_id uuid)
returns table(user_id uuid, role text, created_at timestamptz, display_name text)
language sql
security definer
set search_path = public
as $$
  select wm.user_id, wm.role, wm.created_at, wm.display_name
  from public.workspace_members wm
  where wm.workspace_id = p_workspace_id
    and exists (
      select 1 from public.workspace_members me
      where me.workspace_id = p_workspace_id
        and me.user_id = auth.uid()
    )
  order by wm.created_at asc;
$$;

-- Workspace delete RPC expected by app.
create or replace function public.javi_delete_workspace(p_workspace_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if p_workspace_id is null then
    raise exception 'workspace id required';
  end if;

  if not public.javi_is_workspace_owner(p_workspace_id) then
    raise exception 'only workspace owner can delete workspace';
  end if;

  -- Child-first cleanup
  begin
    delete from public.reservations where workspace_id = p_workspace_id or workspace_id is null;
  exception when undefined_table then null; end;

  begin
    delete from public.checkouts where workspace_id = p_workspace_id or workspace_id is null;
  exception when undefined_table then null; end;

  begin
    delete from public.workspace_invites where workspace_id = p_workspace_id or workspace_id is null;
  exception when undefined_table then null; end;

  begin
    delete from public.kits where workspace_id = p_workspace_id or workspace_id is null;
  exception when undefined_table then null; end;

  begin
    delete from public.events where workspace_id = p_workspace_id or workspace_id is null;
  exception when undefined_table then null; end;

  begin
    delete from public.gear_items where workspace_id = p_workspace_id or workspace_id is null;
  exception when undefined_table then null; end;

  delete from public.workspace_members where workspace_id = p_workspace_id;
  delete from public.workspaces where id = p_workspace_id;
end;
$$;


-- Compatibility wrappers for older clients that call alternative arg names.
create or replace function public.javi_delete_workspace(wid uuid)
returns void
language sql
security definer
set search_path = public
as $$
  select public.javi_delete_workspace(p_workspace_id := wid);
$$;

create or replace function public.javi_delete_workspace(id uuid)
returns void
language sql
security definer
set search_path = public
as $$
  select public.javi_delete_workspace(p_workspace_id := id);
$$;

create or replace function public.javi_delete_workspace(workspace uuid)
returns void
language sql
security definer
set search_path = public
as $$
  select public.javi_delete_workspace(p_workspace_id := workspace);
$$;


-- Member self-removal helper (non-owners can leave workspaces).
create or replace function public.javi_leave_workspace(p_workspace_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_role text;
begin
  if p_workspace_id is null then
    raise exception 'workspace id required';
  end if;

  select role into v_role
  from public.workspace_members
  where workspace_id = p_workspace_id and user_id = auth.uid();

  if v_role is null then
    return;
  end if;

  if lower(coalesce(v_role,'')) = 'owner' then
    raise exception 'owner cannot leave workspace';
  end if;

  delete from public.workspace_members
  where workspace_id = p_workspace_id
    and user_id = auth.uid();
end;
$$;

-- Permissions
revoke all on function public.javi_is_workspace_owner(uuid) from public;
grant execute on function public.javi_is_workspace_owner(uuid) to authenticated;

grant execute on function public.javi_set_member_display_name(uuid, text, uuid) to authenticated;
grant execute on function public.javi_list_workspace_members(uuid) to authenticated;
grant execute on function public.javi_leave_workspace(uuid) to authenticated;
grant execute on function public.javi_delete_workspace(uuid) to authenticated;
grant execute on function public.javi_delete_workspace(wid uuid) to authenticated;
grant execute on function public.javi_delete_workspace(id uuid) to authenticated;
grant execute on function public.javi_delete_workspace(workspace uuid) to authenticated;

commit;
