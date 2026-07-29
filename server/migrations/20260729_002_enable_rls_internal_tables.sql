-- ACPARK Supabase hardening - 002 enable RLS on exposed public tables
-- Strategy: all browser direct access is denied by default. The ACPARK backend uses
-- DATABASE_URL and remains responsible for validating sessions, PDV ownership and roles.
--
-- Rollback:
--   For each table listed here, run:
--     DROP POLICY IF EXISTS "browser deny all <table>" ON public.<table>;
--     ALTER TABLE public.<table> DISABLE ROW LEVEL SECURITY;
--   Restore grants from public.security_hardening_backup_privileges_20260729 if needed.

BEGIN;

DO $$
DECLARE
  t text;
  tables text[] := ARRAY[
    'categorias',
    'devolucao_avaria_fotos',
    'devolucao_avaria_historico',
    'devolucao_avaria_itens',
    'devolucao_idempotencia',
    'devolucoes_avaria',
    'estoque_avarias',
    'omie_jobs',
    'omie_stock_locations',
    'order_alert_sounds',
    'pdv_categorias',
    'pdv_stock_location_mappings',
    'pedido_historico',
    'pedido_idempotencia',
    'pedido_operacao_idempotencia',
    'pedido_rascunhos',
    'product_integration_mappings',
    'product_sync_temperature',
    'produto_categorias',
    'stock_movement_items',
    'stock_movements',
    'stock_reconciliation_items',
    'stock_reconciliations',
    'stock_refresh_queue',
    'stock_snapshots',
    'user_order_alert_preferences'
  ];
BEGIN
  FOREACH t IN ARRAY tables LOOP
    IF to_regclass(format('public.%I', t)) IS NOT NULL THEN
      EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', t);
      EXECUTE format('REVOKE ALL ON TABLE public.%I FROM anon, authenticated', t);
      EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.%I TO service_role', t);
      EXECUTE format('DROP POLICY IF EXISTS %I ON public.%I', 'browser deny all ' || t, t);
      EXECUTE format(
        'CREATE POLICY %I ON public.%I FOR ALL TO anon, authenticated USING (false) WITH CHECK (false)',
        'browser deny all ' || t,
        t
      );
    END IF;
  END LOOP;
END $$;

COMMIT;
