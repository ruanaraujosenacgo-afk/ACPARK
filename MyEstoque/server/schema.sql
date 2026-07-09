CREATE TABLE IF NOT EXISTS pdvs (
  id SERIAL PRIMARY KEY,
  nome TEXT UNIQUE NOT NULL,
  senha TEXT NOT NULL,
  is_cozinha BOOLEAN DEFAULT FALSE,
  codigo_orion TEXT UNIQUE,
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
  estoque_minimo INTEGER DEFAULT 0,
  estoque_maximo INTEGER DEFAULT 0,
  permitido BOOLEAN DEFAULT FALSE,
  UNIQUE(pdv_id, sku_produto)
);

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

CREATE TABLE IF NOT EXISTS vendas_orion (
  id SERIAL PRIMARY KEY,
  pdv_id INTEGER REFERENCES pdvs(id),
  sku_produto TEXT REFERENCES produtos(sku),
  quantidade_vendida INTEGER NOT NULL,
  data_venda TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  processado BOOLEAN DEFAULT FALSE,
  tipo_operacao TEXT DEFAULT 'VENDA'
);

CREATE TABLE IF NOT EXISTS configuracoes (
  chave TEXT PRIMARY KEY,
  valor TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_pedidos_pdv_data ON pedidos(pdv_id, data_hora DESC);
CREATE INDEX IF NOT EXISTS idx_pedidos_status ON pedidos(status);
CREATE INDEX IF NOT EXISTS idx_vendas_orion_processado ON vendas_orion(processado);
