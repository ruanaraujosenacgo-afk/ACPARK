import { query, tx, asInt, code } from "../../db.js";
import { normalizeText, readBody, send } from "../../utils/http.js";
import { publishOrderAlert } from "../../services/order-alerts/order-alerts.events.js";
import { normalizeOrderStatus, orderStatuses } from "./pedidos.service.js";

let pedidoEditColumnsReady = null;
let pedidoIdempotencyReady = null;
let pedidoDraftReady = null;

function ensurePedidoIdempotencyTable() {
  pedidoIdempotencyReady ||= tx(async (client) => {
    await client.query(`
      CREATE TABLE IF NOT EXISTS pedido_idempotencia (
        id SERIAL PRIMARY KEY,
        idempotency_key TEXT UNIQUE NOT NULL,
        pdv_id INTEGER REFERENCES pdvs(id) ON DELETE CASCADE,
        codigo_pedido TEXT,
        status TEXT DEFAULT 'processing',
        criado_em TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        atualizado_em TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);
  });
  return pedidoIdempotencyReady;
}

function ensurePedidoDraftTable() {
  pedidoDraftReady ||= tx(async (client) => {
    await client.query(`
      CREATE TABLE IF NOT EXISTS pedido_rascunhos (
        pdv_id INTEGER PRIMARY KEY REFERENCES pdvs(id) ON DELETE CASCADE,
        solicitante TEXT,
        observacao TEXT,
        items JSONB NOT NULL DEFAULT '[]'::jsonb,
        atualizado_em TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);
  });
  return pedidoDraftReady;
}

function ensurePedidoEditColumns() {
  pedidoEditColumnsReady ||= tx(async (client) => {
    await client.query("ALTER TABLE pedidos ADD COLUMN IF NOT EXISTS pedido_editado BOOLEAN DEFAULT FALSE");
    await client.query("ALTER TABLE pedidos ADD COLUMN IF NOT EXISTS pedido_editado_em TIMESTAMP");
    await client.query("ALTER TABLE pedidos ADD COLUMN IF NOT EXISTS pedido_editado_por TEXT");
    await client.query("ALTER TABLE pedidos ADD COLUMN IF NOT EXISTS pedido_reaberto_finalizado BOOLEAN DEFAULT FALSE");
    await client.query("ALTER TABLE pedidos ADD COLUMN IF NOT EXISTS release_mode TEXT");
    await client.query("ALTER TABLE pedidos ADD COLUMN IF NOT EXISTS item_origem TEXT DEFAULT 'PDV'");
    await client.query("UPDATE pedidos SET item_origem = 'PDV' WHERE item_origem IS NULL OR trim(item_origem) = ''");
  });
  return pedidoEditColumnsReady;
}

async function ensurePartialReleaseRemainders() {
  await ensurePedidoEditColumns();
  await tx(async (client) => {
    const duplicateRemainders = await client.query(
      `SELECT id, codigo_pedido, sku_produto, quantidade_solicitada
       FROM pedidos
       WHERE status IN ('Liberação Parcial', 'Liberado Parcial')
         AND COALESCE(quantidade_liberada, 0) <= 0
       ORDER BY codigo_pedido, sku_produto, id
       FOR UPDATE`
    );
    const remainderGroups = new Map();
    for (const row of duplicateRemainders.rows) {
      const key = `${row.codigo_pedido}::${row.sku_produto}`;
      const group = remainderGroups.get(key) || { keepId: row.id, keepQty: 0, ids: [] };
      group.keepId = Math.min(group.keepId, row.id);
      group.keepQty = Math.max(group.keepQty, asInt(row.quantidade_solicitada));
      group.ids.push(row.id);
      remainderGroups.set(key, group);
    }
    for (const group of remainderGroups.values()) {
      if (group.ids.length <= 1) continue;
      await client.query(
        `UPDATE pedidos
         SET quantidade_solicitada = $2,
             pedido_editado = TRUE,
             pedido_editado_em = CURRENT_TIMESTAMP,
             pedido_editado_por = 'Correção automática',
             version = COALESCE(version, 1) + 1,
             updated_at = CURRENT_TIMESTAMP
         WHERE id = $1`,
        [group.keepId, group.keepQty]
      );
      const ids = group.ids.filter((id) => id !== group.keepId);
      if (ids.length) {
        await client.query("DELETE FROM pedidos WHERE id = ANY($1::int[])", [ids]);
      }
    }

    const rows = await client.query(
      `SELECT id, codigo_pedido, solicitante, pdv_id, sku_produto, quantidade_solicitada,
              quantidade_liberada, observacao, release_mode
       FROM pedidos
       WHERE status = 'Aguardando Retirada'
         AND COALESCE(release_mode, '') <> 'entered-only'
         AND COALESCE(quantidade_liberada, 0) > 0
         AND COALESCE(quantidade_liberada, 0) < quantidade_solicitada
       ORDER BY id
       FOR UPDATE`
    );
    for (const row of rows.rows) {
      const releasedQty = asInt(row.quantidade_liberada);
      const existingRemainder = await client.query(
        `SELECT COALESCE(SUM(quantidade_solicitada), 0) AS total
         FROM pedidos
         WHERE codigo_pedido = $1
           AND sku_produto = $2
           AND status IN ('Liberação Parcial', 'Liberado Parcial')
           AND COALESCE(quantidade_liberada, 0) <= 0
           AND id <> $3`,
        [row.codigo_pedido, row.sku_produto, row.id]
      );
      const existingMissingQty = asInt(existingRemainder.rows[0]?.total);
      if (existingMissingQty > 0) {
        const expectedRequestedQty = Math.max(asInt(row.quantidade_solicitada), releasedQty + existingMissingQty);
        if (expectedRequestedQty !== asInt(row.quantidade_solicitada)) {
          await client.query(
            `UPDATE pedidos
             SET quantidade_solicitada = $2,
                 pedido_editado = TRUE,
                 pedido_editado_em = CURRENT_TIMESTAMP,
                 pedido_editado_por = 'Correção automática',
                 version = COALESCE(version, 1) + 1,
                 updated_at = CURRENT_TIMESTAMP
             WHERE id = $1`,
            [row.id, expectedRequestedQty]
          );
        }
        continue;
      }
      const missingQty = Math.max(asInt(row.quantidade_solicitada) - releasedQty, 0);
      if (missingQty <= 0) continue;
      await client.query(
        `INSERT INTO pedidos
           (codigo_pedido, solicitante, pdv_id, sku_produto, quantidade_solicitada, quantidade_liberada,
            status, observacao, criado_em, data_hora, liberado_em, pronto_retirada_em,
            pedido_editado, pedido_editado_em, pedido_editado_por, version, updated_at)
         VALUES ($1, $2, $3, $4, $5, 0, 'Liberação Parcial', $6,
                 CURRENT_TIMESTAMP, CURRENT_TIMESTAMP, NULL, NULL,
                 TRUE, CURRENT_TIMESTAMP, 'Correção automática', 1, CURRENT_TIMESTAMP)`,
        [
          row.codigo_pedido,
          row.solicitante,
          row.pdv_id,
          row.sku_produto,
          missingQty,
          row.observacao
        ]
      );
      await client.query(
        `UPDATE pedidos
         SET pedido_editado = TRUE,
             pedido_editado_em = CURRENT_TIMESTAMP,
             pedido_editado_por = 'Correção automática',
             version = COALESCE(version, 1) + 1,
             updated_at = CURRENT_TIMESTAMP
         WHERE id = $1`,
        [row.id]
      );
    }
  });
}

function normalizeIdempotencyKey(req, body) {
  const header = req.headers?.["idempotency-key"] || req.headers?.["Idempotency-Key"];
  return normalizeText(header || body.idempotencyKey || body.idempotency_key, 120);
}

export async function handlePedidosRoutes(req, res, context) {
  const { method, requireUser, url, user } = context;

  if (url.pathname === "/api/pdv/order-draft") {
    if (user.role !== "pdv") return send(res, 403, { error: "Entre como PDV para gerenciar rascunhos." }), true;
    await ensurePedidoDraftTable();

    if (method === "GET") {
      const rows = await query(
        `SELECT solicitante, observacao, items, atualizado_em
         FROM pedido_rascunhos
         WHERE pdv_id = $1`,
        [user.pdvId]
      );
      const draft = rows[0]
        ? {
            solicitante: rows[0].solicitante || "",
            observacao: rows[0].observacao || "",
            items: Array.isArray(rows[0].items) ? rows[0].items : [],
            atualizado_em: rows[0].atualizado_em
          }
        : null;
      return send(res, 200, { draft }), true;
    }

    if (method === "POST") {
      const body = await readBody(req);
      const solicitante = normalizeText(body.solicitante, 80).toUpperCase();
      const observacao = normalizeText(body.observacao, 500);
      const rawItems = Array.isArray(body.items) ? body.items : [];
      const items = rawItems.map((item) => ({
        sku: normalizeText(item.sku, 60),
        nome: normalizeText(item.nome, 180),
        quantidade: asInt(item.quantidade)
      })).filter((item) => item.sku && item.quantidade > 0);
      if (!items.length) return send(res, 400, { error: "Adicione ao menos um produto para salvar o rascunho." }), true;

      await tx(async (client) => {
        await client.query(
          `INSERT INTO pedido_rascunhos (pdv_id, solicitante, observacao, items, atualizado_em)
           VALUES ($1, $2, $3, $4::jsonb, CURRENT_TIMESTAMP)
           ON CONFLICT (pdv_id) DO UPDATE
           SET solicitante = EXCLUDED.solicitante,
               observacao = EXCLUDED.observacao,
               items = EXCLUDED.items,
               atualizado_em = CURRENT_TIMESTAMP`,
          [user.pdvId, solicitante, observacao, JSON.stringify(items)]
        );
      });
      return send(res, 200, { ok: true, total: items.length }), true;
    }

    if (method === "DELETE") {
      await query("DELETE FROM pedido_rascunhos WHERE pdv_id = $1", [user.pdvId]);
      return send(res, 200, { ok: true }), true;
    }
  }

  if (url.pathname === "/api/pdv/order" && method === "POST") {
    if (user.role !== "pdv") return send(res, 403, { error: "Entre como PDV para solicitar produtos." }), true;
    const body = await readBody(req);
    const idempotencyKey = normalizeIdempotencyKey(req, body);
    const solicitante = normalizeText(body.solicitante, 80).toUpperCase();
    const observacao = normalizeText(body.observacao, 500);
    const items = Array.isArray(body.items) ? body.items : [];
    if (!idempotencyKey) return send(res, 400, { error: "Identificador da operação ausente. Atualize a página e tente novamente." }), true;
    if (!solicitante || !items.length) return send(res, 400, { error: "Informe solicitante e ao menos um item." }), true;
    await ensurePedidoIdempotencyTable();

    const result = await tx(async (client) => {
      const insertedKey = await client.query(
        `INSERT INTO pedido_idempotencia (idempotency_key, pdv_id, status)
         VALUES ($1, $2, 'processing')
         ON CONFLICT (idempotency_key) DO NOTHING
         RETURNING id`,
        [idempotencyKey, user.pdvId]
      );
      if (!insertedKey.rowCount) {
        const existing = await client.query(
          `SELECT codigo_pedido, status
           FROM pedido_idempotencia
           WHERE idempotency_key = $1 AND pdv_id = $2
           FOR UPDATE`,
          [idempotencyKey, user.pdvId]
        );
        if (existing.rows[0]?.codigo_pedido) {
          return { codigo: existing.rows[0].codigo_pedido, repeated: true };
        }
        const error = new Error("Esta solicitação já está em processamento. Aguarde a confirmação.");
        error.statusCode = 409;
        throw error;
      }

      const orderCode = code("PED");
      for (const item of items) {
        const sku = normalizeText(item.sku, 60);
        const qty = asInt(item.quantidade);
        if (!sku || qty <= 0) throw new Error("Item inválido.");

        const allowed = await client.query(
          `SELECT e.quantidade, e.estoque_maximo
           FROM estoque_pdv e
           JOIN produtos p ON p.sku = e.sku_produto
           JOIN produto_categorias prc ON prc.sku_produto = p.sku
           JOIN pdv_categorias pc ON pc.pdv_id = e.pdv_id AND pc.categoria = prc.categoria
           WHERE e.pdv_id = $1 AND e.sku_produto = $2 AND e.permitido = TRUE`,
          [user.pdvId, sku]
        );
        if (!allowed.rows[0]) throw new Error("Produto não liberado para este PDV.");
        const max = asInt(allowed.rows[0].estoque_maximo);
        const current = asInt(allowed.rows[0].quantidade);
        if (max > 0 && current + qty > max) throw new Error(`Pedido acima do estoque maximo para ${sku}.`);

        await client.query(
          `INSERT INTO pedidos
            (codigo_pedido, solicitante, sku_produto, pdv_id, quantidade_solicitada, observacao)
           VALUES ($1, $2, $3, $4, $5, $6)`,
          [orderCode, solicitante, sku, user.pdvId, qty, observacao]
        );
      }
      await client.query(
        `UPDATE pedido_idempotencia
         SET codigo_pedido = $2, status = 'completed', atualizado_em = CURRENT_TIMESTAMP
         WHERE idempotency_key = $1 AND pdv_id = $3`,
        [idempotencyKey, orderCode, user.pdvId]
      );
      await client.query("DELETE FROM pedido_rascunhos WHERE pdv_id = $1", [user.pdvId]);
      const pdvRows = await client.query("SELECT nome FROM pdvs WHERE id = $1", [user.pdvId]);
      return {
        codigo: orderCode,
        repeated: false,
        alert: {
          orderId: orderCode,
          orderNumber: orderCode,
          pointId: user.pdvId,
          pointName: pdvRows.rows[0]?.nome || user.name || "PDV",
          itemCount: items.length,
          createdAt: new Date().toISOString(),
          origin: "PDV"
        }
      };
    });
    if (!result.repeated && result.alert) {
      publishOrderAlert("NEW_PENDING_ORDER", result.alert);
    }
    send(res, result.repeated ? 200 : 201, { ok: true, codigo: result.codigo, repeated: result.repeated });
    return true;
  }

  if (url.pathname === "/api/pdv/orders") {
    await ensurePedidoEditColumns();
    const pdvId = user.role === "pdv" ? user.pdvId : asInt(url.searchParams.get("pdvId"));
    const from = url.searchParams.get("from");
    const to = url.searchParams.get("to");
    const rows = await query(
      `SELECT p.id, p.codigo_pedido, p.data_hora, p.sku_produto, pr.nome AS produto, pr.qtd_total AS estoque_central, p.quantidade_solicitada,
              p.quantidade_liberada,
              CASE
                WHEN p.status = 'Liberado' THEN 'Finalizado'
                WHEN p.status IN ('Liberado Parcial', 'Liberação Parcial') AND COALESCE(p.quantidade_liberada, 0) > 0 AND p.retirada_assinatura IS NOT NULL THEN 'Finalizado'
                WHEN p.status IN ('Liberado Parcial', 'Liberação Parcial') AND COALESCE(p.quantidade_liberada, 0) > 0 THEN 'Aguardando Retirada'
                WHEN p.status = 'Liberado Parcial' THEN 'Liberação Parcial'
                ELSE p.status
              END AS status,
              p.observacao, p.em_andamento_em, p.liberado_em, p.pronto_retirada_em,
              p.retirada_assinatura, p.retirada_responsavel, p.retirada_observacao,
              p.retirada_em, p.retirada_usuario_almoxarifado,
              p.version, p.updated_at,
              COALESCE(p.pedido_editado, FALSE) AS pedido_editado, p.pedido_editado_em, p.pedido_editado_por,
              COALESCE(p.pedido_reaberto_finalizado, FALSE) AS pedido_reaberto_finalizado,
              COALESCE(p.item_origem, 'PDV') AS item_origem
       FROM pedidos p
       JOIN produtos pr ON pr.sku = p.sku_produto
       WHERE p.pdv_id = $1 AND ($2::date IS NULL OR p.data_hora::date >= $2::date)
         AND ($3::date IS NULL OR p.data_hora::date <= $3::date)
       ORDER BY p.data_hora ASC, p.id ASC`,
      [pdvId, from || null, to || null]
    );
    send(res, 200, { orders: rows });
    return true;
  }

  if (url.pathname === "/api/admin/orders") {
    if (!requireUser(req, res, "admin")) return true;
    await ensurePedidoEditColumns();
    if (method === "DELETE") {
      const body = await readBody(req);
      const orderCode = normalizeText(body.codigo_pedido, 80);
      const deleteStatus = orderStatuses.includes(body.status) ? body.status : "";
      const fullDelete = body.full_delete === true && deleteStatus !== "Liberação Parcial";
      if (!orderCode) return send(res, 400, { error: "Pedido inválido." }), true;

      const deleted = await tx(async (client) => {
        const rows = await client.query(
          `SELECT id, status, quantidade_liberada, pdv_id, sku_produto
           FROM pedidos
           WHERE codigo_pedido = $1
           ORDER BY id`,
          [orderCode]
        );
        if (!rows.rows.length) return [];
        const rowsToDelete = deleteStatus === "Liberação Parcial" && !fullDelete
          ? rows.rows.filter((item) => normalizeOrderStatus(item.status) === "Liberação Parcial" && asInt(item.quantidade_liberada) <= 0)
          : rows.rows;
        if (!rowsToDelete.length) return [];

        for (const item of rowsToDelete) {
          if (normalizeOrderStatus(item.status) === "Finalizado") {
            const qty = asInt(item.quantidade_liberada);
            await client.query("UPDATE produtos SET qtd_total = qtd_total + $1 WHERE sku = $2", [qty, item.sku_produto]);
            await client.query(
              "UPDATE estoque_pdv SET quantidade = GREATEST(0, quantidade - $1) WHERE pdv_id = $2 AND sku_produto = $3",
              [qty, item.pdv_id, item.sku_produto]
            );
          }
        }
        if (deleteStatus === "Liberação Parcial" && !fullDelete) {
          for (const item of rowsToDelete) {
            await client.query(
              `UPDATE pedidos
               SET quantidade_solicitada = quantidade_liberada,
                   pedido_editado = TRUE,
                   pedido_editado_em = CURRENT_TIMESTAMP,
                   pedido_editado_por = $3,
                   updated_at = CURRENT_TIMESTAMP,
                   version = COALESCE(version, 1) + 1
               WHERE codigo_pedido = $1
                 AND sku_produto = $2
                 AND status = 'Aguardando Retirada'
                 AND COALESCE(quantidade_liberada, 0) > 0
                 AND quantidade_solicitada > quantidade_liberada`,
              [item.codigo_pedido, item.sku_produto, user.name || "Almoxarifado"]
            );
          }
        }

        const result = deleteStatus === "Liberação Parcial" && !fullDelete
          ? await client.query(
              `DELETE FROM pedidos
               WHERE codigo_pedido = $1
                 AND status IN ('Liberação Parcial', 'LiberaÃ§Ã£o Parcial', 'Liberado Parcial')
                 AND COALESCE(quantidade_liberada, 0) <= 0
               RETURNING id`,
              [orderCode]
            )
          : await client.query("DELETE FROM pedidos WHERE codigo_pedido = $1 RETURNING id", [orderCode]);
        return result.rows;
      });

      if (!deleted.length) return send(res, 404, { error: "Pedido não encontrado." }), true;
      send(res, 200, { ok: true, total: deleted.length });
      return true;
    }

    const from = url.searchParams.get("from");
    const to = url.searchParams.get("to");
    const pdvId = asInt(url.searchParams.get("pdvId"));
    const q = normalizeText(url.searchParams.get("q"), 80);
    await ensurePartialReleaseRemainders();
    const rows = await query(
      `SELECT p.id, p.codigo_pedido, p.pdv_id, pd.nome AS pdv, p.solicitante, p.sku_produto, pr.nome AS produto,
              p.quantidade_solicitada, p.quantidade_liberada,
              CASE
                WHEN p.status = 'Liberado' THEN 'Finalizado'
                WHEN p.status IN ('Liberado Parcial', 'Liberação Parcial') AND COALESCE(p.quantidade_liberada, 0) > 0 AND p.retirada_assinatura IS NOT NULL THEN 'Finalizado'
                WHEN p.status IN ('Liberado Parcial', 'Liberação Parcial') AND COALESCE(p.quantidade_liberada, 0) > 0 THEN 'Aguardando Retirada'
                WHEN p.status = 'Liberado Parcial' THEN 'Liberação Parcial'
                ELSE p.status
              END AS status,
              p.observacao,
              pr.qtd_total AS estoque_central, pr.qtd_total AS saldo, COALESCE(e.quantidade, 0) AS estoque_pdv, e.estoque_minimo, e.estoque_maximo, p.criado_em, p.em_andamento_em, p.liberado_em,
              p.pronto_retirada_em, p.retirada_assinatura, p.retirada_responsavel,
              p.retirada_observacao, p.retirada_em, p.retirada_usuario_almoxarifado,
              p.version, p.updated_at,
              COALESCE(p.pedido_editado, FALSE) AS pedido_editado, p.pedido_editado_em, p.pedido_editado_por,
              COALESCE(p.pedido_reaberto_finalizado, FALSE) AS pedido_reaberto_finalizado,
              COALESCE(p.item_origem, 'PDV') AS item_origem
       FROM pedidos p
       JOIN pdvs pd ON pd.id = p.pdv_id
       JOIN produtos pr ON pr.sku = p.sku_produto
       LEFT JOIN estoque_pdv e ON e.pdv_id = p.pdv_id AND e.sku_produto = p.sku_produto
       WHERE ($1::date IS NULL OR p.criado_em::date >= $1::date)
         AND ($2::date IS NULL OR p.criado_em::date <= $2::date)
         AND ($3::int = 0 OR p.pdv_id = $3)
         AND ($4::text IS NULL OR p.codigo_pedido ILIKE '%' || $4::text || '%')
       ORDER BY p.criado_em ASC, p.id ASC`,
      [from || null, to || null, pdvId, q || null]
    );
    send(res, 200, { orders: rows });
    return true;
  }

  if (url.pathname === "/api/admin/order-item" && method === "DELETE") {
    if (!requireUser(req, res, "admin")) return true;
    await ensurePedidoEditColumns();
    const body = await readBody(req);
    const id = asInt(body.id);
    if (!id) return send(res, 400, { error: "Produto inválido." }), true;

    const deleted = await tx(async (client) => {
      const row = await client.query(
        `SELECT id, codigo_pedido, status, quantidade_liberada, sku_produto
         FROM pedidos
         WHERE id = $1
         FOR UPDATE`,
        [id]
      );
      const item = row.rows[0];
      if (!item) return null;

      const currentStatus = normalizeOrderStatus(item.status);
      if (!["Em Andamento", "Liberação Parcial"].includes(currentStatus)) {
        const error = new Error("Este produto só pode ser excluído em Em andamento ou Liberação Parcial.");
        error.statusCode = 400;
        throw error;
      }
      if (currentStatus === "Liberação Parcial" && asInt(item.quantidade_liberada) > 0) {
        const error = new Error("Não é possível excluir produto já liberado pela Liberação Parcial.");
        error.statusCode = 400;
        throw error;
      }

      const result = await client.query("DELETE FROM pedidos WHERE id = $1 RETURNING id, codigo_pedido", [id]);
      if (currentStatus === "Liberação Parcial") {
        await client.query(
          `UPDATE pedidos
           SET quantidade_solicitada = quantidade_liberada,
               pedido_editado = TRUE,
               pedido_editado_em = NOW(),
               pedido_editado_por = 'Almoxarifado',
               updated_at = NOW(),
               version = COALESCE(version, 1) + 1
           WHERE codigo_pedido = $1
             AND sku_produto = $2
             AND status = 'Aguardando Retirada'
             AND COALESCE(quantidade_liberada, 0) > 0
             AND quantidade_solicitada > quantidade_liberada`,
          [item.codigo_pedido, item.sku_produto]
        );
      }
      await client.query(
        `UPDATE pedidos
         SET pedido_editado = TRUE,
             pedido_editado_em = NOW(),
             pedido_editado_por = 'Almoxarifado',
             updated_at = NOW(),
             version = COALESCE(version, 1) + 1
         WHERE codigo_pedido = $1`,
        [item.codigo_pedido]
      );
      return result.rows[0] || null;
    });

    if (!deleted) return send(res, 404, { error: "Produto não encontrado no pedido." }), true;
    send(res, 200, { ok: true, item: deleted });
    return true;
  }

  if ((url.pathname === "/api/admin/order-item" || url.pathname === "/api/admin/orders/add-item" || url.pathname === "/api/admin/orders/add-items") && method === "POST") {
    if (!requireUser(req, res, "admin")) return true;
    await ensurePedidoEditColumns();
    const body = await readBody(req);
    const orderCode = normalizeText(body.codigo_pedido, 80);
    const rawItems = Array.isArray(body.items) && body.items.length ? body.items : [body];
    const requestedItems = rawItems.map((item) => ({
      sku: normalizeText(item.sku_produto || item.sku, 60),
      qty: asInt(item.quantidade_solicitada || item.quantidade)
    })).filter((item) => item.sku && item.qty > 0);
    if (!orderCode || !requestedItems.length) return send(res, 400, { error: "Informe pedido, produto e quantidade." }), true;
    const duplicatedInput = requestedItems.find((item, index) => requestedItems.findIndex((other) => other.sku === item.sku) !== index);
    if (duplicatedInput) return send(res, 400, { error: "Remova produtos duplicados antes de adicionar ao pedido." }), true;

    const inserted = await tx(async (client) => {
      const rows = await client.query(
        `SELECT codigo_pedido, solicitante, pdv_id, observacao, status
         FROM pedidos
         WHERE codigo_pedido = $1
         ORDER BY id
         FOR UPDATE`,
        [orderCode]
      );
      if (!rows.rows.length) {
        const error = new Error("Pedido não encontrado.");
        error.statusCode = 404;
        throw error;
      }
      const invalidStatus = rows.rows.find((item) => normalizeOrderStatus(item.status) !== "Em Andamento");
      if (invalidStatus) {
        const error = new Error("Produtos só podem ser adicionados quando o pedido está Em andamento.");
        error.statusCode = 400;
        throw error;
      }
      const base = rows.rows[0];
      const skus = requestedItems.map((item) => item.sku);
      const products = await client.query("SELECT sku, nome, ativo FROM produtos WHERE sku = ANY($1::text[]) AND ativo IS NOT FALSE", [skus]);
      const productsBySku = new Map(products.rows.map((product) => [product.sku, product]));
      const missingProduct = requestedItems.find((item) => !productsBySku.has(item.sku));
      if (missingProduct) {
        const error = new Error(`Produto ${missingProduct.sku} não encontrado ou inativo.`);
        error.statusCode = 400;
        throw error;
      }
      const duplicate = await client.query(
        "SELECT sku_produto FROM pedidos WHERE codigo_pedido = $1 AND sku_produto = ANY($2::text[])",
        [orderCode, skus]
      );
      if (duplicate.rows.length) {
        const error = new Error("Este produto já existe no pedido. Altere a quantidade liberada na linha existente.");
        error.statusCode = 400;
        throw error;
      }
      const insertedRows = [];
      for (const item of requestedItems) {
        const product = productsBySku.get(item.sku);
        const result = await client.query(
          `INSERT INTO pedidos
             (codigo_pedido, solicitante, pdv_id, sku_produto, quantidade_solicitada, quantidade_liberada,
              status, observacao, criado_em, data_hora, em_andamento_em,
              pedido_editado, pedido_editado_em, pedido_editado_por, version, updated_at, item_origem)
           VALUES ($1, $2, $3, $4, $5, 0, 'Em Andamento', $6, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP,
                   CURRENT_TIMESTAMP, TRUE, CURRENT_TIMESTAMP, $7, 1, CURRENT_TIMESTAMP, 'ALMOX')
           RETURNING id, codigo_pedido, sku_produto, quantidade_solicitada, item_origem`,
          [orderCode, base.solicitante, base.pdv_id, item.sku, item.qty, base.observacao, user.name || "Almoxarifado"]
        );
        insertedRows.push({ ...result.rows[0], produto: product.nome });
      }
      await client.query(
        `UPDATE pedidos
         SET pedido_editado = TRUE,
             pedido_editado_em = CURRENT_TIMESTAMP,
             pedido_editado_por = $2,
             updated_at = CURRENT_TIMESTAMP,
             version = COALESCE(version, 1) + 1
         WHERE codigo_pedido = $1`,
        [orderCode, user.name || "Almoxarifado"]
      );
      return insertedRows;
    });

    send(res, 201, { ok: true, items: inserted, item: inserted[0] || null });
    return true;
  }

  if (url.pathname === "/api/admin/order-items" && method === "DELETE") {
    if (!requireUser(req, res, "admin")) return true;
    await ensurePedidoEditColumns();
    const body = await readBody(req);
    const orderCode = normalizeText(body.codigo_pedido, 80);
    const requestStatus = orderStatuses.includes(body.status) ? body.status : "";
    const requestedItems = Array.isArray(body.items) ? body.items : [];
    const ids = [...new Set(requestedItems.map((item) => asInt(item.id)).filter(Boolean))];
    const versionsById = new Map(requestedItems.map((item) => [asInt(item.id), asInt(item.version)]));
    if (!orderCode || !ids.length) return send(res, 400, { error: "Informe os produtos que devem ser excluídos." }), true;

    const result = await tx(async (client) => {
      const rows = await client.query(
        `SELECT id, codigo_pedido, status, quantidade_liberada, sku_produto, version
         FROM pedidos
         WHERE id = ANY($1::int[])
         FOR UPDATE`,
        [ids]
      );
      if (rows.rows.length !== ids.length) {
        const error = new Error("Pedido alterado por outro usuário. Atualize a tela antes de excluir.");
        error.statusCode = 409;
        throw error;
      }

      for (const item of rows.rows) {
        const currentStatus = normalizeOrderStatus(item.status);
        if (item.codigo_pedido !== orderCode) {
          const error = new Error("Os produtos selecionados não pertencem ao mesmo pedido.");
          error.statusCode = 400;
          throw error;
        }
        if (requestStatus && currentStatus !== requestStatus) {
          const error = new Error("Pedido alterado por outro usuário. Atualize a tela antes de excluir.");
          error.statusCode = 409;
          throw error;
        }
        if (!["Em Andamento", "Liberação Parcial"].includes(currentStatus)) {
          const error = new Error("Produtos só podem ser excluídos em Em andamento ou Liberação Parcial.");
          error.statusCode = 400;
          throw error;
        }
        if (currentStatus === "Liberação Parcial" && asInt(item.quantidade_liberada) > 0) {
          const error = new Error("Não é possível excluir produto já liberado pela Liberação Parcial.");
          error.statusCode = 400;
          throw error;
        }
        const expectedVersion = versionsById.get(asInt(item.id));
        if (expectedVersion > 0 && asInt(item.version) !== expectedVersion) {
          const error = new Error("Conflito de edição detectado. Atualize o pedido antes de excluir.");
          error.statusCode = 409;
          throw error;
        }
      }

      const partialRows = rows.rows.filter((item) => normalizeOrderStatus(item.status) === "Liberação Parcial");
      for (const item of partialRows) {
        await client.query(
          `UPDATE pedidos
           SET quantidade_solicitada = quantidade_liberada,
               pedido_editado = TRUE,
               pedido_editado_em = NOW(),
               pedido_editado_por = $3,
               updated_at = NOW(),
               version = COALESCE(version, 1) + 1
           WHERE codigo_pedido = $1
             AND sku_produto = $2
             AND status = 'Aguardando Retirada'
             AND COALESCE(quantidade_liberada, 0) > 0
             AND quantidade_solicitada > quantidade_liberada`,
          [item.codigo_pedido, item.sku_produto, user.name || "Almoxarifado"]
        );
      }

      const deleted = await client.query(
        `DELETE FROM pedidos
         WHERE id = ANY($1::int[])
         RETURNING id, codigo_pedido, sku_produto, quantidade_solicitada`,
        [ids]
      );

      const remaining = await client.query("SELECT COUNT(*)::int AS total FROM pedidos WHERE codigo_pedido = $1", [orderCode]);
      if (asInt(remaining.rows[0]?.total) > 0) {
        await client.query(
          `UPDATE pedidos
           SET pedido_editado = TRUE,
               pedido_editado_em = NOW(),
               pedido_editado_por = $2,
               updated_at = NOW(),
               version = COALESCE(version, 1) + 1
           WHERE codigo_pedido = $1`,
          [orderCode, user.name || "Almoxarifado"]
        );
      }

      return {
        deleted: deleted.rows,
        orderDeleted: asInt(remaining.rows[0]?.total) === 0
      };
    });

    send(res, 200, { ok: true, deleted: result.deleted, orderDeleted: result.orderDeleted });
    return true;
  }

  if (url.pathname === "/api/admin/order-flow" && method === "POST") {
    if (!requireUser(req, res, "admin")) return true;
    await ensurePedidoEditColumns();
    const body = await readBody(req);
    const nextStatus = orderStatuses.includes(body.status) ? body.status : null;
    const orderCode = normalizeText(body.codigo_pedido, 80);
    const currentStatusFilter = orderStatuses.includes(body.current_status) ? body.current_status : "";
    const releaseMode = body.release_mode === "entered-only" ? "entered-only" : "";
    let items = Array.isArray(body.items) ? body.items : [];
    if (!nextStatus || (!items.length && !orderCode)) return send(res, 400, { error: "Status ou itens inválidos." }), true;
    if (nextStatus === "Finalizado") return send(res, 400, { error: "Finalize o pedido pela confirmação de retirada com assinatura." }), true;

    await tx(async (client) => {
      if (orderCode && nextStatus === "Em Andamento") {
        const orderItems = await client.query(
          `SELECT id, status, quantidade_solicitada, quantidade_liberada, pdv_id, sku_produto, version
           FROM pedidos
           WHERE codigo_pedido = $1
           ORDER BY id
           FOR UPDATE`,
          [orderCode]
        );
        if (!orderItems.rows.length) {
          const error = new Error("Status ou itens inválidos.");
          error.statusCode = 400;
          throw error;
        }
        for (const current of orderItems.rows) {
          const currentStatus = normalizeOrderStatus(current.status);
          const allowedTransitions = {
            Pendente: ["Em Andamento"],
            "Em Andamento": ["Pendente", "Aguardando Retirada", "Liberação Parcial"],
            "Aguardando Retirada": ["Em Andamento"],
            "Liberação Parcial": ["Em Andamento", "Aguardando Retirada"],
            Finalizado: ["Em Andamento"]
          };
          if (currentStatus !== nextStatus && !allowedTransitions[currentStatus]?.includes(nextStatus)) {
            const error = new Error("Movimentação de status não permitida. Envie o pedido para Em andamento antes de editar.");
            error.statusCode = 400;
            throw error;
          }
          if (currentStatus === "Finalizado") {
            const oldQty = asInt(current.quantidade_liberada);
            await client.query("UPDATE produtos SET qtd_total = qtd_total + $1 WHERE sku = $2", [oldQty, current.sku_produto]);
            await client.query(
              "UPDATE estoque_pdv SET quantidade = GREATEST(0, quantidade - $1) WHERE pdv_id = $2 AND sku_produto = $3",
              [oldQty, current.pdv_id, current.sku_produto]
            );
          }
        }

        const groups = new Map();
        for (const row of orderItems.rows) {
          const key = `${row.pdv_id}::${row.sku_produto}`;
          const group = groups.get(key) || {
            keepId: row.id,
            ids: [],
            pdvId: row.pdv_id,
            sku: row.sku_produto,
            releasedTotal: 0,
            pendingTotal: 0,
            maxPending: 0,
            maxRequested: 0
          };
          group.ids.push(row.id);
          group.keepId = Math.min(group.keepId, row.id);
          const requestedQty = asInt(row.quantidade_solicitada);
          const releasedQty = asInt(row.quantidade_liberada);
          group.maxRequested = Math.max(group.maxRequested, requestedQty);
          if (releasedQty > 0) group.releasedTotal += releasedQty;
          else {
            group.pendingTotal += requestedQty;
            group.maxPending = Math.max(group.maxPending, requestedQty);
          }
          groups.set(key, group);
        }

        for (const group of groups.values()) {
          const pendingQty = group.maxPending || group.pendingTotal;
          const requestedQty = group.pendingTotal > 0
            ? Math.max(group.maxRequested, group.releasedTotal + pendingQty)
            : group.maxRequested;
          await client.query(
            `UPDATE pedidos
             SET status = 'Em Andamento',
                 quantidade_solicitada = $2,
                 quantidade_liberada = 0,
                 em_andamento_em = CURRENT_TIMESTAMP,
                 pedido_editado = TRUE,
                 pedido_editado_em = CURRENT_TIMESTAMP,
                 pedido_editado_por = $3,
                 pedido_reaberto_finalizado = TRUE,
                 retirada_assinatura = NULL,
                 retirada_responsavel = NULL,
             retirada_observacao = NULL,
             retirada_em = NULL,
             retirada_usuario_almoxarifado = NULL,
             release_mode = NULL,
             version = COALESCE(version, 1) + 1,
             updated_at = CURRENT_TIMESTAMP
         WHERE id = $1`,
            [group.keepId, requestedQty, user.name || "Almoxarifado"]
          );
          const duplicateIds = group.ids.filter((id) => id !== group.keepId);
          if (duplicateIds.length) {
            await client.query("DELETE FROM pedidos WHERE id = ANY($1::int[])", [duplicateIds]);
          }
        }
        return;
      }
      if (orderCode && ["Em Andamento", "Pendente"].includes(nextStatus)) {
        const orderItems = await client.query(
          `SELECT id, version
           FROM pedidos
           WHERE codigo_pedido = $1
             AND ($2::text = '' OR CASE
               WHEN status = 'Liberado' THEN 'Finalizado'
               WHEN status = 'Liberado Parcial' THEN 'Liberação Parcial'
               ELSE status
             END = $2)
           ORDER BY id
           FOR UPDATE`,
          [orderCode, currentStatusFilter]
        );
        items = orderItems.rows.map((row) => ({
          id: row.id,
          version: row.version,
          quantidade_liberada: 0,
          remover: false
        }));
      }
      if (!items.length) {
        const error = new Error("Status ou itens inválidos.");
        error.statusCode = 400;
        throw error;
      }
      let partialHasReleased = false;
      let partialHasMissing = false;
      let changedItems = 0;
      for (const item of items) {
        const old = await client.query("SELECT codigo_pedido, status, quantidade_solicitada, quantidade_liberada, pdv_id, sku_produto, version FROM pedidos WHERE id = $1", [asInt(item.id)]);
        if (!old.rows[0]) continue;
        const current = old.rows[0];
        const currentStatus = normalizeOrderStatus(current.status);
        const allowedTransitions = {
          Pendente: ["Em Andamento"],
          "Em Andamento": ["Pendente", "Aguardando Retirada", "Liberação Parcial"],
          "Aguardando Retirada": ["Em Andamento"],
          "Liberação Parcial": ["Em Andamento", "Aguardando Retirada"],
          Finalizado: ["Em Andamento"]
        };
        if (!allowedTransitions[currentStatus]?.includes(nextStatus)) {
          const error = new Error("Movimentação de status não permitida. Envie o pedido para Em andamento antes de editar.");
          error.statusCode = 400;
          throw error;
        }
        const leavesFinalized = currentStatus === "Finalizado" && nextStatus !== "Finalizado";
        const expectedVersion = asInt(item.version);
        if (expectedVersion > 0 && asInt(current.version) !== expectedVersion) {
          const error = new Error("Conflito de edição detectado. Atualize o pedido antes de salvar.");
          error.statusCode = 409;
          throw error;
        }
        if (item.remover) {
          if (currentStatus !== "Em Andamento") {
            const error = new Error("Só é possível remover produtos quando o pedido está Em andamento.");
            error.statusCode = 400;
            throw error;
          }
          if (currentStatus === "Finalizado") {
            const oldQty = asInt(current.quantidade_liberada);
            await client.query("UPDATE produtos SET qtd_total = qtd_total + $1 WHERE sku = $2", [oldQty, current.sku_produto]);
            await client.query(
              "UPDATE estoque_pdv SET quantidade = GREATEST(0, quantidade - $1) WHERE pdv_id = $2 AND sku_produto = $3",
              [oldQty, current.pdv_id, current.sku_produto]
            );
          }
          await client.query("DELETE FROM pedidos WHERE id = $1", [asInt(item.id)]);
          continue;
        }
        const requestedQty = asInt(current.quantidade_solicitada);
        let qty = asInt(current.quantidade_liberada);
        if (currentStatus === "Em Andamento" && nextStatus === "Liberação Parcial") {
          qty = asInt(item.quantidade_liberada);
        } else if (["Em Andamento", "Liberação Parcial"].includes(currentStatus) && nextStatus === "Aguardando Retirada") {
          const requestedReleaseQty = asInt(item.quantidade_liberada);
          qty = releaseMode === "entered-only"
            ? requestedReleaseQty
            : requestedReleaseQty > 0 ? requestedReleaseQty : requestedQty;
        } else if (nextStatus === "Em Andamento") {
          qty = 0;
        } else if (nextStatus === "Pendente") {
          qty = 0;
        }
        if (qty < 0) {
          const error = new Error("A quantidade liberada não pode ser negativa.");
          error.statusCode = 400;
          throw error;
        }
        if (releaseMode === "entered-only" && nextStatus === "Aguardando Retirada" && qty <= 0) {
          continue;
        }
        if (nextStatus === "Liberação Parcial") {
          partialHasReleased ||= qty > 0;
          partialHasMissing ||= qty < requestedQty;
        }
        if (nextStatus === "Liberação Parcial" && qty > 0 && qty < requestedQty) {
          const missingQty = requestedQty - qty;
          await client.query(
            `INSERT INTO pedidos
               (codigo_pedido, solicitante, pdv_id, sku_produto, quantidade_solicitada, quantidade_liberada,
                status, observacao, criado_em, data_hora, liberado_em, pronto_retirada_em,
                pedido_editado, pedido_editado_em, pedido_editado_por, version, updated_at)
             SELECT codigo_pedido, solicitante, pdv_id, sku_produto, $2, 0,
                    'Liberação Parcial', observacao, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP, NULL, NULL,
                    TRUE, CURRENT_TIMESTAMP, $3, 1, CURRENT_TIMESTAMP
             FROM pedidos
             WHERE id = $1`,
            [asInt(item.id), missingQty, user.name || "Almoxarifado"]
          );
          await client.query(
            `UPDATE pedidos
             SET status = 'Aguardando Retirada',
                 quantidade_liberada = $2,
                 liberado_em = CURRENT_TIMESTAMP,
                 pronto_retirada_em = CURRENT_TIMESTAMP,
                 pedido_editado = TRUE,
                 pedido_editado_em = CURRENT_TIMESTAMP,
                 pedido_editado_por = $3,
                 retirada_assinatura = NULL,
                 retirada_responsavel = NULL,
                 retirada_observacao = NULL,
                 retirada_em = NULL,
                 retirada_usuario_almoxarifado = NULL,
                 release_mode = NULL,
                 version = COALESCE(version, 1) + 1,
                 updated_at = CURRENT_TIMESTAMP
             WHERE id = $1`,
            [asInt(item.id), qty, user.name || "Almoxarifado"]
          );
          continue;
        }
        const itemStatus = nextStatus === "Liberação Parcial" && qty > 0
          ? "Aguardando Retirada"
          : nextStatus;

        const timeField = itemStatus === "Em Andamento"
          ? ", em_andamento_em = CURRENT_TIMESTAMP"
          : ["Aguardando Retirada", "Liberação Parcial"].includes(itemStatus)
            ? ", liberado_em = CURRENT_TIMESTAMP, pronto_retirada_em = CURRENT_TIMESTAMP"
            : "";
        await client.query(
          `UPDATE pedidos
           SET status = $1,
               quantidade_liberada = $2,
               pedido_editado = COALESCE(pedido_editado, FALSE) OR $4::boolean,
               pedido_editado_em = CASE WHEN $4::boolean THEN CURRENT_TIMESTAMP ELSE pedido_editado_em END,
               pedido_editado_por = CASE WHEN $4::boolean THEN $5 ELSE pedido_editado_por END,
               pedido_reaberto_finalizado = COALESCE(pedido_reaberto_finalizado, FALSE) OR $4::boolean,
               retirada_assinatura = CASE WHEN $4::boolean THEN NULL ELSE retirada_assinatura END,
               retirada_responsavel = CASE WHEN $4::boolean THEN NULL ELSE retirada_responsavel END,
               retirada_observacao = CASE WHEN $4::boolean THEN NULL ELSE retirada_observacao END,
               retirada_em = CASE WHEN $4::boolean THEN NULL ELSE retirada_em END,
               retirada_usuario_almoxarifado = CASE WHEN $4::boolean THEN NULL ELSE retirada_usuario_almoxarifado END,
               release_mode = $6,
               version = COALESCE(version, 1) + 1,
               updated_at = CURRENT_TIMESTAMP
               ${timeField}
           WHERE id = $3`,
          [
            itemStatus,
            qty,
            asInt(item.id),
            leavesFinalized,
            user.name || "Almoxarifado",
            itemStatus === "Aguardando Retirada" && releaseMode === "entered-only" ? "entered-only" : null
          ]
        );
        if (itemStatus === "Aguardando Retirada") {
          const existing = await client.query(
            `SELECT id
             FROM pedidos
             WHERE codigo_pedido = $1
               AND sku_produto = $2
               AND status = 'Aguardando Retirada'
               AND id <> $3
             ORDER BY id
             LIMIT 1
             FOR UPDATE`,
            [current.codigo_pedido || orderCode, current.sku_produto, asInt(item.id)]
          );
          const keep = existing.rows[0];
          if (keep) {
            await client.query(
              `UPDATE pedidos
               SET quantidade_liberada = COALESCE(quantidade_liberada, 0) + $2,
                   quantidade_solicitada = GREATEST(quantidade_solicitada, COALESCE(quantidade_liberada, 0) + $2),
                   pedido_editado = TRUE,
                   pedido_editado_em = CURRENT_TIMESTAMP,
                   pedido_editado_por = $3,
                   retirada_assinatura = NULL,
                   retirada_responsavel = NULL,
                   retirada_observacao = NULL,
                   retirada_em = NULL,
                   retirada_usuario_almoxarifado = NULL,
                   release_mode = COALESCE(release_mode, $4),
                   version = COALESCE(version, 1) + 1,
                   updated_at = CURRENT_TIMESTAMP
               WHERE id = $1`,
              [
                keep.id,
                qty,
                user.name || "Almoxarifado",
                releaseMode === "entered-only" ? "entered-only" : null
              ]
            );
            await client.query("DELETE FROM pedidos WHERE id = $1", [asInt(item.id)]);
          }
        }
        changedItems += 1;

        if (currentStatus === "Finalizado" && itemStatus !== "Finalizado") {
          const oldQty = asInt(current.quantidade_liberada);
          await client.query("UPDATE produtos SET qtd_total = qtd_total + $1 WHERE sku = $2", [oldQty, current.sku_produto]);
          await client.query(
            "UPDATE estoque_pdv SET quantidade = GREATEST(0, quantidade - $1) WHERE pdv_id = $2 AND sku_produto = $3",
            [oldQty, current.pdv_id, current.sku_produto]
          );
        }
      }
      if (nextStatus === "Liberação Parcial" && (!partialHasReleased || !partialHasMissing)) {
        const error = new Error("Para liberar parcialmente, informe ao menos um produto liberado e mantenha ao menos um produto com falta de envio.");
        error.statusCode = 400;
        throw error;
      }
      if (releaseMode === "entered-only" && nextStatus === "Aguardando Retirada" && changedItems === 0) {
        const error = new Error("Informe a quantidade que deseja liberar em pelo menos um produto.");
        error.statusCode = 400;
        throw error;
      }
    });
    send(res, 200, { ok: true });
    return true;
  }

  if (url.pathname === "/api/admin/order-withdrawal" && method === "POST") {
    if (!requireUser(req, res, "admin")) return true;
    const body = await readBody(req);
    const orderCode = normalizeText(body.codigo_pedido, 80);
    const responsavel = normalizeText(body.responsavel_retirada, 160).toUpperCase();
    const observacao = normalizeText(body.observacao, 500);
    const assinatura = String(body.assinatura || "");
    if (!orderCode) return send(res, 400, { error: "Pedido inválido." }), true;
    if (!responsavel) return send(res, 400, { error: "Informe o responsável pela retirada." }), true;
    if (!assinatura.startsWith("data:image/png;base64,") || assinatura.length < 1200) {
      return send(res, 400, { error: "A assinatura do responsável é obrigatória." }), true;
    }

    await tx(async (client) => {
      const requestedStatus = orderStatuses.includes(body.status) ? body.status : "";
      const rows = await client.query(
        `SELECT id, codigo_pedido, solicitante, pdv_id, sku_produto, quantidade_solicitada, quantidade_liberada,
                status, observacao, retirada_assinatura, pedido_editado, pedido_editado_em, pedido_editado_por,
                release_mode
         FROM pedidos
         WHERE codigo_pedido = $1
         ORDER BY id
         FOR UPDATE`,
        [orderCode]
      );
      if (!rows.rows.length) {
        const error = new Error("Pedido não encontrado.");
        error.statusCode = 404;
        throw error;
      }
      const normalizedRows = rows.rows.map((row) => ({
        ...row,
        normalizedStatus: normalizeOrderStatus(row.status)
      }));
      const targetStatus = requestedStatus && ["Aguardando Retirada", "Liberação Parcial"].includes(requestedStatus)
        ? requestedStatus
        : normalizedRows.some((row) => row.normalizedStatus === "Aguardando Retirada")
          ? "Aguardando Retirada"
          : "Liberação Parcial";
      const targetRows = normalizedRows.filter((row) => row.normalizedStatus === targetStatus);
      if (!targetRows.length) {
        const error = new Error("Não há produtos deste status para confirmar a retirada.");
        error.statusCode = 400;
        throw error;
      }
      if (targetRows.some((row) => row.retirada_assinatura)) {
        const error = new Error("A retirada deste pedido já foi confirmada.");
        error.statusCode = 400;
        throw error;
      }
      if (targetRows.some((row) => !["Aguardando Retirada", "Liberação Parcial"].includes(row.normalizedStatus))) {
        const error = new Error("A retirada só pode ser confirmada para pedidos aguardando retirada ou liberação parcial.");
        error.statusCode = 400;
        throw error;
      }
      if (targetRows.some((row) => asInt(row.quantidade_liberada) <= 0)) {
        const error = new Error("A retirada só pode ser confirmada para produtos com quantidade liberada.");
        error.statusCode = 400;
        throw error;
      }
      for (const row of targetRows) {
        const qty = asInt(row.quantidade_liberada);
        const requestedQty = asInt(row.quantidade_solicitada);
        const missingQty = Math.max(requestedQty - qty, 0);
        const suppressRemainder = row.release_mode === "entered-only";
        const hasSeparateRemainder = missingQty > 0
          ? normalizedRows.some((candidate) =>
              candidate.id !== row.id
              && candidate.sku_produto === row.sku_produto
              && candidate.normalizedStatus === "Liberação Parcial"
              && asInt(candidate.quantidade_liberada) <= 0
            )
          : false;
        await client.query("UPDATE produtos SET qtd_total = qtd_total - $1 WHERE sku = $2", [qty, row.sku_produto]);
        await client.query(
          `INSERT INTO estoque_pdv (pdv_id, sku_produto, quantidade)
           VALUES ($1, $2, $3)
           ON CONFLICT (pdv_id, sku_produto) DO UPDATE SET quantidade = estoque_pdv.quantidade + EXCLUDED.quantidade`,
          [row.pdv_id, row.sku_produto, qty]
        );
        if (missingQty > 0 && !hasSeparateRemainder && !suppressRemainder) {
          const existingRemainder = await client.query(
            `SELECT id
             FROM pedidos
             WHERE codigo_pedido = $1
               AND sku_produto = $2
               AND status IN ('Liberação Parcial', 'Liberado Parcial')
               AND COALESCE(quantidade_liberada, 0) <= 0
             ORDER BY id
             LIMIT 1`,
            [row.codigo_pedido, row.sku_produto]
          );
          if (!existingRemainder.rows[0]) {
            await client.query(
              `INSERT INTO pedidos
                 (codigo_pedido, solicitante, pdv_id, sku_produto, quantidade_solicitada, quantidade_liberada,
                  status, observacao, criado_em, data_hora, pedido_editado, pedido_editado_em, pedido_editado_por,
                  version, updated_at)
               VALUES ($1, $2, $3, $4, $5, 0, 'Liberação Parcial', $6,
                       CURRENT_TIMESTAMP, CURRENT_TIMESTAMP, TRUE, CURRENT_TIMESTAMP, $7, 1, CURRENT_TIMESTAMP)`,
              [
                row.codigo_pedido,
                row.solicitante,
                row.pdv_id,
                row.sku_produto,
                missingQty,
                row.observacao,
                user.name || "Almoxarifado"
              ]
            );
          }
        }
      }
      const finalized = await client.query(
        `UPDATE pedidos
         SET status = 'Finalizado',
             retirada_assinatura = $2,
             retirada_responsavel = $3,
             retirada_observacao = $4,
             retirada_em = CURRENT_TIMESTAMP,
             retirada_usuario_almoxarifado = $5,
             updated_at = CURRENT_TIMESTAMP
         WHERE codigo_pedido = $1
           AND status = $6
           AND quantidade_liberada > 0
         RETURNING id, codigo_pedido, sku_produto, quantidade_liberada`,
        [orderCode, assinatura, responsavel, observacao || null, user.name || "Almoxarifado", targetStatus]
      );
      for (const row of finalized.rows || []) {
        const existing = await client.query(
          `SELECT id
           FROM pedidos
           WHERE codigo_pedido = $1
             AND sku_produto = $2
             AND status = 'Finalizado'
             AND id <> $3
           ORDER BY id
           LIMIT 1
           FOR UPDATE`,
          [row.codigo_pedido, row.sku_produto, row.id]
        );
        const keep = existing.rows[0];
        if (!keep) continue;
        await client.query(
          `UPDATE pedidos
           SET quantidade_liberada = COALESCE(quantidade_liberada, 0) + $2,
               quantidade_solicitada = GREATEST(quantidade_solicitada, COALESCE(quantidade_liberada, 0) + $2),
               retirada_assinatura = $3,
               retirada_responsavel = $4,
               retirada_observacao = $5,
               retirada_em = CURRENT_TIMESTAMP,
               retirada_usuario_almoxarifado = $6,
               pedido_editado = TRUE,
               pedido_editado_em = CURRENT_TIMESTAMP,
               pedido_editado_por = $6,
               version = COALESCE(version, 1) + 1,
               updated_at = CURRENT_TIMESTAMP
           WHERE id = $1`,
          [keep.id, asInt(row.quantidade_liberada), assinatura, responsavel, observacao || null, user.name || "Almoxarifado"]
        );
        await client.query("DELETE FROM pedidos WHERE id = $1", [row.id]);
      }
    });

    send(res, 200, { ok: true });
    return true;
  }

  if (url.pathname === "/api/admin/history") {
    if (!requireUser(req, res, "admin")) return true;
    await ensurePedidoEditColumns();
    const pdvId = asInt(url.searchParams.get("pdvId"));
    const autoOnly = url.searchParams.get("auto") === "1";
    const status = normalizeText(url.searchParams.get("status"), 40);
    const allowedStatus = orderStatuses.includes(status) ? status : "";
    const from = url.searchParams.get("from");
    const to = url.searchParams.get("to");
    const rows = await query(
      `SELECT p.id, p.data_hora, p.codigo_pedido, pd.nome AS pdv, p.solicitante, p.observacao,
              pr.nome AS produto, p.quantidade_solicitada, p.quantidade_liberada,
              p.retirada_assinatura, p.retirada_responsavel, p.retirada_em, p.retirada_usuario_almoxarifado,
              CASE
                WHEN p.status = 'Liberado' THEN 'Finalizado'
                WHEN p.status IN ('Liberado Parcial', 'Liberação Parcial') AND COALESCE(p.quantidade_liberada, 0) > 0 AND p.retirada_assinatura IS NOT NULL THEN 'Finalizado'
                WHEN p.status IN ('Liberado Parcial', 'Liberação Parcial') AND COALESCE(p.quantidade_liberada, 0) > 0 THEN 'Aguardando Retirada'
                WHEN p.status = 'Liberado Parcial' THEN 'Liberação Parcial'
                ELSE p.status
              END AS status,
              COALESCE(p.pedido_editado, FALSE) AS pedido_editado, p.pedido_editado_em, p.pedido_editado_por,
              COALESCE(p.pedido_reaberto_finalizado, FALSE) AS pedido_reaberto_finalizado,
              COALESCE(p.item_origem, 'PDV') AS item_origem
       FROM pedidos p
       JOIN pdvs pd ON pd.id = p.pdv_id
       JOIN produtos pr ON pr.sku = p.sku_produto
       WHERE ($1::int = 0 OR p.pdv_id = $1)
         AND ($2::boolean = FALSE OR p.codigo_pedido LIKE 'AUTO-%')
         AND ($3::text IS NULL OR CASE
                WHEN p.status = 'Liberado' THEN 'Finalizado'
                WHEN p.status IN ('Liberado Parcial', 'Liberação Parcial') AND COALESCE(p.quantidade_liberada, 0) > 0 AND p.retirada_assinatura IS NOT NULL THEN 'Finalizado'
                WHEN p.status IN ('Liberado Parcial', 'Liberação Parcial') AND COALESCE(p.quantidade_liberada, 0) > 0 THEN 'Aguardando Retirada'
                WHEN p.status = 'Liberado Parcial' THEN 'Liberação Parcial'
                ELSE p.status
              END = $3)
         AND ($4::date IS NULL OR p.data_hora::date >= $4::date)
         AND ($5::date IS NULL OR p.data_hora::date <= $5::date)
       ORDER BY p.data_hora DESC, p.id ASC
       LIMIT 500`,
      [pdvId, autoOnly, allowedStatus || null, from || null, to || null]
    );
    send(res, 200, { history: rows });
    return true;
  }

  return false;
}


