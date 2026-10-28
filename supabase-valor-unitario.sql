alter table public.purchase_order_items add column if not exists unit_price numeric(12,2) check (unit_price >= 0);
