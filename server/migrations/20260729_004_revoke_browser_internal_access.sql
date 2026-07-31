-- ACPARK Supabase hardening - 004 revoke browser grants from all public application tables
-- This is intentionally broad because ACPARK does not use supabase-js in the browser.
-- Validate in homologation before production.
--
-- Rollback:
--   Use public.security_hardening_backup_privileges_20260729 to restore only the grants
--   proven to be necessary. Do not restore broad DELETE/UPDATE to browser roles by default.

BEGIN;

DO $$
DECLARE
  r record;
BEGIN
  FOR r IN
    SELECT tablename
    FROM pg_tables
    WHERE schemaname = 'public'
      AND tablename NOT LIKE 'archive_%'
  LOOP
    EXECUTE format('REVOKE ALL ON TABLE public.%I FROM anon, authenticated', r.tablename);
  END LOOP;
END $$;

COMMIT;
