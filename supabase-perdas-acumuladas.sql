begin;
alter table public.conferences add column if not exists loss_closed_at timestamptz;
alter table public.conferences add column if not exists loss_request_id uuid;
create unique index if not exists conferences_loss_request_id_idx on public.conferences(loss_request_id) where loss_request_id is not null;

-- Keep every submitted batch. The app totals active batches by barcode.
-- Invoker rights preserve the existing ownership policies.
create or replace function public.add_loss_batch(p_request_id uuid, p_inspector text, p_items jsonb)
returns uuid language plpgsql security invoker set search_path = public as $$
declare record_id uuid; item jsonb;
begin
  if auth.uid() is null or coalesce(public.my_role(),'') not in ('conferente','admin') then
    raise exception 'Sem permissão para registrar perdas';
  end if;
  if p_request_id is null or nullif(trim(p_inspector),'') is null or jsonb_typeof(p_items) is distinct from 'array' then
    raise exception 'Lançamento inválido';
  end if;
  if jsonb_array_length(p_items) < 1 or jsonb_array_length(p_items) > 500 then raise exception 'Quantidade de itens inválida'; end if;
  perform pg_advisory_xact_lock(20261031, 20);
  select id into record_id from public.conferences where loss_request_id=p_request_id and created_by=auth.uid();
  if record_id is not null then return record_id; end if;
  for item in select value from jsonb_array_elements(p_items) loop
    if nullif(trim(item->>'barcode'),'') is null or nullif(trim(item->>'description'),'') is null
      or coalesce(item->>'quantity','') !~ '^[0-9]+([.][0-9]+)?$'
      or (item->>'quantity')::numeric < 1 or (item->>'quantity')::numeric > 1000000000
      or nullif(item->>'photo_url','') is null then raise exception 'Item de perda inválido'; end if;
  end loop;
  insert into public.conferences(invoice_number,inspector_name,status,created_by,record_kind,loss_request_id)
  values ('Perdas acumuladas',trim(p_inspector),'salva',auth.uid(),'loss',p_request_id) returning id into record_id;
  insert into public.conference_items(conference_id,barcode,description,quantity,observation,photo_path,photo_url)
  select record_id,trim(value->>'barcode'),trim(value->>'description'),(value->>'quantity')::numeric,
    coalesce(value->>'observation',''),coalesce(value->>'photo_path',''),value->>'photo_url'
  from jsonb_array_elements(p_items);
  return record_id;
end; $$;

create or replace function public.close_loss_period()
returns integer language plpgsql security invoker set search_path = public as $$
declare changed integer;
begin
  if auth.uid() is null or coalesce(public.my_role(),'') <> 'admin' then raise exception 'Somente o administrador pode zerar as perdas'; end if;
  perform pg_advisory_xact_lock(20261031, 20);
  update public.conferences set loss_closed_at=now(),updated_at=now() where record_kind='loss' and loss_closed_at is null;
  get diagnostics changed = row_count;
  return changed;
end; $$;
revoke all on function public.add_loss_batch(uuid,text,jsonb) from public, anon;
revoke all on function public.close_loss_period() from public, anon;
grant execute on function public.add_loss_batch(uuid,text,jsonb) to authenticated;
grant execute on function public.close_loss_period() to authenticated;
notify pgrst, 'reload schema';
commit;
