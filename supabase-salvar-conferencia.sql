-- Execute no SQL Editor do Supabase.
-- Salva a conferência inteira (cabeçalho + itens) numa única operação "tudo ou nada" e avisa se
-- outra pessoa alterou a mesma conferência depois que ela foi aberta.
--
-- Antes: o app atualizava a conferência, apagava todos os itens e inseria de novo, em três chamadas.
-- Se a internet caísse no meio, os itens podiam sumir. Agora é uma chamada só.
--
-- p_id                  id da conferência. Para uma conferência nova, o app gera o id antes de enviar.
-- p_expected_updated_at data da última alteração que o app conhecia. Se a conferência no banco já foi
--                       alterada depois disso, o salvamento é recusado (erro CONFERENCIA_ALTERADA).
--                       Para conferência nova, o app envia nulo.

begin;

create or replace function public.save_conference(
  p_id uuid, p_invoice text, p_inspector text, p_items jsonb, p_expected_updated_at timestamptz
) returns jsonb language plpgsql security invoker set search_path = public as $$
declare
  conf public.conferences%rowtype;
  item jsonb;
begin
  if auth.uid() is null or coalesce(public.my_role(), '') not in ('conferente', 'admin') then
    raise exception 'Sem permissão para salvar conferências';
  end if;
  if p_id is null or nullif(trim(p_invoice), '') is null or nullif(trim(p_inspector), '') is null
     or jsonb_typeof(p_items) is distinct from 'array' then
    raise exception 'Conferência inválida';
  end if;
  if jsonb_array_length(p_items) < 1 or jsonb_array_length(p_items) > 500 then
    raise exception 'Quantidade de itens inválida';
  end if;
  for item in select value from jsonb_array_elements(p_items) loop
    if jsonb_typeof(item) is distinct from 'object'
       or nullif(trim(item->>'barcode'), '') is null
       or nullif(trim(item->>'description'), '') is null
       or coalesce(item->>'quantity', '') !~ '^[0-9]+([.][0-9]+)?$'
       or (item->>'quantity')::numeric < 1 or (item->>'quantity')::numeric > 1000000000 then
      raise exception 'Item inválido na conferência';
    end if;
  end loop;

  -- Trava a conferência enquanto salva, para duas pessoas não gravarem ao mesmo tempo.
  perform pg_advisory_xact_lock(20261112, hashtext(p_id::text));
  select * into conf from public.conferences where id = p_id;

  if found then
    if conf.record_kind is distinct from 'conference' then
      raise exception 'Este registro não é uma conferência';
    end if;
    if p_expected_updated_at is not null and conf.updated_at is distinct from p_expected_updated_at then
      raise exception 'CONFERENCIA_ALTERADA: esta conferência foi alterada por outra pessoa depois que você a abriu';
    end if;
    update public.conferences
       set invoice_number = trim(p_invoice), inspector_name = trim(p_inspector), status = 'salva', updated_at = now()
     where id = p_id
    returning * into conf;
    if not found then raise exception 'Sem permissão para alterar esta conferência'; end if;
    delete from public.conference_items where conference_id = p_id;
  else
    if p_expected_updated_at is not null then
      raise exception 'CONFERENCIA_NAO_ENCONTRADA: esta conferência não existe mais (pode ter sido excluída)';
    end if;
    begin
      insert into public.conferences(id, invoice_number, inspector_name, status, created_by, record_kind, created_at, updated_at)
      values (p_id, trim(p_invoice), trim(p_inspector), 'salva', auth.uid(), 'conference', now(), now())
      returning * into conf;
    exception when unique_violation then
      raise exception 'Sem permissão para alterar esta conferência';
    end;
  end if;

  insert into public.conference_items(conference_id, barcode, description, quantity, observation, photo_path, photo_url)
  select p_id, trim(value->>'barcode'), trim(value->>'description'), (value->>'quantity')::numeric,
         coalesce(value->>'observation', ''), coalesce(value->>'photo_path', ''), coalesce(value->>'photo_url', '')
    from jsonb_array_elements(p_items);

  return jsonb_build_object('id', conf.id, 'updated_at', conf.updated_at);
end; $$;

revoke all on function public.save_conference(uuid, text, text, jsonb, timestamptz) from public, anon;
grant execute on function public.save_conference(uuid, text, text, jsonb, timestamptz) to authenticated;
notify pgrst, 'reload schema';

commit;
