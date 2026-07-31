-- ACPARK Supabase hardening - 007 archive legacy print-agent tables
-- This does not drop data. It archives tables so homologation can prove they are unused.
--
-- Rollback:
--   ALTER TABLE IF EXISTS public.archive_pedido_impressao_jobs_20260729
--     RENAME TO pedido_impressao_jobs;
--   ALTER TABLE IF EXISTS public.archive_pedido_impressao_historico_20260729
--     RENAME TO pedido_impressao_historico;

BEGIN;

DO $$
BEGIN
  IF to_regclass('public.pedido_impressao_jobs') IS NOT NULL
     AND to_regclass('public.archive_pedido_impressao_jobs_20260729') IS NULL THEN
    ALTER TABLE public.pedido_impressao_jobs RENAME TO archive_pedido_impressao_jobs_20260729;
    ALTER TABLE public.archive_pedido_impressao_jobs_20260729 ENABLE ROW LEVEL SECURITY;
    REVOKE ALL ON TABLE public.archive_pedido_impressao_jobs_20260729 FROM anon, authenticated;
    GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.archive_pedido_impressao_jobs_20260729 TO service_role;
  END IF;

  IF to_regclass('public.pedido_impressao_historico') IS NOT NULL
     AND to_regclass('public.archive_pedido_impressao_historico_20260729') IS NULL THEN
    ALTER TABLE public.pedido_impressao_historico RENAME TO archive_pedido_impressao_historico_20260729;
    ALTER TABLE public.archive_pedido_impressao_historico_20260729 ENABLE ROW LEVEL SECURITY;
    REVOKE ALL ON TABLE public.archive_pedido_impressao_historico_20260729 FROM anon, authenticated;
    GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.archive_pedido_impressao_historico_20260729 TO service_role;
  END IF;
END $$;

COMMIT;
