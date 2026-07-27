CREATE TABLE IF NOT EXISTS pdvs (
  id SERIAL PRIMARY KEY,
  nome TEXT UNIQUE NOT NULL,
  senha TEXT NOT NULL,
  is_cozinha BOOLEAN DEFAULT FALSE,
  categoria TEXT
);

CREATE TABLE IF NOT EXISTS produtos (
  sku TEXT PRIMARY KEY,
  nome TEXT NOT NULL,
  is_materia_prima BOOLEAN DEFAULT FALSE,
  estoque_central INTEGER DEFAULT 0,
  qtd_total INTEGER DEFAULT 0,
  estoque_minimo INTEGER DEFAULT 0,
  ativo BOOLEAN DEFAULT TRUE,
  categoria TEXT,
  origem TEXT DEFAULT 'manual'
);

ALTER TABLE pdvs ADD COLUMN IF NOT EXISTS categoria TEXT;
ALTER TABLE produtos ADD COLUMN IF NOT EXISTS categoria TEXT;
ALTER TABLE produtos ADD COLUMN IF NOT EXISTS origem TEXT DEFAULT 'manual';
UPDATE produtos SET origem = 'manual' WHERE origem IS NULL OR trim(origem) = '';

CREATE TABLE IF NOT EXISTS estoque_pdv (
  id SERIAL PRIMARY KEY,
  pdv_id INTEGER REFERENCES pdvs(id) ON DELETE CASCADE,
  sku_produto TEXT REFERENCES produtos(sku) ON DELETE CASCADE,
  quantidade INTEGER DEFAULT 0,
  saldo_omie NUMERIC DEFAULT 0,
  quantidade_reservada_acpark NUMERIC DEFAULT 0,
  saldo_disponivel_acpark NUMERIC GENERATED ALWAYS AS (COALESCE(saldo_omie, 0) - COALESCE(quantidade_reservada_acpark, 0)) STORED,
  ultima_sincronizacao TIMESTAMP,
  sincronizacao_status TEXT DEFAULT 'MANUAL',
  estoque_minimo INTEGER DEFAULT 0,
  estoque_maximo INTEGER DEFAULT 0,
  permitido BOOLEAN DEFAULT FALSE,
  UNIQUE(pdv_id, sku_produto)
);

ALTER TABLE estoque_pdv ADD COLUMN IF NOT EXISTS saldo_omie NUMERIC DEFAULT 0;
ALTER TABLE estoque_pdv ADD COLUMN IF NOT EXISTS quantidade_reservada_acpark NUMERIC DEFAULT 0;
ALTER TABLE estoque_pdv ADD COLUMN IF NOT EXISTS saldo_disponivel_acpark NUMERIC GENERATED ALWAYS AS (COALESCE(saldo_omie, 0) - COALESCE(quantidade_reservada_acpark, 0)) STORED;
ALTER TABLE estoque_pdv ADD COLUMN IF NOT EXISTS ultima_sincronizacao TIMESTAMP;
ALTER TABLE estoque_pdv ADD COLUMN IF NOT EXISTS sincronizacao_status TEXT DEFAULT 'MANUAL';

CREATE TABLE IF NOT EXISTS pdv_categorias (
  id SERIAL PRIMARY KEY,
  pdv_id INTEGER REFERENCES pdvs(id) ON DELETE CASCADE,
  categoria TEXT NOT NULL,
  UNIQUE(pdv_id, categoria)
);

CREATE TABLE IF NOT EXISTS categorias (
  id SERIAL PRIMARY KEY,
  nome TEXT UNIQUE NOT NULL
);

CREATE TABLE IF NOT EXISTS produto_categorias (
  id SERIAL PRIMARY KEY,
  sku_produto TEXT REFERENCES produtos(sku) ON DELETE CASCADE,
  categoria TEXT NOT NULL,
  UNIQUE(sku_produto, categoria)
);

INSERT INTO pdv_categorias (pdv_id, categoria)
SELECT id, categoria
FROM pdvs
WHERE categoria IS NOT NULL AND trim(categoria) <> ''
ON CONFLICT (pdv_id, categoria) DO NOTHING;

INSERT INTO categorias (nome)
SELECT DISTINCT categoria
FROM produtos
WHERE categoria IS NOT NULL AND trim(categoria) <> ''
ON CONFLICT (nome) DO NOTHING;

INSERT INTO produto_categorias (sku_produto, categoria)
SELECT sku, trim(upper(categoria))
FROM produtos
WHERE categoria IS NOT NULL AND trim(categoria) <> ''
ON CONFLICT (sku_produto, categoria) DO NOTHING;

INSERT INTO categorias (nome)
SELECT DISTINCT categoria
FROM pdv_categorias
WHERE categoria IS NOT NULL AND trim(categoria) <> ''
ON CONFLICT (nome) DO NOTHING;

CREATE TABLE IF NOT EXISTS pedidos (
  id SERIAL PRIMARY KEY,
  codigo_pedido TEXT,
  solicitante TEXT,
  pdv_id INTEGER REFERENCES pdvs(id),
  sku_produto TEXT REFERENCES produtos(sku),
  quantidade_solicitada INTEGER NOT NULL,
  quantidade_liberada INTEGER DEFAULT 0,
  status TEXT DEFAULT 'Pendente',
  observacao TEXT,
  data_hora TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  criado_em TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  em_andamento_em TIMESTAMP,
  liberado_em TIMESTAMP
);

CREATE TABLE IF NOT EXISTS pedido_idempotencia (
  id SERIAL PRIMARY KEY,
  idempotency_key TEXT UNIQUE NOT NULL,
  pdv_id INTEGER REFERENCES pdvs(id) ON DELETE CASCADE,
  codigo_pedido TEXT,
  status TEXT DEFAULT 'processing',
  criado_em TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  atualizado_em TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS pedido_rascunhos (
  pdv_id INTEGER PRIMARY KEY REFERENCES pdvs(id) ON DELETE CASCADE,
  solicitante TEXT,
  observacao TEXT,
  items JSONB NOT NULL DEFAULT '[]'::jsonb,
  atualizado_em TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

ALTER TABLE pedidos ADD COLUMN IF NOT EXISTS version INTEGER DEFAULT 1;
ALTER TABLE pedidos ADD COLUMN IF NOT EXISTS updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP;
ALTER TABLE pedidos ADD COLUMN IF NOT EXISTS pronto_retirada_em TIMESTAMP;
ALTER TABLE pedidos ADD COLUMN IF NOT EXISTS retirada_assinatura TEXT;
ALTER TABLE pedidos ADD COLUMN IF NOT EXISTS retirada_responsavel TEXT;
ALTER TABLE pedidos ADD COLUMN IF NOT EXISTS retirada_observacao TEXT;
ALTER TABLE pedidos ADD COLUMN IF NOT EXISTS retirada_em TIMESTAMP;
ALTER TABLE pedidos ADD COLUMN IF NOT EXISTS retirada_usuario_almoxarifado TEXT;
ALTER TABLE pedidos ADD COLUMN IF NOT EXISTS pedido_editado BOOLEAN DEFAULT FALSE;
ALTER TABLE pedidos ADD COLUMN IF NOT EXISTS pedido_editado_em TIMESTAMP;
ALTER TABLE pedidos ADD COLUMN IF NOT EXISTS pedido_editado_por TEXT;
ALTER TABLE pedidos ADD COLUMN IF NOT EXISTS pedido_reaberto_finalizado BOOLEAN DEFAULT FALSE;
ALTER TABLE pedidos ADD COLUMN IF NOT EXISTS release_mode TEXT;
ALTER TABLE pedidos ADD COLUMN IF NOT EXISTS item_origem TEXT DEFAULT 'PDV';
UPDATE pedidos SET item_origem = 'PDV' WHERE item_origem IS NULL OR trim(item_origem) = '';

UPDATE pedidos SET version = 1 WHERE version IS NULL;
UPDATE pedidos SET updated_at = COALESCE(updated_at, criado_em, data_hora, CURRENT_TIMESTAMP);
UPDATE pedidos SET status = 'Finalizado' WHERE status = 'Liberado';
UPDATE pedidos SET status = 'Liberação Parcial' WHERE status = 'Liberado Parcial';
UPDATE pedidos
SET status = 'Aguardando Retirada',
    updated_at = CURRENT_TIMESTAMP
WHERE status = 'Aguardando Retirada'
  AND COALESCE(quantidade_liberada, 0) >= COALESCE(quantidade_solicitada, 0);
UPDATE pedidos
SET status = 'Liberação Parcial',
    updated_at = CURRENT_TIMESTAMP
WHERE status = 'Aguardando Retirada'
  AND COALESCE(quantidade_liberada, 0) > 0
  AND COALESCE(quantidade_liberada, 0) < COALESCE(quantidade_solicitada, 0);
UPDATE pedidos
SET status = 'Finalizado',
    updated_at = CURRENT_TIMESTAMP
WHERE status = 'Liberação Parcial'
  AND COALESCE(quantidade_liberada, 0) > 0
  AND retirada_assinatura IS NOT NULL;
UPDATE pedidos
SET status = 'Aguardando Retirada',
    updated_at = CURRENT_TIMESTAMP
WHERE status = 'Liberação Parcial'
  AND COALESCE(quantidade_liberada, 0) > 0
  AND retirada_assinatura IS NULL;

CREATE TABLE IF NOT EXISTS configuracoes (
  chave TEXT PRIMARY KEY,
  valor TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS integrations (
  id BIGSERIAL PRIMARY KEY,
  nome TEXT NOT NULL,
  provedor TEXT NOT NULL,
  tipo TEXT NOT NULL,
  ambiente TEXT NOT NULL DEFAULT 'PRODUCAO',
  url_base TEXT,
  empresa_vinculada TEXT,
  ativo BOOLEAN NOT NULL DEFAULT TRUE,
  status TEXT NOT NULL DEFAULT 'PENDENTE',
  ultima_sincronizacao TIMESTAMP,
  last_error TEXT,
  last_connection_test_at TIMESTAMP,
  last_connection_duration_ms INTEGER,
  last_connection_message TEXT,
  stock_mode TEXT NOT NULL DEFAULT 'MANUAL',
  sync_intervals JSONB DEFAULT '{}'::jsonb,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  created_by TEXT,
  updated_by TEXT
);

ALTER TABLE integrations ADD COLUMN IF NOT EXISTS last_connection_test_at TIMESTAMP;
ALTER TABLE integrations ADD COLUMN IF NOT EXISTS last_connection_duration_ms INTEGER;
ALTER TABLE integrations ADD COLUMN IF NOT EXISTS last_connection_message TEXT;
ALTER TABLE integrations ADD COLUMN IF NOT EXISTS stock_mode TEXT NOT NULL DEFAULT 'MANUAL';

CREATE TABLE IF NOT EXISTS integration_credentials (
  id BIGSERIAL PRIMARY KEY,
  integration_id BIGINT NOT NULL REFERENCES integrations(id) ON DELETE CASCADE,
  credential_key TEXT NOT NULL,
  encrypted_value TEXT NOT NULL,
  masked_value TEXT,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE (integration_id, credential_key)
);

CREATE TABLE IF NOT EXISTS integration_jobs (
  id BIGSERIAL PRIMARY KEY,
  integration_id BIGINT REFERENCES integrations(id) ON DELETE SET NULL,
  job_type TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'PENDENTE',
  priority TEXT NOT NULL DEFAULT 'NORMAL',
  priority_rank INTEGER NOT NULL DEFAULT 50,
  payload JSONB DEFAULT '{}'::jsonb,
  result JSONB,
  attempts INTEGER NOT NULL DEFAULT 0,
  current_page INTEGER DEFAULT 1,
  cursor TEXT,
  date_from TIMESTAMP,
  date_to TIMESTAMP,
  last_external_id TEXT,
  last_processed_at TIMESTAMP,
  next_run_at TIMESTAMP,
  last_error TEXT,
  idempotency_key TEXT UNIQUE,
  locked_at TIMESTAMP,
  locked_by TEXT,
  completed_at TIMESTAMP,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
);

ALTER TABLE integration_jobs ADD COLUMN IF NOT EXISTS priority TEXT NOT NULL DEFAULT 'NORMAL';
ALTER TABLE integration_jobs ADD COLUMN IF NOT EXISTS priority_rank INTEGER NOT NULL DEFAULT 50;
ALTER TABLE integration_jobs ADD COLUMN IF NOT EXISTS current_page INTEGER DEFAULT 1;
ALTER TABLE integration_jobs ADD COLUMN IF NOT EXISTS cursor TEXT;
ALTER TABLE integration_jobs ADD COLUMN IF NOT EXISTS date_from TIMESTAMP;
ALTER TABLE integration_jobs ADD COLUMN IF NOT EXISTS date_to TIMESTAMP;
ALTER TABLE integration_jobs ADD COLUMN IF NOT EXISTS last_external_id TEXT;
ALTER TABLE integration_jobs ADD COLUMN IF NOT EXISTS last_processed_at TIMESTAMP;
ALTER TABLE integration_jobs ADD COLUMN IF NOT EXISTS locked_at TIMESTAMP;
ALTER TABLE integration_jobs ADD COLUMN IF NOT EXISTS locked_by TEXT;
ALTER TABLE integration_jobs ADD COLUMN IF NOT EXISTS completed_at TIMESTAMP;

CREATE TABLE IF NOT EXISTS integration_attempts (
  id BIGSERIAL PRIMARY KEY,
  job_id BIGINT REFERENCES integration_jobs(id) ON DELETE CASCADE,
  integration_id BIGINT REFERENCES integrations(id) ON DELETE SET NULL,
  status TEXT NOT NULL,
  error_message TEXT,
  response_summary JSONB,
  started_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  finished_at TIMESTAMP
);

CREATE TABLE IF NOT EXISTS integration_webhooks (
  id BIGSERIAL PRIMARY KEY,
  integration_id BIGINT REFERENCES integrations(id) ON DELETE SET NULL,
  provider TEXT NOT NULL,
  event_type TEXT,
  signature_valid BOOLEAN DEFAULT FALSE,
  raw_payload JSONB,
  headers JSONB,
  status TEXT NOT NULL DEFAULT 'RECEBIDO',
  processing_error TEXT,
  received_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  processed_at TIMESTAMP
);

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

CREATE TABLE IF NOT EXISTS product_integration_mappings (
  id BIGSERIAL PRIMARY KEY,
  integration_id BIGINT REFERENCES integrations(id) ON DELETE CASCADE,
  sku_produto TEXT REFERENCES produtos(sku) ON DELETE CASCADE,
  external_product_id TEXT NOT NULL,
  external_code TEXT,
  integration_code TEXT,
  product_type TEXT DEFAULT 'REVENDA',
  unit TEXT DEFAULT 'UN',
  family TEXT,
  ean TEXT,
  ncm TEXT,
  price NUMERIC,
  stock_control TEXT,
  review_status TEXT NOT NULL DEFAULT 'PENDENTE_REVISAO',
  raw_payload JSONB,
  active BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE (integration_id, sku_produto, external_product_id),
  UNIQUE (integration_id, external_product_id)
);

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

CREATE TABLE IF NOT EXISTS pdv_stock_location_mappings (
  id BIGSERIAL PRIMARY KEY,
  pdv_acpark_id INTEGER REFERENCES pdvs(id) ON DELETE CASCADE,
  integration_id BIGINT REFERENCES integrations(id) ON DELETE CASCADE,
  omie_location_id TEXT NOT NULL,
  omie_location_name TEXT,
  active BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE (pdv_acpark_id, integration_id, omie_location_id)
);

CREATE TABLE IF NOT EXISTS stock_movements (
  id BIGSERIAL PRIMARY KEY,
  omie_movement_id TEXT UNIQUE,
  operation_type TEXT NOT NULL,
  origin_system TEXT NOT NULL,
  external_reference TEXT,
  idempotency_key TEXT UNIQUE,
  pdv_id INTEGER REFERENCES pdvs(id) ON DELETE SET NULL,
  omie_location_id TEXT,
  status TEXT NOT NULL DEFAULT 'PENDENTE',
  movement_date TIMESTAMP,
  synced_at TIMESTAMP,
  error_message TEXT,
  raw_payload JSONB,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS stock_movement_items (
  id BIGSERIAL PRIMARY KEY,
  movement_id BIGINT REFERENCES stock_movements(id) ON DELETE CASCADE,
  sku_produto TEXT REFERENCES produtos(sku) ON DELETE SET NULL,
  quantity NUMERIC NOT NULL,
  unit TEXT DEFAULT 'UN',
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS stock_snapshots (
  id BIGSERIAL PRIMARY KEY,
  integration_id BIGINT REFERENCES integrations(id) ON DELETE SET NULL,
  pdv_id INTEGER REFERENCES pdvs(id) ON DELETE SET NULL,
  sku_produto TEXT REFERENCES produtos(sku) ON DELETE SET NULL,
  omie_location_id TEXT,
  saldo_omie NUMERIC NOT NULL DEFAULT 0,
  quantidade_reservada_acpark NUMERIC NOT NULL DEFAULT 0,
  saldo_disponivel_acpark NUMERIC NOT NULL DEFAULT 0,
  sync_status TEXT NOT NULL DEFAULT 'SINCRONIZADO',
  synced_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  raw_payload JSONB
);

CREATE TABLE IF NOT EXISTS stock_reconciliations (
  id BIGSERIAL PRIMARY KEY,
  integration_id BIGINT REFERENCES integrations(id) ON DELETE SET NULL,
  status TEXT NOT NULL DEFAULT 'PENDENTE',
  differences_count INTEGER NOT NULL DEFAULT 0,
  started_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  finished_at TIMESTAMP,
  summary JSONB,
  error_message TEXT
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

CREATE TABLE IF NOT EXISTS integration_audit_logs (
  id BIGSERIAL PRIMARY KEY,
  integration_id BIGINT REFERENCES integrations(id) ON DELETE SET NULL,
  action TEXT NOT NULL,
  actor TEXT,
  details JSONB DEFAULT '{}'::jsonb,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_pedidos_pdv_data ON pedidos(pdv_id, data_hora DESC);
CREATE INDEX IF NOT EXISTS idx_pedidos_status ON pedidos(status);
CREATE INDEX IF NOT EXISTS idx_produto_categorias_categoria ON produto_categorias(categoria);
CREATE INDEX IF NOT EXISTS idx_integrations_provider ON integrations(provedor, ativo);
CREATE INDEX IF NOT EXISTS idx_integration_jobs_status ON integration_jobs(status, next_run_at);
CREATE INDEX IF NOT EXISTS idx_integration_jobs_priority ON integration_jobs(status, priority_rank DESC, created_at);
CREATE INDEX IF NOT EXISTS idx_integration_sync_state_lookup ON integration_sync_state(integration_id, scope);
CREATE INDEX IF NOT EXISTS idx_integration_metrics_lookup ON integration_metrics(integration_id, metric_name, recorded_at DESC);
CREATE INDEX IF NOT EXISTS idx_stock_refresh_queue_ready ON stock_refresh_queue(status, available_at, integration_id);
CREATE INDEX IF NOT EXISTS idx_omie_stock_locations_lookup ON omie_stock_locations(integration_id, active, name);
CREATE INDEX IF NOT EXISTS idx_stock_movements_origin ON stock_movements(origin_system, operation_type, movement_date DESC);
CREATE INDEX IF NOT EXISTS idx_stock_snapshots_lookup ON stock_snapshots(pdv_id, sku_produto, synced_at DESC);
CREATE INDEX IF NOT EXISTS idx_stock_reconciliation_items_status ON stock_reconciliation_items(integration_id, status, difference_type);

CREATE TABLE IF NOT EXISTS devolucoes_avaria (
  id SERIAL PRIMARY KEY,
  codigo_devolucao TEXT UNIQUE NOT NULL,
  pdv_id INTEGER REFERENCES pdvs(id) ON DELETE SET NULL,
  sku_produto TEXT REFERENCES produtos(sku) ON DELETE SET NULL,
  quantidade INTEGER NOT NULL,
  unidade_medida TEXT DEFAULT 'UN',
  motivo TEXT NOT NULL,
  outro_motivo TEXT,
  data_identificacao DATE NOT NULL,
  lote TEXT,
  data_validade DATE,
  observacao TEXT,
  fotos TEXT,
  usuario_solicitante TEXT,
  status TEXT DEFAULT 'Pendente',
  quantidade_recebida INTEGER DEFAULT 0,
  quantidade_aprovada INTEGER DEFAULT 0,
  quantidade_recusada INTEGER DEFAULT 0,
  motivo_divergencia TEXT,
  observacao_interna TEXT,
  omie_status TEXT DEFAULT 'Integração desativada',
  omie_request_id TEXT,
  omie_response TEXT,
  omie_error TEXT,
  omie_attempts INTEGER DEFAULT 0,
  omie_quantidade_processada INTEGER DEFAULT 0,
  manual_quantidade_processada INTEGER DEFAULT 0,
  movimento_manual_status TEXT DEFAULT 'Pendente',
  criado_em TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  atualizado_em TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  recebido_em TIMESTAMP,
  finalizado_em TIMESTAMP,
  cancelado_em TIMESTAMP
);

ALTER TABLE devolucoes_avaria ADD COLUMN IF NOT EXISTS assinatura_imagem TEXT;
ALTER TABLE devolucoes_avaria ADD COLUMN IF NOT EXISTS assinatura_confirmada_em TIMESTAMP;
ALTER TABLE devolucoes_avaria ADD COLUMN IF NOT EXISTS responsavel_entrega_nome TEXT;
ALTER TABLE devolucoes_avaria ADD COLUMN IF NOT EXISTS responsavel_entrega_documento TEXT;
ALTER TABLE devolucoes_avaria ADD COLUMN IF NOT EXISTS responsavel_entrega_cargo TEXT;
ALTER TABLE devolucoes_avaria ADD COLUMN IF NOT EXISTS entrega_em TIMESTAMP;
ALTER TABLE devolucoes_avaria ADD COLUMN IF NOT EXISTS recebido_por_usuario TEXT;
ALTER TABLE devolucoes_avaria ADD COLUMN IF NOT EXISTS recebido_sessao TEXT;
ALTER TABLE devolucoes_avaria ADD COLUMN IF NOT EXISTS recebido_ip TEXT;
ALTER TABLE devolucoes_avaria ADD COLUMN IF NOT EXISTS verificado BOOLEAN DEFAULT FALSE;
ALTER TABLE devolucoes_avaria ADD COLUMN IF NOT EXISTS estornado_em TIMESTAMP;
ALTER TABLE devolucoes_avaria ADD COLUMN IF NOT EXISTS estornado_por TEXT;
ALTER TABLE devolucoes_avaria ADD COLUMN IF NOT EXISTS motivo_estorno TEXT;
ALTER TABLE devolucoes_avaria ALTER COLUMN status SET DEFAULT 'Enviar para o Almoxarifado';

CREATE TABLE IF NOT EXISTS devolucao_avaria_itens (
  id SERIAL PRIMARY KEY,
  devolucao_id INTEGER REFERENCES devolucoes_avaria(id) ON DELETE CASCADE,
  sku_produto TEXT REFERENCES produtos(sku) ON DELETE SET NULL,
  quantidade INTEGER NOT NULL DEFAULT 0,
  unidade_medida TEXT DEFAULT 'UN',
  motivo TEXT NOT NULL,
  outro_motivo TEXT,
  data_identificacao DATE,
  lote TEXT,
  data_validade DATE,
  observacao TEXT,
  fotos TEXT,
  status_item TEXT DEFAULT 'Enviar para o Almoxarifado',
  quantidade_recebida INTEGER DEFAULT 0,
  quantidade_aprovada INTEGER DEFAULT 0,
  quantidade_recusada INTEGER DEFAULT 0,
  motivo_divergencia TEXT,
  observacao_interna TEXT,
  retirada_responsavel TEXT,
  retirada_assinatura TEXT,
  retirada_em TIMESTAMP,
  retirada_usuario_almoxarifado TEXT,
  retirada_confirmada BOOLEAN DEFAULT FALSE,
  omie_quantidade_processada INTEGER DEFAULT 0,
  manual_quantidade_processada INTEGER DEFAULT 0,
  movimento_manual_status TEXT DEFAULT 'Pendente',
  criado_em TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  atualizado_em TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

ALTER TABLE devolucao_avaria_itens ADD COLUMN IF NOT EXISTS retirada_assinatura TEXT;
ALTER TABLE devolucoes_avaria ADD COLUMN IF NOT EXISTS manual_quantidade_processada INTEGER DEFAULT 0;
ALTER TABLE devolucoes_avaria ADD COLUMN IF NOT EXISTS movimento_manual_status TEXT DEFAULT 'Pendente';
ALTER TABLE devolucao_avaria_itens ADD COLUMN IF NOT EXISTS manual_quantidade_processada INTEGER DEFAULT 0;
ALTER TABLE devolucao_avaria_itens ADD COLUMN IF NOT EXISTS movimento_manual_status TEXT DEFAULT 'Pendente';

CREATE TABLE IF NOT EXISTS devolucao_avaria_fotos (
  id BIGSERIAL PRIMARY KEY,
  devolucao_id INTEGER REFERENCES devolucoes_avaria(id) ON DELETE CASCADE,
  item_id INTEGER REFERENCES devolucao_avaria_itens(id) ON DELETE CASCADE,
  draft_id VARCHAR(120),
  owner_role VARCHAR(40),
  owner_name VARCHAR(120),
  owner_pdv_id INTEGER REFERENCES pdvs(id) ON DELETE SET NULL,
  storage_key VARCHAR(500) NOT NULL,
  original_name VARCHAR(255),
  mime_type VARCHAR(100) NOT NULL,
  size_bytes BIGINT NOT NULL,
  width INTEGER,
  height INTEGER,
  sha256 VARCHAR(64),
  thumbnail_key VARCHAR(500),
  uploaded_by VARCHAR(120),
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  linked_at TIMESTAMP,
  expires_at TIMESTAMP,
  deleted_at TIMESTAMP,
  UNIQUE (item_id, sha256)
);

INSERT INTO devolucao_avaria_itens
  (devolucao_id, sku_produto, quantidade, unidade_medida, motivo, outro_motivo, data_identificacao,
   lote, data_validade, observacao, fotos, status_item, quantidade_recebida, quantidade_aprovada,
   quantidade_recusada, motivo_divergencia, observacao_interna, omie_quantidade_processada)
SELECT d.id, d.sku_produto, d.quantidade, d.unidade_medida, d.motivo, d.outro_motivo, d.data_identificacao,
       d.lote, d.data_validade, d.observacao, d.fotos,
       CASE
         WHEN d.status IN ('Finalizada', 'Finalizado') THEN 'Finalizado'
         WHEN d.status IN ('Recusada', 'Recusado') THEN 'Aguardando retirada pelo ponto'
         WHEN d.status = 'Aprovada' THEN 'Aprovado'
         WHEN d.status IN ('AprovaÃ§Ã£o Parcial', 'Aprovada parcialmente') THEN 'Parcial'
         ELSE d.status
       END,
       d.quantidade_recebida, d.quantidade_aprovada, d.quantidade_recusada,
       d.motivo_divergencia, d.observacao_interna, d.omie_quantidade_processada
FROM devolucoes_avaria d
WHERE d.sku_produto IS NOT NULL
  AND NOT EXISTS (SELECT 1 FROM devolucao_avaria_itens i WHERE i.devolucao_id = d.id);

ALTER TABLE devolucoes_avaria ALTER COLUMN status SET DEFAULT 'Aguardando Entrega Física';

UPDATE devolucoes_avaria
SET status = CASE
  WHEN status IN ('Pendente', 'Enviada ao almoxarifado', 'Aguardando recebimento físico', 'Aguardando entrega física') THEN 'Aguardando Entrega Física'
  WHEN status IN ('Em recebimento', 'Recebida e assinada', 'Em conferência', 'Recebida') THEN 'Em Aprovação'
  WHEN status = 'Aprovada parcialmente' THEN 'Aprovação Parcial'
  WHEN status = 'Aguardando integração com o OMIE' THEN 'Aprovada'
  ELSE status
END
WHERE status IN ('Pendente', 'Enviada ao almoxarifado', 'Aguardando recebimento físico', 'Aguardando entrega física',
                 'Em recebimento', 'Recebida e assinada', 'Em conferência', 'Recebida',
                 'Aprovada parcialmente', 'Aguardando integração com o OMIE');

UPDATE devolucoes_avaria
SET status = CASE
  WHEN status IN ('Pendente', 'Enviada ao almoxarifado', 'Aguardando recebimento fÃ­sico', 'Aguardando entrega fÃ­sica', 'Aguardando Entrega FÃ­sica') THEN 'Enviar para o Almoxarifado'
  WHEN status IN ('Em recebimento', 'Recebida e assinada', 'Em conferÃªncia', 'Recebida', 'Em AprovaÃ§Ã£o') THEN 'Em Aprovação'
  WHEN status IN ('Recusada') THEN 'Recusado'
  WHEN status IN ('Finalizada') THEN 'Finalizado'
  ELSE status
END
WHERE status IN ('Pendente', 'Enviada ao almoxarifado', 'Aguardando recebimento fÃ­sico', 'Aguardando entrega fÃ­sica',
                 'Aguardando Entrega FÃ­sica', 'Em recebimento', 'Recebida e assinada', 'Em conferÃªncia',
                 'Recebida', 'Em AprovaÃ§Ã£o', 'Recusada', 'Finalizada');

ALTER TABLE devolucoes_avaria ALTER COLUMN status SET DEFAULT 'Enviar para o Almoxarifado';

UPDATE devolucoes_avaria
SET status = CASE
  WHEN status IN ('Pendente', 'Enviada ao almoxarifado', 'Aguardando recebimento físico', 'Aguardando entrega física', 'Aguardando Entrega Física',
                  'Aguardando recebimento fÃ­sico', 'Aguardando entrega fÃ­sica', 'Aguardando Entrega FÃ­sica') THEN 'Enviar para o Almoxarifado'
  WHEN status IN ('Em recebimento', 'Recebida e assinada', 'Em conferência', 'Em conferÃªncia', 'Recebida',
                  'Aprovada',
                  'Aguardando integração com o OMIE', 'Aguardando integraÃ§Ã£o com o OMIE') THEN 'Em Aprovação'
  WHEN status IN ('Aprovação Parcial', 'AprovaÃ§Ã£o Parcial', 'Aprovada parcialmente') THEN 'Aprovação Parcial'
  WHEN status IN ('Recusada') THEN 'Recusado'
  WHEN status IN ('Finalizada') THEN 'Finalizado'
  WHEN status IN ('VerificaÃ§Ã£o') THEN 'Verificação'
  ELSE status
END
WHERE status NOT IN ('Enviar para o Almoxarifado', 'Em Aprovação', 'Aprovação Parcial', 'Finalizado', 'Recusado', 'Verificação')
   OR status IN ('Aprovada', 'Aprovação Parcial', 'AprovaÃ§Ã£o Parcial', 'Aprovada parcialmente', 'Finalizada', 'Recusada', 'VerificaÃ§Ã£o');

CREATE TABLE IF NOT EXISTS estoque_avarias (
  id SERIAL PRIMARY KEY,
  devolucao_id INTEGER REFERENCES devolucoes_avaria(id) ON DELETE CASCADE,
  pdv_id INTEGER REFERENCES pdvs(id) ON DELETE SET NULL,
  sku_produto TEXT REFERENCES produtos(sku) ON DELETE SET NULL,
  quantidade INTEGER DEFAULT 0,
  status TEXT DEFAULT 'Em análise',
  criado_em TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  atualizado_em TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(devolucao_id, sku_produto)
);

UPDATE estoque_avarias
SET status = 'Finalizado'
WHERE status = 'Finalizada';

CREATE TABLE IF NOT EXISTS devolucao_avaria_historico (
  id SERIAL PRIMARY KEY,
  devolucao_id INTEGER REFERENCES devolucoes_avaria(id) ON DELETE CASCADE,
  usuario TEXT,
  acao TEXT NOT NULL,
  status_anterior TEXT,
  novo_status TEXT,
  quantidade INTEGER DEFAULT 0,
  observacao TEXT,
  origem TEXT,
  criado_em TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS devolucao_idempotencia (
  id SERIAL PRIMARY KEY,
  idempotency_key TEXT NOT NULL,
  operation_type TEXT NOT NULL,
  user_role TEXT NOT NULL,
  user_name TEXT NOT NULL,
  pdv_id INTEGER REFERENCES pdvs(id) ON DELETE SET NULL,
  devolucao_id INTEGER REFERENCES devolucoes_avaria(id) ON DELETE SET NULL,
  request_hash TEXT NOT NULL,
  response_status INTEGER,
  response_body JSONB,
  processing_status TEXT NOT NULL DEFAULT 'PROCESSING',
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  completed_at TIMESTAMP,
  UNIQUE (idempotency_key, operation_type, user_role, user_name)
);

CREATE TABLE IF NOT EXISTS omie_jobs (
  id BIGSERIAL PRIMARY KEY,
  operation_key VARCHAR(180) NOT NULL UNIQUE,
  entity_type VARCHAR(50) NOT NULL,
  entity_id BIGINT NOT NULL,
  pdv_id INTEGER REFERENCES pdvs(id) ON DELETE SET NULL,
  product_sku TEXT REFERENCES produtos(sku) ON DELETE SET NULL,
  movement_type VARCHAR(80) NOT NULL,
  quantity NUMERIC NOT NULL,
  payload JSONB,
  status VARCHAR(30) NOT NULL DEFAULT 'PENDING',
  attempts INTEGER NOT NULL DEFAULT 0,
  external_id VARCHAR(150),
  last_error TEXT,
  response_summary JSONB,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  processing_started_at TIMESTAMP,
  completed_at TIMESTAMP,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
);

UPDATE devolucoes_avaria
SET omie_status = 'Integração desativada',
    omie_error = COALESCE(omie_error, 'Integração OMIE desativada nesta etapa. Revisar quando a integração externa for retomada.')
WHERE omie_status = 'Integrado com sucesso'
  AND (
    omie_request_id IS NULL
    OR omie_request_id = ''
    OR omie_response IS NULL
    OR omie_response NOT LIKE '%external%'
  );

CREATE INDEX IF NOT EXISTS idx_devolucoes_avaria_status ON devolucoes_avaria(status, criado_em DESC);
CREATE INDEX IF NOT EXISTS idx_devolucoes_avaria_pdv ON devolucoes_avaria(pdv_id, criado_em DESC);
CREATE INDEX IF NOT EXISTS idx_devolucoes_avaria_produto ON devolucoes_avaria(sku_produto);
CREATE INDEX IF NOT EXISTS idx_devolucoes_avaria_omie ON devolucoes_avaria(omie_status);
CREATE INDEX IF NOT EXISTS idx_devolucao_avaria_itens_devolucao ON devolucao_avaria_itens(devolucao_id);
CREATE INDEX IF NOT EXISTS idx_devolucao_avaria_itens_sku ON devolucao_avaria_itens(sku_produto);
CREATE INDEX IF NOT EXISTS idx_devolucao_avaria_itens_status ON devolucao_avaria_itens(status_item);
CREATE INDEX IF NOT EXISTS idx_devolucao_avaria_fotos_item ON devolucao_avaria_fotos(item_id);
CREATE INDEX IF NOT EXISTS idx_devolucao_avaria_fotos_devolucao ON devolucao_avaria_fotos(devolucao_id);
CREATE INDEX IF NOT EXISTS idx_devolucao_avaria_fotos_draft ON devolucao_avaria_fotos(draft_id, owner_pdv_id);
CREATE INDEX IF NOT EXISTS idx_devolucao_avaria_fotos_hash ON devolucao_avaria_fotos(sha256);
CREATE INDEX IF NOT EXISTS idx_estoque_avarias_devolucao ON estoque_avarias(devolucao_id);
CREATE INDEX IF NOT EXISTS idx_devolucao_avaria_historico_devolucao ON devolucao_avaria_historico(devolucao_id, criado_em DESC);
CREATE INDEX IF NOT EXISTS idx_devolucao_idempotencia_devolucao ON devolucao_idempotencia(devolucao_id, operation_type);
CREATE INDEX IF NOT EXISTS idx_omie_jobs_status ON omie_jobs(status, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_omie_jobs_entity ON omie_jobs(entity_type, entity_id);
CREATE INDEX IF NOT EXISTS idx_omie_jobs_product ON omie_jobs(product_sku);

CREATE TABLE IF NOT EXISTS user_order_alert_preferences (
  id BIGSERIAL PRIMARY KEY,
  user_key TEXT NOT NULL UNIQUE,
  enabled BOOLEAN NOT NULL DEFAULT TRUE,
  sound_id VARCHAR(100) NOT NULL DEFAULT 'repetitive-alert',
  volume INTEGER NOT NULL DEFAULT 70,
  visual_notifications BOOLEAN NOT NULL DEFAULT TRUE,
  repeat_mode VARCHAR(40) NOT NULL DEFAULT 'three_times',
  repeat_interval_seconds INTEGER NOT NULL DEFAULT 5,
  stop_on_view BOOLEAN NOT NULL DEFAULT TRUE,
  stop_on_service_start BOOLEAN NOT NULL DEFAULT TRUE,
  updated_at TIMESTAMP NOT NULL DEFAULT NOW()
);

ALTER TABLE user_order_alert_preferences ADD COLUMN IF NOT EXISTS repeat_mode VARCHAR(40) NOT NULL DEFAULT 'three_times';
ALTER TABLE user_order_alert_preferences ADD COLUMN IF NOT EXISTS repeat_interval_seconds INTEGER NOT NULL DEFAULT 5;
ALTER TABLE user_order_alert_preferences ADD COLUMN IF NOT EXISTS stop_on_view BOOLEAN NOT NULL DEFAULT TRUE;
ALTER TABLE user_order_alert_preferences ADD COLUMN IF NOT EXISTS stop_on_service_start BOOLEAN NOT NULL DEFAULT TRUE;

CREATE TABLE IF NOT EXISTS order_alert_sounds (
  id BIGSERIAL PRIMARY KEY,
  sound_key VARCHAR(100) NOT NULL UNIQUE,
  display_name VARCHAR(150) NOT NULL,
  storage_path VARCHAR(500),
  mime_type VARCHAR(100),
  size_bytes BIGINT DEFAULT 0,
  duration_seconds NUMERIC,
  is_system BOOLEAN NOT NULL DEFAULT FALSE,
  is_active BOOLEAN NOT NULL DEFAULT TRUE,
  created_by TEXT,
  created_at TIMESTAMP NOT NULL DEFAULT NOW()
);

INSERT INTO order_alert_sounds (sound_key, display_name, is_system, is_active)
VALUES
  ('default', 'Alerta padrão', TRUE, TRUE),
  ('bell', 'Campainha curta', TRUE, TRUE),
  ('soft', 'Toque suave', TRUE, TRUE),
  ('chime', 'Chime', TRUE, TRUE),
  ('double', 'Toque duplo', TRUE, TRUE),
  ('repetitive-alert', 'Alerta repetitivo', TRUE, TRUE),
  ('repetitive-bell', 'Campainha repetitiva', TRUE, TRUE),
  ('urgent', 'Chamada urgente', TRUE, TRUE),
  ('waiting', 'Pedido aguardando', TRUE, TRUE),
  ('soft-continuous', 'Alerta contínuo suave', TRUE, TRUE)
ON CONFLICT (sound_key) DO UPDATE
SET display_name = EXCLUDED.display_name,
    is_system = TRUE,
    is_active = TRUE;
