-- ACPARK Supabase hardening - 005 secure functions and exposed views
-- Current audit found no SECURITY DEFINER function in public. This migration locks down
-- legacy Orion functions and documents the expected search_path posture.
--
-- Rollback:
--   GRANT EXECUTE ON FUNCTION public.registrar_movimentacao_orion(text, text, integer, text) TO anon, authenticated;
--   Only do this if the old Orion -> ACPARK flow is intentionally restored.

BEGIN;

DO $$
BEGIN
  IF to_regprocedure('public.registrar_movimentacao_orion(text, text, integer, text)') IS NOT NULL THEN
    REVOKE ALL ON FUNCTION public.registrar_movimentacao_orion(text, text, integer, text)
      FROM anon, authenticated, public;

    COMMENT ON FUNCTION public.registrar_movimentacao_orion(text, text, integer, text)
      IS 'LEGACY ACPARK: old Orion direct ingestion entrypoint. Browser/API execution revoked during hardening.';
  END IF;

  IF to_regprocedure('public.processar_baixa_estoque_orion()') IS NOT NULL THEN
    COMMENT ON FUNCTION public.processar_baixa_estoque_orion()
      IS 'LEGACY ACPARK: old Orion -> ACPARK stock movement trigger. Keep disabled during ORION -> OMIE -> ACPARK architecture.';
  END IF;
END $$;

COMMIT;
