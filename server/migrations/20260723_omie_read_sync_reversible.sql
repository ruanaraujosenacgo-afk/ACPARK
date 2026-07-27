-- Estruturas reversiveis para a etapa de leitura OMIE -> ACPARK.
-- Nao habilita operacoes de escrita no OMIE.

ALTER TABLE integrations ADD COLUMN IF NOT EXISTS last_connection_test_at TIMESTAMP;
ALTER TABLE integrations ADD COLUMN IF NOT EXISTS last_connection_duration_ms INTEGER;
ALTER TABLE integrations ADD COLUMN IF NOT EXISTS last_connection_message TEXT;
ALTER TABLE integrations ADD COLUMN IF NOT EXISTS stock_mode TEXT NOT NULL DEFAULT 'MANUAL';

ALTER TABLE integration_jobs ADD COLUMN IF NOT EXISTS current_page INTEGER DEFAULT 1;
ALTER TABLE integration_jobs ADD COLUMN IF NOT EXISTS cursor TEXT;
ALTER TABLE integration_jobs ADD COLUMN IF NOT EXISTS date_from TIMESTAMP;
ALTER TABLE integration_jobs ADD COLUMN IF NOT EXISTS date_to TIMESTAMP;
ALTER TABLE integration_jobs ADD COLUMN IF NOT EXISTS last_external_id TEXT;
ALTER TABLE integration_jobs ADD COLUMN IF NOT EXISTS last_processed_at TIMESTAMP;
ALTER TABLE integration_jobs ADD COLUMN IF NOT EXISTS locked_at TIMESTAMP;
ALTER TABLE integration_jobs ADD COLUMN IF NOT EXISTS locked_by TEXT;
ALTER TABLE integration_jobs ADD COLUMN IF NOT EXISTS completed_at TIMESTAMP;
ALTER TABLE integration_jobs ADD COLUMN IF NOT EXISTS priority TEXT NOT NULL DEFAULT 'NORMAL';
ALTER TABLE integration_jobs ADD COLUMN IF NOT EXISTS priority_rank INTEGER NOT NULL DEFAULT 50;

ALTER TABLE product_integration_mappings ADD COLUMN IF NOT EXISTS external_code TEXT;
ALTER TABLE product_integration_mappings ADD COLUMN IF NOT EXISTS integration_code TEXT;
ALTER TABLE product_integration_mappings ADD COLUMN IF NOT EXISTS unit TEXT DEFAULT 'UN';
ALTER TABLE product_integration_mappings ADD COLUMN IF NOT EXISTS family TEXT;
ALTER TABLE product_integration_mappings ADD COLUMN IF NOT EXISTS ean TEXT;
ALTER TABLE product_integration_mappings ADD COLUMN IF NOT EXISTS ncm TEXT;
ALTER TABLE product_integration_mappings ADD COLUMN IF NOT EXISTS price NUMERIC;
ALTER TABLE product_integration_mappings ADD COLUMN IF NOT EXISTS stock_control TEXT;
ALTER TABLE product_integration_mappings ADD COLUMN IF NOT EXISTS review_status TEXT NOT NULL DEFAULT 'PENDENTE_REVISAO';

CREATE UNIQUE INDEX IF NOT EXISTS idx_product_integration_external_unique
  ON product_integration_mappings(integration_id, external_product_id);

CREATE TABLE IF NOT EXISTS omie_stock_locations (
  id BIGSERIAL PRIMARY KEY,
  integration_id BIGINT REFERENCES integrations(id) ON DELETE CASCADE,
  omie_location_id TEXT NOT NULL,
  code TEXT,
  name TEXT NOT NULL,
  description TEXT,
  active BOOLEAN NOT NULL DEFAULT TRUE,
  company TEXT,
  raw_payload JSONB,
  synced_at TIMESTAMP,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE (integration_id, omie_location_id)
);

CREATE TABLE IF NOT EXISTS stock_reconciliation_items (
  id BIGSERIAL PRIMARY KEY,
  reconciliation_id BIGINT REFERENCES stock_reconciliations(id) ON DELETE CASCADE,
  integration_id BIGINT REFERENCES integrations(id) ON DELETE SET NULL,
  pdv_id INTEGER REFERENCES pdvs(id) ON DELETE SET NULL,
  sku_produto TEXT REFERENCES produtos(sku) ON DELETE SET NULL,
  omie_location_id TEXT,
  difference_type TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'PENDENTE',
  details JSONB DEFAULT '{}'::jsonb,
  reviewed_by TEXT,
  reviewed_at TIMESTAMP,
  note TEXT,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_omie_stock_locations_lookup ON omie_stock_locations(integration_id, active, name);
CREATE INDEX IF NOT EXISTS idx_stock_reconciliation_items_status ON stock_reconciliation_items(integration_id, status, difference_type);

CREATE TABLE IF NOT EXISTS integration_sync_state (
  id BIGSERIAL PRIMARY KEY,
  integration_id BIGINT REFERENCES integrations(id) ON DELETE CASCADE,
  scope TEXT NOT NULL,
  last_success_at TIMESTAMP,
  last_attempt_at TIMESTAMP,
  last_movement_id TEXT,
  last_page INTEGER DEFAULT 1,
  last_cursor TEXT,
  overlap_start_at TIMESTAMP,
  last_error TEXT,
  stats JSONB DEFAULT '{}'::jsonb,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE (integration_id, scope)
);

CREATE TABLE IF NOT EXISTS integration_runtime_state (
  integration_id BIGINT PRIMARY KEY REFERENCES integrations(id) ON DELETE CASCADE,
  circuit_state TEXT NOT NULL DEFAULT 'CLOSED',
  consecutive_failures INTEGER NOT NULL DEFAULT 0,
  opened_at TIMESTAMP,
  half_open_after TIMESTAMP,
  last_request_at TIMESTAMP,
  request_window_start TIMESTAMP,
  request_count INTEGER NOT NULL DEFAULT 0,
  max_concurrent_requests INTEGER NOT NULL DEFAULT 1,
  max_requests_per_second INTEGER NOT NULL DEFAULT 2,
  minimum_interval_ms INTEGER NOT NULL DEFAULT 500,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS integration_metrics (
  id BIGSERIAL PRIMARY KEY,
  integration_id BIGINT REFERENCES integrations(id) ON DELETE SET NULL,
  metric_name TEXT NOT NULL,
  metric_value NUMERIC NOT NULL DEFAULT 0,
  labels JSONB DEFAULT '{}'::jsonb,
  recorded_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS stock_refresh_queue (
  id BIGSERIAL PRIMARY KEY,
  integration_id BIGINT REFERENCES integrations(id) ON DELETE CASCADE,
  omie_product_id TEXT NOT NULL,
  omie_location_id TEXT NOT NULL,
  trigger TEXT,
  external_reference TEXT,
  status TEXT NOT NULL DEFAULT 'PENDENTE',
  available_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP + INTERVAL '1 second',
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE (integration_id, omie_product_id, omie_location_id, status)
);

CREATE TABLE IF NOT EXISTS product_sync_temperature (
  integration_id BIGINT REFERENCES integrations(id) ON DELETE CASCADE,
  external_product_id TEXT NOT NULL,
  sku_produto TEXT REFERENCES produtos(sku) ON DELETE SET NULL,
  temperature TEXT NOT NULL DEFAULT 'FRIO',
  reason TEXT,
  last_movement_at TIMESTAMP,
  last_classified_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (integration_id, external_product_id)
);

CREATE INDEX IF NOT EXISTS idx_integration_jobs_priority ON integration_jobs(status, priority_rank DESC, created_at);
CREATE INDEX IF NOT EXISTS idx_integration_sync_state_lookup ON integration_sync_state(integration_id, scope);
CREATE INDEX IF NOT EXISTS idx_integration_metrics_lookup ON integration_metrics(integration_id, metric_name, recorded_at DESC);
CREATE INDEX IF NOT EXISTS idx_stock_refresh_queue_ready ON stock_refresh_queue(status, available_at, integration_id);

-- Reversao manual, se necessario:
-- DROP TABLE IF EXISTS stock_reconciliation_items;
-- DROP TABLE IF EXISTS omie_stock_locations;
-- DROP INDEX IF EXISTS idx_product_integration_external_unique;
-- As colunas adicionadas podem permanecer sem afetar o modo manual.
