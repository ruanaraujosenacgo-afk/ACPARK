-- ACPARK Supabase hardening - 008 archive legacy Orion direct flow
-- Current architecture is ORION -> OMIE -> ACPARK. This migration disables the old
-- Orion -> ACPARK stock trigger and archives vendas_orion without deleting data.
--
-- Rollback:
--   ALTER TABLE IF EXISTS public.archive_vendas_orion_20260729 RENAME TO vendas_orion;
--   Recreate trigger trg_baixa_estoque_orion only if the old direct Orion flow is restored.

BEGIN;

DO $$
BEGIN
  IF to_regclass('public.vendas_orion') IS NOT NULL THEN
    DROP TRIGGER IF EXISTS trg_baixa_estoque_orion ON public.vendas_orion;
  END IF;

  IF to_regprocedure('public.registrar_movimentacao_orion(text, text, integer, text)') IS NOT NULL THEN
    REVOKE ALL ON FUNCTION public.registrar_movimentacao_orion(text, text, integer, text)
      FROM anon, authenticated, public;
  END IF;

  IF to_regclass('public.vendas_orion') IS NOT NULL
     AND to_regclass('public.archive_vendas_orion_20260729') IS NULL THEN
    ALTER TABLE public.vendas_orion RENAME TO archive_vendas_orion_20260729;
    ALTER TABLE public.archive_vendas_orion_20260729 ENABLE ROW LEVEL SECURITY;
    REVOKE ALL ON TABLE public.archive_vendas_orion_20260729 FROM anon, authenticated;
    GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.archive_vendas_orion_20260729 TO service_role;
  END IF;
END $$;

COMMIT;
