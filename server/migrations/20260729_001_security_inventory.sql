-- ACPARK Supabase hardening - 001 security inventory
-- Purpose: capture schema, RLS, policy, grant, function, trigger, view and bucket state
-- before any hardening change. Run in homologation first.
--
-- Rollback:
--   DROP TABLE IF EXISTS public.security_hardening_inventory_20260729;
--   DROP TABLE IF EXISTS public.security_hardening_backup_privileges_20260729;

BEGIN;

CREATE TABLE IF NOT EXISTS public.security_hardening_inventory_20260729 (
  id BIGSERIAL PRIMARY KEY,
  captured_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  object_type TEXT NOT NULL,
  schema_name TEXT NOT NULL,
  object_name TEXT NOT NULL,
  details JSONB NOT NULL DEFAULT '{}'::jsonb
);

ALTER TABLE public.security_hardening_inventory_20260729 ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.security_hardening_inventory_20260729 FROM anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.security_hardening_inventory_20260729 TO service_role;
DROP POLICY IF EXISTS "browser deny all security_hardening_inventory_20260729" ON public.security_hardening_inventory_20260729;
CREATE POLICY "browser deny all security_hardening_inventory_20260729"
  ON public.security_hardening_inventory_20260729
  FOR ALL
  TO anon, authenticated
  USING (false)
  WITH CHECK (false);

CREATE TABLE IF NOT EXISTS public.security_hardening_backup_privileges_20260729 (
  id BIGSERIAL PRIMARY KEY,
  captured_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  table_schema TEXT NOT NULL,
  table_name TEXT NOT NULL,
  grantee TEXT NOT NULL,
  privilege_type TEXT NOT NULL
);

ALTER TABLE public.security_hardening_backup_privileges_20260729 ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.security_hardening_backup_privileges_20260729 FROM anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.security_hardening_backup_privileges_20260729 TO service_role;
DROP POLICY IF EXISTS "browser deny all security_hardening_backup_privileges_20260729" ON public.security_hardening_backup_privileges_20260729;
CREATE POLICY "browser deny all security_hardening_backup_privileges_20260729"
  ON public.security_hardening_backup_privileges_20260729
  FOR ALL
  TO anon, authenticated
  USING (false)
  WITH CHECK (false);

INSERT INTO public.security_hardening_backup_privileges_20260729
  (table_schema, table_name, grantee, privilege_type)
SELECT table_schema, table_name, grantee, privilege_type
FROM information_schema.role_table_grants
WHERE table_schema IN ('public', 'storage')
  AND grantee IN ('anon', 'authenticated', 'service_role');

INSERT INTO public.security_hardening_inventory_20260729
  (object_type, schema_name, object_name, details)
SELECT
  'table',
  n.nspname,
  c.relname,
  jsonb_build_object(
    'rls_enabled', c.relrowsecurity,
    'rls_forced', c.relforcerowsecurity,
    'estimated_rows', COALESCE(s.n_live_tup, 0),
    'policies', COALESCE((
      SELECT jsonb_agg(jsonb_build_object(
        'policy', p.polname,
        'cmd', p.polcmd,
        'roles', (
          SELECT array_agg(r.rolname)
          FROM pg_roles r
          WHERE r.oid = ANY(p.polroles)
        ),
        'using', pg_get_expr(p.polqual, p.polrelid),
        'with_check', pg_get_expr(p.polwithcheck, p.polrelid)
      ) ORDER BY p.polname)
      FROM pg_policy p
      WHERE p.polrelid = c.oid
    ), '[]'::jsonb),
    'indexes', COALESCE((
      SELECT jsonb_agg(indexname ORDER BY indexname)
      FROM pg_indexes i
      WHERE i.schemaname = n.nspname
        AND i.tablename = c.relname
    ), '[]'::jsonb)
  )
FROM pg_class c
JOIN pg_namespace n ON n.oid = c.relnamespace
LEFT JOIN pg_stat_user_tables s ON s.relid = c.oid
WHERE n.nspname = 'public'
  AND c.relkind IN ('r', 'p');

INSERT INTO public.security_hardening_inventory_20260729
  (object_type, schema_name, object_name, details)
SELECT
  'function',
  n.nspname,
  p.proname,
  jsonb_build_object(
    'arguments', pg_get_function_arguments(p.oid),
    'security_definer', p.prosecdef,
    'config', COALESCE(p.proconfig, ARRAY[]::text[])
  )
FROM pg_proc p
JOIN pg_namespace n ON n.oid = p.pronamespace
WHERE n.nspname = 'public';

INSERT INTO public.security_hardening_inventory_20260729
  (object_type, schema_name, object_name, details)
SELECT
  'bucket',
  'storage',
  id,
  jsonb_build_object(
    'name', name,
    'public', public,
    'file_size_limit', file_size_limit,
    'allowed_mime_types', allowed_mime_types
  )
FROM storage.buckets;

COMMIT;
