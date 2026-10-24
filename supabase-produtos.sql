begin;
create table if not exists public.products (
  barcode text primary key check (length(trim(barcode)) > 0),
  description text not null check (length(trim(description)) > 0),
  updated_at timestamptz not null default now()
);
alter table public.products enable row level security;
grant select on public.products to authenticated;
drop policy if exists "equipe consulta produtos" on public.products;
create policy "equipe consulta produtos" on public.products for select to authenticated
using (public.my_role() in ('admin', 'compras', 'conferente'));

-- Só importar códigos com uma descrição única no histórico.
insert into public.products (barcode, description)
select trim(barcode), min(trim(description)) from public.conference_items
where trim(coalesce(barcode, '')) <> '' and trim(coalesce(description, '')) <> ''
group by trim(barcode) having count(distinct lower(trim(description))) = 1
on conflict (barcode) do nothing;

create or replace function public.remember_conference_product()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  if trim(coalesce(new.barcode, '')) <> '' and trim(coalesce(new.description, '')) <> '' then
    insert into public.products (barcode, description, updated_at)
    values (trim(new.barcode), trim(new.description), now())
    on conflict (barcode) do update set description = excluded.description, updated_at = excluded.updated_at;
  end if;
  return new;
end;
$$;
revoke all on function public.remember_conference_product() from public, anon, authenticated;
drop trigger if exists remember_conference_product on public.conference_items;
create trigger remember_conference_product after insert or update of barcode, description
on public.conference_items for each row execute function public.remember_conference_product();
commit;
