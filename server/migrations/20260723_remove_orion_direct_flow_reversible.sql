-- Remove o fluxo antigo Orion -> ACPARK -> estoque local.
-- Execute manualmente somente apos validar que Orion esta integrado diretamente ao OMIE.

DO $$
BEGIN
  IF to_regclass('public.vendas_orion') IS NOT NULL THEN
    EXECUTE 'CREATE TABLE IF NOT EXISTS vendas_orion_backup_20260723 AS TABLE vendas_orion';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'pdvs'
      AND column_name = 'codigo_orion'
  ) THEN
    EXECUTE 'CREATE TABLE IF NOT EXISTS pdvs_codigo_orion_backup_20260723 AS SELECT id, nome, codigo_orion FROM pdvs';
  END IF;
END $$;

DROP TABLE IF EXISTS vendas_orion;
ALTER TABLE pdvs DROP COLUMN IF EXISTS codigo_orion;

DELETE FROM configuracoes
WHERE chave IN ('omie_app_key', 'omie_app_secret');
