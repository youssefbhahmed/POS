-- ─────────────────────────────────────────────────────────────
--  Rôles : GÉRANT (tout) / CAISSE (uniquement la prise de commande)
--  À exécuter dans Supabase : SQL Editor → New query → Run
--  (sans danger si on le relance)
--
--  Par défaut, tout compte est « caisse ».
--  Un compte devient gérant avec la commande tout en bas de ce fichier.
-- ─────────────────────────────────────────────────────────────

-- Le rôle est lu dans app_metadata du jeton : seul un administrateur
-- Supabase peut le modifier, pas l'utilisateur lui-même.
create or replace function public.is_manager() returns boolean
language sql stable set search_path = '' as $$
  select coalesce(auth.jwt() -> 'app_metadata' ->> 'role', '') = 'manager'
$$;

do $$
declare t text; p record;
begin
  foreach t in array array['categories','products','cafe_tables','orders','order_items','settings'] loop
    execute format('alter table public.%I enable row level security', t);
    -- on repart de zéro sur les règles de chaque table
    for p in select policyname from pg_policies where schemaname = 'public' and tablename = t loop
      execute format('drop policy %I on public.%I', p.policyname, t);
    end loop;
    -- Le gérant peut tout faire
    execute format('create policy "manager_all" on public.%I for all to authenticated using (public.is_manager()) with check (public.is_manager())', t);
  end loop;
end $$;

-- Carte, tables, paramètres : la caisse peut seulement LIRE
create policy "staff_read" on public.categories  for select to authenticated using (true);
create policy "staff_read" on public.products    for select to authenticated using (true);
create policy "staff_read" on public.cafe_tables for select to authenticated using (true);
create policy "staff_read" on public.settings    for select to authenticated using (true);

-- Commandes : la caisse voit les commandes en cours et celles des dernières 24 h,
-- crée et modifie des commandes EN COURS, mais ne touche jamais à l'historique.
create policy "staff_select" on public.orders for select to authenticated
  using (status = 'open' or closed_at > now() - interval '24 hours');
create policy "staff_insert" on public.orders for insert to authenticated
  with check (status = 'open');
create policy "staff_update" on public.orders for update to authenticated
  using (status = 'open') with check (true);
create policy "staff_delete" on public.orders for delete to authenticated
  using (status = 'open');

-- Lignes de commande : uniquement sur des commandes en cours
create policy "staff_select" on public.order_items for select to authenticated
  using (exists (select 1 from public.orders o where o.id = order_id));
create policy "staff_insert" on public.order_items for insert to authenticated
  with check (exists (select 1 from public.orders o where o.id = order_id and o.status = 'open'));
create policy "staff_update" on public.order_items for update to authenticated
  using (exists (select 1 from public.orders o where o.id = order_id and o.status = 'open'))
  with check (exists (select 1 from public.orders o where o.id = order_id and o.status = 'open'));

-- ─────────────────────────────────────────────────────────────
--  Désigner le GÉRANT : remplacez l'email puis exécutez.
--  (Le gérant doit ensuite se déconnecter / reconnecter.)
-- ─────────────────────────────────────────────────────────────
-- update auth.users
--   set raw_app_meta_data = coalesce(raw_app_meta_data, '{}'::jsonb) || '{"role":"manager"}'
--   where email = 'VOTRE_EMAIL_GERANT';
