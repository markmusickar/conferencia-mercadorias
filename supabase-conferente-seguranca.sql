-- Rode este SQL no Supabase SQL Editor para reforçar a regra:
-- conferente vê somente as conferências que ele mesmo criou.
-- Administrador continua vendo tudo.

drop policy if exists "conferente ve proprias conferencias" on public.conferences;
create policy "conferente ve proprias conferencias"
on public.conferences for select
to authenticated
using (
  public.my_role() = 'admin'
  or public.my_role() = 'compras'
  or created_by = auth.uid()
);

drop policy if exists "conferente atualiza proprias conferencias" on public.conferences;
create policy "conferente atualiza proprias conferencias"
on public.conferences for update
to authenticated
using (
  public.my_role() = 'admin'
  or created_by = auth.uid()
)
with check (
  public.my_role() = 'admin'
  or created_by = auth.uid()
);

drop policy if exists "conferente exclui proprias conferencias" on public.conferences;
create policy "conferente exclui proprias conferencias"
on public.conferences for delete
to authenticated
using (
  public.my_role() = 'admin'
  or created_by = auth.uid()
);

drop policy if exists "conferente ve itens das proprias conferencias" on public.conference_items;
create policy "conferente ve itens das proprias conferencias"
on public.conference_items for select
to authenticated
using (
  public.my_role() = 'admin'
  or public.my_role() = 'compras'
  or exists (
    select 1
    from public.conferences c
    where c.id = conference_items.conference_id
      and c.created_by = auth.uid()
  )
);

drop policy if exists "conferente cria itens nas proprias conferencias" on public.conference_items;
create policy "conferente cria itens nas proprias conferencias"
on public.conference_items for insert
to authenticated
with check (
  public.my_role() = 'admin'
  or exists (
    select 1
    from public.conferences c
    where c.id = conference_items.conference_id
      and c.created_by = auth.uid()
  )
);

drop policy if exists "conferente apaga itens das proprias conferencias" on public.conference_items;
create policy "conferente apaga itens das proprias conferencias"
on public.conference_items for delete
to authenticated
using (
  public.my_role() = 'admin'
  or exists (
    select 1
    from public.conferences c
    where c.id = conference_items.conference_id
      and c.created_by = auth.uid()
  )
);
