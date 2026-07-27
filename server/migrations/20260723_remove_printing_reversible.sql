-- Limpeza reversivel das estruturas criadas apenas para QZ Tray/agente de impressao.
-- Execute manualmente no banco de producao somente depois de validar a aplicacao sem impressao automatica.
-- O script preserva os dados em tabelas de backup antes de remover tabelas e colunas.

DO $$
BEGIN
  IF to_regclass('public.pedido_impressao_jobs') IS NOT NULL THEN
    EXECUTE 'CREATE TABLE IF NOT EXISTS pedido_impressao_jobs_backup_20260723 AS TABLE pedido_impressao_jobs';
  END IF;

  IF to_regclass('public.pedido_impressao_historico') IS NOT NULL THEN
    EXECUTE 'CREATE TABLE IF NOT EXISTS pedido_impressao_historico_backup_20260723 AS TABLE pedido_impressao_historico';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'pedidos'
      AND column_name IN (
        'print_status',
        'print_attempts',
        'print_requested_at',
        'printed_at',
        'print_error',
        'print_version',
        'print_job_id',
        'printer_name',
        'paper_size'
      )
  ) THEN
    EXECUTE $backup$
      CREATE TABLE IF NOT EXISTS pedidos_print_backup_20260723 AS
      SELECT id,
             codigo_pedido,
             print_status,
             print_attempts,
             print_requested_at,
             printed_at,
             print_error,
             print_version,
             print_job_id,
             printer_name,
             paper_size
      FROM pedidos
    $backup$;
  END IF;
END $$;

DROP TABLE IF EXISTS pedido_impressao_jobs;
DROP TABLE IF EXISTS pedido_impressao_historico;

ALTER TABLE pedidos DROP COLUMN IF EXISTS print_status;
ALTER TABLE pedidos DROP COLUMN IF EXISTS print_attempts;
ALTER TABLE pedidos DROP COLUMN IF EXISTS print_requested_at;
ALTER TABLE pedidos DROP COLUMN IF EXISTS printed_at;
ALTER TABLE pedidos DROP COLUMN IF EXISTS print_error;
ALTER TABLE pedidos DROP COLUMN IF EXISTS print_version;
ALTER TABLE pedidos DROP COLUMN IF EXISTS print_job_id;
ALTER TABLE pedidos DROP COLUMN IF EXISTS printer_name;
ALTER TABLE pedidos DROP COLUMN IF EXISTS paper_size;

DELETE FROM configuracoes
WHERE chave IN (
  'print_agent_token',
  'print_agent_printer',
  'print_agent_paper',
  'print_auto_enabled',
  'print_auto_enabled_since'
);
