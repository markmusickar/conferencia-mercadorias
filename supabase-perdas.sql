alter table public.conferences add column if not exists record_kind text not null default 'conference' check (record_kind in ('conference', 'loss'));
notify pgrst, 'reload schema';
select column_name from information_schema.columns where table_schema='public' and table_name='conferences' and column_name='record_kind';
