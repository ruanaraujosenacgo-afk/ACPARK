-- ACPARK Supabase hardening - 003 replace broad authenticated CRUD policies
-- Removes unrestricted authenticated policies and denies direct browser access.
-- The application server remains the authorization boundary for operational writes.
--
-- Rollback:
--   Prefer restoring narrowly scoped policies from an approved access matrix.
--   Do not restore generic authenticated CRUD policies unless a separate security
--   review formally approves direct Supabase client access.

BEGIN;

DO $$
DECLARE
  t text;
  tables text[] := ARRAY[
    'estoque_pdv',
    'logs_atividades',
    'pedidos',
    'produtos',
    'solicitacoes',
    'vendas_orion'
  ];
BEGIN
  FOREACH t IN ARRAY tables LOOP
    IF to_regclass(format('public.%I', t)) IS NOT NULL THEN
      EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', t);
      EXECUTE format('DROP POLICY IF EXISTS %I ON public.%I', 'authenticated CRUD ' || t, t);
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
