-- Produto com mais de um código de barras (comum em importados): o produto tem um código principal
-- e quantos códigos extras precisar. Ler qualquer um deles conta no mesmo produto.
-- Precisa ter rodado antes: supabase-produtos.sql (e a função public.my_role()).
begin;

create table if not exists public.product_codes (
  code text primary key check (length(trim(code)) > 0),
  product_barcode text not null references public.products(barcode) on update cascade on delete cascade,
  created_at timestamptz not null default now(),
  created_by uuid default auth.uid(),
  check (code <> product_barcode)
);
create index if not exists product_codes_product_idx on public.product_codes (product_barcode);

alter table public.product_codes enable row level security;
revoke all on public.product_codes from anon, authenticated;
grant select on public.product_codes to authenticated;
drop policy if exists "equipe consulta codigos extras" on public.product_codes;
create policy "equipe consulta codigos extras" on public.product_codes for select to authenticated
using (public.my_role() in ('admin', 'compras', 'conferente'));

-- Vincula um código extra a um produto já cadastrado.
create or replace function public.link_product_code(p_code text, p_product_barcode text)
returns void language plpgsql security definer set search_path = '' as $$
declare
  extra text := trim(coalesce(p_code, ''));
  main text := trim(coalesce(p_product_barcode, ''));
  resolved text;
begin
  if public.my_role() is null or public.my_role() not in ('admin', 'conferente') then
    raise exception 'Sem permissão para vincular códigos.';
  end if;
  if extra = '' or main = '' then raise exception 'Informe os dois códigos.'; end if;
  perform pg_advisory_xact_lock(hashtext('product_codes'));
  -- Se escolheram um código extra como "principal", usa o principal verdadeiro.
  select product_barcode into resolved from public.product_codes where code = main;
  if found then main := resolved; end if;
  if extra = main then raise exception 'Esse já é o código principal do produto.'; end if;
  if not exists (select 1 from public.products where barcode = main) then
    raise exception 'Produto principal não encontrado.';
  end if;
  if exists (select 1 from public.product_codes where code = extra and product_barcode <> main) then
    raise exception 'Esse código já pertence a outro produto.';
  end if;
  -- O código pode ter sido cadastrado sozinho antes: leva os extras dele para o produto principal e apaga o cadastro repetido.
  update public.product_codes set product_barcode = main where product_barcode = extra;
  delete from public.products where barcode = extra;
  insert into public.product_codes (code, product_barcode) values (extra, main) on conflict (code) do nothing;
end;
$$;

-- Desfaz um vínculo (só administrador).
create or replace function public.unlink_product_code(p_code text)
returns void language plpgsql security definer set search_path = '' as $$
begin
  if public.my_role() is distinct from 'admin' then raise exception 'Só o administrador desfaz vínculos.'; end if;
  delete from public.product_codes where code = trim(coalesce(p_code, ''));
end;
$$;

revoke all on function public.link_product_code(text, text), public.unlink_product_code(text) from public, anon;
grant execute on function public.link_product_code(text, text), public.unlink_product_code(text) to authenticated;

-- Um código extra não vira produto separado ao salvar a conferência.
create or replace function public.remember_conference_product()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  if trim(coalesce(new.barcode, '')) <> '' and trim(coalesce(new.description, '')) <> ''
     and not exists (select 1 from public.product_codes where code = trim(new.barcode)) then
    insert into public.products (barcode, description, updated_at)
    values (trim(new.barcode), trim(new.description), now())
    on conflict (barcode) do update set description = excluded.description, updated_at = excluded.updated_at;
  end if;
  return new;
end;
$$;

commit;
