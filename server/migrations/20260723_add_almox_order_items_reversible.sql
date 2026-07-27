-- Adds origin tracking for products inserted into an existing PDV order by the almoxarifado.
ALTER TABLE pedidos ADD COLUMN IF NOT EXISTS item_origem TEXT DEFAULT 'PDV';
UPDATE pedidos SET item_origem = 'PDV' WHERE item_origem IS NULL OR trim(item_origem) = '';

-- Rollback, if needed:
-- ALTER TABLE pedidos DROP COLUMN IF EXISTS item_origem;
