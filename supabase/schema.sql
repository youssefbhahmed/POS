-- ─────────────────────────────────────────────────────────────
--  Caisse Café — schéma Supabase
--  À exécuter UNE FOIS dans Supabase : SQL Editor → New query → Run
-- ─────────────────────────────────────────────────────────────

create extension if not exists pgcrypto;

create table if not exists categories (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  color text not null default '#6f4e37',
  sort int not null default 0,
  created_at timestamptz not null default now()
);

create table if not exists products (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  price int not null default 0,              -- en millimes (1 DT = 1000)
  category_id uuid references categories(id) on delete set null,
  active boolean not null default true,
  sort int not null default 0,
  created_at timestamptz not null default now()
);

create table if not exists cafe_tables (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  sort int not null default 0,
  active boolean not null default true,
  created_at timestamptz not null default now()
);

create table if not exists orders (
  id uuid primary key default gen_random_uuid(),
  number bigserial,                          -- numéro de ticket
  table_id uuid references cafe_tables(id) on delete set null,
  table_name text,
  status text not null default 'open' check (status in ('open', 'paid', 'cancelled')),
  opened_at timestamptz not null default now(),
  closed_at timestamptz,
  total int not null default 0,              -- en millimes
  payment_method text,                       -- cash | card | other
  amount_received int,
  cancel_reason text,
  created_at timestamptz not null default now()
);
create index if not exists orders_status_idx on orders (status);
create index if not exists orders_closed_at_idx on orders (closed_at);

create table if not exists order_items (
  id uuid primary key default gen_random_uuid(),
  order_id uuid not null references orders(id) on delete cascade,
  product_id uuid references products(id) on delete set null,
  product_name text not null,
  category_name text,
  unit_price int not null,                   -- en millimes
  qty int not null default 1,                -- quantité servie / facturée
  cancelled_qty int not null default 0,      -- quantité retirée (traçabilité)
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists order_items_order_idx on order_items (order_id);

create table if not exists settings (
  id text primary key,
  data jsonb not null default '{}'::jsonb,
  updated_at timestamptz not null default now()
);

-- ── Sécurité : seuls les comptes connectés ont accès ─────────
-- Les règles par rôle (gérant / caisse) sont dans roles.sql :
-- exécutez-le juste après ce fichier.
do $$
declare t text;
begin
  foreach t in array array['categories','products','cafe_tables','orders','order_items','settings'] loop
    execute format('alter table %I enable row level security', t);
  end loop;
end $$;

-- ── Temps réel ───────────────────────────────────────────────
alter publication supabase_realtime add table categories, products, cafe_tables, orders, order_items, settings;

-- ── Données de départ (modifiables ensuite dans le back-office) ──
insert into settings (id, data) values ('main', '{"shopName":"Mon Café","footer":"Merci de votre visite !"}')
on conflict (id) do nothing;

do $$
declare c1 uuid; c2 uuid; c3 uuid; c4 uuid;
begin
  if (select count(*) from categories) = 0 then
    insert into categories (name, color, sort) values ('Cafés & thés', '#EA580C', 1) returning id into c1;
    insert into categories (name, color, sort) values ('Boissons', '#2563EB', 2) returning id into c2;
    insert into categories (name, color, sort) values ('Jus', '#DB2777', 3) returning id into c3;
    insert into categories (name, color, sort) values ('À manger', '#059669', 4) returning id into c4;
    insert into products (name, price, category_id, sort) values
      ('Express', 1500, c1, 1), ('Capucin', 1800, c1, 2), ('Direct', 2000, c1, 3), ('Cappuccino', 3500, c1, 4),
      ('Thé à la menthe', 1500, c1, 5), ('Eau 0,5 L', 1000, c2, 6), ('Soda', 2500, c2, 7),
      ('Jus d''orange', 4000, c3, 8), ('Croissant', 1500, c4, 9), ('Sandwich thon', 6500, c4, 10);
    insert into cafe_tables (name, sort)
      select 'Table ' || g, g from generate_series(1, 10) g;
  end if;
end $$;
