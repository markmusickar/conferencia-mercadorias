-- Execute no SQL Editor do Supabase antes de publicar a interface.
-- Adiciona o campo sem alterar os itens existentes.
alter table public.conference_items add column if not exists observation text not null default '';
notify pgrst, 'reload schema';
