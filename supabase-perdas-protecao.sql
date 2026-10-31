begin;
create or replace function public.protect_loss_records()
returns trigger language plpgsql security invoker set search_path=public as $$
declare is_loss boolean; parent_id uuid;
begin
  if current_user in ('postgres','service_role','supabase_admin') or coalesce(public.my_role(),'')='admin' then
    if tg_op='DELETE' then return old; else return new; end if;
  end if;
  if tg_table_name='conferences' then
    if tg_op='INSERT' then
      if new.record_kind='loss' and new.loss_closed_at is not null then raise exception 'Somente o administrador pode encerrar perdas'; end if;
    else
      is_loss:=old.record_kind='loss';
      if tg_op='UPDATE' then is_loss:=is_loss or new.record_kind='loss'; end if;
      if is_loss then raise exception 'Perdas salvas não podem ser alteradas ou excluídas pelo conferente'; end if;
    end if;
  else
    parent_id:=old.conference_id;
    select record_kind='loss' into is_loss from public.conferences where id=parent_id;
    if tg_op='UPDATE' and not coalesce(is_loss,false) then
      select record_kind='loss' into is_loss from public.conferences where id=new.conference_id;
    end if;
    if coalesce(is_loss,false) then raise exception 'Itens de perdas salvas não podem ser alterados ou excluídos pelo conferente'; end if;
  end if;
  if tg_op='DELETE' then return old; else return new; end if;
end; $$;
drop trigger if exists protect_loss_headers on public.conferences;
create trigger protect_loss_headers before insert or update or delete on public.conferences for each row execute function public.protect_loss_records();
drop trigger if exists protect_loss_items on public.conference_items;
create trigger protect_loss_items before update or delete on public.conference_items for each row execute function public.protect_loss_records();
commit;
