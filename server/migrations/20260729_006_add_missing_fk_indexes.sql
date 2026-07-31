-- ACPARK Supabase hardening - 006 performance advisor indexes
-- Adds covering indexes for foreign keys reported by Supabase performance advisors.
-- Does not remove unused indexes except the confirmed duplicate on product_integration_mappings.
--
-- Rollback:
--   DROP INDEX IF EXISTS public.<index_name>;
--   Recreate idx_product_integration_external_unique if the duplicate removal is reverted.

BEGIN;

CREATE INDEX IF NOT EXISTS idx_devolucao_avaria_fotos_owner_pdv ON public.devolucao_avaria_fotos(owner_pdv_id);
CREATE INDEX IF NOT EXISTS idx_devolucao_idempotencia_pdv ON public.devolucao_idempotencia(pdv_id);
CREATE INDEX IF NOT EXISTS idx_estoque_avarias_pdv ON public.estoque_avarias(pdv_id);
CREATE INDEX IF NOT EXISTS idx_estoque_avarias_sku ON public.estoque_avarias(sku_produto);
CREATE INDEX IF NOT EXISTS idx_integration_attempts_integration ON public.integration_attempts(integration_id);
CREATE INDEX IF NOT EXISTS idx_integration_attempts_job ON public.integration_attempts(job_id);
CREATE INDEX IF NOT EXISTS idx_integration_audit_logs_integration ON public.integration_audit_logs(integration_id);
CREATE INDEX IF NOT EXISTS idx_integration_jobs_integration ON public.integration_jobs(integration_id);
CREATE INDEX IF NOT EXISTS idx_integration_webhooks_integration ON public.integration_webhooks(integration_id);
CREATE INDEX IF NOT EXISTS idx_omie_jobs_pdv ON public.omie_jobs(pdv_id);
CREATE INDEX IF NOT EXISTS idx_pdv_stock_location_mappings_integration ON public.pdv_stock_location_mappings(integration_id);
CREATE INDEX IF NOT EXISTS idx_pedido_historico_pdv ON public.pedido_historico(pdv_id);
CREATE INDEX IF NOT EXISTS idx_pedido_idempotencia_pdv ON public.pedido_idempotencia(pdv_id);
CREATE INDEX IF NOT EXISTS idx_pedido_operacao_idempotencia_pdv ON public.pedido_operacao_idempotencia(pdv_id);
CREATE INDEX IF NOT EXISTS idx_product_integration_mappings_sku ON public.product_integration_mappings(sku_produto);
CREATE INDEX IF NOT EXISTS idx_product_sync_temperature_sku ON public.product_sync_temperature(sku_produto);
CREATE INDEX IF NOT EXISTS idx_stock_movement_items_movement ON public.stock_movement_items(movement_id);
CREATE INDEX IF NOT EXISTS idx_stock_movement_items_sku ON public.stock_movement_items(sku_produto);
CREATE INDEX IF NOT EXISTS idx_stock_movements_pdv ON public.stock_movements(pdv_id);
CREATE INDEX IF NOT EXISTS idx_stock_reconciliation_items_pdv ON public.stock_reconciliation_items(pdv_id);
CREATE INDEX IF NOT EXISTS idx_stock_reconciliation_items_reconciliation ON public.stock_reconciliation_items(reconciliation_id);
CREATE INDEX IF NOT EXISTS idx_stock_reconciliation_items_sku ON public.stock_reconciliation_items(sku_produto);
CREATE INDEX IF NOT EXISTS idx_stock_reconciliations_integration ON public.stock_reconciliations(integration_id);
CREATE INDEX IF NOT EXISTS idx_stock_snapshots_integration ON public.stock_snapshots(integration_id);

DROP INDEX IF EXISTS public.idx_product_integration_external_unique;

COMMIT;
