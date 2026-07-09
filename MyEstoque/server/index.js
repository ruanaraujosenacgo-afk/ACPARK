import "dotenv/config";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import jwt from "jsonwebtoken";
import { parse as parseCookie, serialize as serializeCookie } from "cookie";
import { pool, query, tx, verifyPassword, hashPassword, asInt, code } from "./db.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(__dirname, "..");
const publicDir = path.join(rootDir, "public");
const port = Number(process.env.PORT || 5173);
const jwtSecret = process.env.JWT_SECRET || "dev-only-change-me";
const secureCookies = process.env.NODE_ENV === "production" || Boolean(process.env.VERCEL);
const sessionCookieOptions = { path: "/", httpOnly: true, sameSite: "lax", secure: secureCookies };

const mime = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8"
};

function send(res, status, data, headers = {}) {
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8", ...headers });
  res.end(JSON.stringify(data));
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let body = "";
    req.on("data", (chunk) => {
      body += chunk;
      if (body.length > 1_000_000) reject(new Error("Payload muito grande."));
    });
    req.on("end", () => {
      if (!body) return resolve({});
      try {
        resolve(JSON.parse(body));
      } catch {
        reject(new Error("JSON invalido."));
      }
    });
  });
}

function sessionFrom(req) {
  const cookies = parseCookie(req.headers.cookie || "");
  if (!cookies.session) return null;
  try {
    return jwt.verify(cookies.session, jwtSecret);
  } catch {
    return null;
  }
}

function requireUser(req, res, role = null) {
  const user = sessionFrom(req);
  if (!user) {
    send(res, 401, { error: "Login necessario." });
    return null;
  }
  if (role && user.role !== role) {
    send(res, 403, { error: "Acesso nao permitido para este perfil." });
    return null;
  }
  return user;
}

function normalizeText(value, max = 120) {
  return String(value || "").trim().slice(0, max);
}

function normalizeCategories(values) {
  if (!Array.isArray(values)) return [];
  return [...new Set(values.map((value) => normalizeText(value, 120).toUpperCase()).filter(Boolean))];
}

async function syncPdvAllowedProducts(client, pdvId) {
  await client.query(
    `INSERT INTO estoque_pdv (pdv_id, sku_produto, permitido)
     SELECT $1, p.sku, TRUE
     FROM produtos p
     JOIN pdv_categorias pc ON pc.pdv_id = $1 AND pc.categoria = p.categoria
     ON CONFLICT (pdv_id, sku_produto) DO UPDATE SET permitido = TRUE`,
    [pdvId]
  );
  await client.query(
    `UPDATE estoque_pdv e
     SET permitido = FALSE
     WHERE e.pdv_id = $1
       AND NOT EXISTS (
         SELECT 1
         FROM produtos p
         JOIN pdv_categorias pc ON pc.pdv_id = e.pdv_id AND pc.categoria = p.categoria
         WHERE p.sku = e.sku_produto
       )`,
    [pdvId]
  );
}

async function ensureSchema() {
  const schema = fs.readFileSync(path.join(__dirname, "schema.sql"), "utf8");
  await pool.query(schema);
}

async function processOrionAndAutoOrders() {
  await tx(async (client) => {
    const pending = await client.query(
      `SELECT id, pdv_id, sku_produto, quantidade_vendida, COALESCE(tipo_operacao, 'VENDA') AS tipo_operacao
       FROM vendas_orion
       WHERE processado = FALSE
       ORDER BY id`
    );

    for (const row of pending.rows) {
      const qty = asInt(row.quantidade_vendida);
      if (row.tipo_operacao === "DEVOLUCAO") {
        await client.query(
          `UPDATE estoque_pdv SET quantidade = quantidade + $1
           WHERE pdv_id = $2 AND sku_produto = $3`,
          [qty, row.pdv_id, row.sku_produto]
        );
      } else {
        await client.query(
          `UPDATE estoque_pdv SET quantidade = GREATEST(0, quantidade - $1)
           WHERE pdv_id = $2 AND sku_produto = $3`,
          [qty, row.pdv_id, row.sku_produto]
        );
      }
      await client.query("UPDATE vendas_orion SET processado = TRUE WHERE id = $1", [row.id]);
    }

    const lows = await client.query(
      `SELECT e.pdv_id, e.sku_produto, e.quantidade, e.estoque_minimo, e.estoque_maximo
       FROM estoque_pdv e
       JOIN produtos p ON p.sku = e.sku_produto
       WHERE e.permitido = TRUE
         AND p.ativo = TRUE
         AND e.estoque_maximo > e.quantidade
         AND e.quantidade <= e.estoque_minimo`
    );

    for (const item of lows.rows) {
      const exists = await client.query(
        `SELECT 1 FROM pedidos
         WHERE pdv_id = $1 AND sku_produto = $2 AND codigo_pedido LIKE 'AUTO-%'
           AND status IN ('Pendente', 'Em Andamento')
         LIMIT 1`,
        [item.pdv_id, item.sku_produto]
      );
      if (exists.rowCount) continue;

      await client.query(
        `INSERT INTO pedidos
          (codigo_pedido, solicitante, pdv_id, sku_produto, quantidade_solicitada, quantidade_liberada, status, observacao)
         VALUES ($1, 'AUTO PEDIDO', $2, $3, $4, 0, 'Pendente', 'Gerado automaticamente por estoque minimo')`,
        [code("AUTO"), item.pdv_id, item.sku_produto, item.estoque_maximo - item.quantidade]
      );
    }
  });
}

async function api(req, res) {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const method = req.method || "GET";

  if (url.pathname === "/api/auth/me") {
    return send(res, 200, { user: sessionFrom(req) });
  }

  if (url.pathname === "/api/auth/logout" && method === "POST") {
    return send(res, 200, { ok: true }, {
      "Set-Cookie": serializeCookie("session", "", { ...sessionCookieOptions, maxAge: 0 })
    });
  }

  if (url.pathname === "/api/auth/login" && method === "POST") {
    const body = await readBody(req);
    const profile = body.profile === "admin" ? "admin" : "pdv";
    const password = normalizeText(body.password, 120);

    if (profile === "admin") {
      const rows = await query("SELECT valor FROM configuracoes WHERE chave = 'senha_almoxarifado'");
      if (!rows[0] || !verifyPassword(password, rows[0].valor)) return send(res, 401, { error: "Senha incorreta." });
      const token = jwt.sign({ role: "admin", name: "Almoxarifado" }, jwtSecret, { expiresIn: "8h" });
      return send(res, 200, { user: { role: "admin", name: "Almoxarifado" } }, {
        "Set-Cookie": serializeCookie("session", token, { ...sessionCookieOptions, maxAge: 60 * 60 * 8 })
      });
    }

    const pdvId = asInt(body.pdvId);
    const rows = await query("SELECT id, nome, senha FROM pdvs WHERE id = $1", [pdvId]);
    if (!rows[0] || !verifyPassword(password, rows[0].senha)) return send(res, 401, { error: "Senha incorreta." });
    const token = jwt.sign({ role: "pdv", pdvId: rows[0].id, name: rows[0].nome }, jwtSecret, { expiresIn: "8h" });
    return send(res, 200, { user: { role: "pdv", pdvId: rows[0].id, name: rows[0].nome } }, {
      "Set-Cookie": serializeCookie("session", token, { ...sessionCookieOptions, maxAge: 60 * 60 * 8 })
    });
  }

  if (url.pathname === "/api/public/pdvs") {
    return send(res, 200, { pdvs: await query("SELECT id, nome FROM pdvs ORDER BY nome") });
  }

  const user = requireUser(req, res);
  if (!user) return;

  await processOrionAndAutoOrders();

  if (url.pathname === "/api/bootstrap") {
    const [pdvs, products, categories] = await Promise.all([
      query(`
        SELECT p.id, p.nome, p.codigo_orion, p.is_cozinha, p.categoria,
               COALESCE(ARRAY(
                 SELECT pc.categoria
                 FROM pdv_categorias pc
                 WHERE pc.pdv_id = p.id
                 ORDER BY pc.categoria
               ), '{}') AS categorias
        FROM pdvs p
        ORDER BY p.nome
      `),
      query("SELECT sku, nome, qtd_total, ativo, categoria, COALESCE(origem, 'manual') AS origem FROM produtos ORDER BY nome"),
      query("SELECT nome FROM categorias ORDER BY nome")
    ]);
    return send(res, 200, { pdvs, products, categories, user });
  }

  if (url.pathname === "/api/pdv/products") {
    const pdvId = user.role === "pdv" ? user.pdvId : asInt(url.searchParams.get("pdvId"));
    const rows = await query(
      `SELECT p.sku, p.nome, p.categoria, e.quantidade, e.estoque_minimo, e.estoque_maximo
       FROM estoque_pdv e
       JOIN produtos p ON p.sku = e.sku_produto
       JOIN pdv_categorias pc ON pc.pdv_id = e.pdv_id AND pc.categoria = p.categoria
       WHERE e.pdv_id = $1 AND e.permitido = TRUE AND p.ativo = TRUE
       ORDER BY p.nome`,
      [pdvId]
    );
    return send(res, 200, { products: rows });
  }

  if (url.pathname === "/api/pdv/order" && method === "POST") {
    if (user.role !== "pdv") return send(res, 403, { error: "Entre como PDV para solicitar produtos." });
    const body = await readBody(req);
    const solicitante = normalizeText(body.solicitante, 80).toUpperCase();
    const observacao = normalizeText(body.observacao, 500);
    const items = Array.isArray(body.items) ? body.items : [];
    if (!solicitante || !items.length) return send(res, 400, { error: "Informe solicitante e ao menos um item." });

    const orderCode = code("PED");
    await tx(async (client) => {
      for (const item of items) {
        const sku = normalizeText(item.sku, 60);
        const qty = asInt(item.quantidade);
        if (!sku || qty <= 0) throw new Error("Item invalido.");

        const allowed = await client.query(
          `SELECT e.quantidade, e.estoque_maximo
           FROM estoque_pdv e
           JOIN produtos p ON p.sku = e.sku_produto
           JOIN pdv_categorias pc ON pc.pdv_id = e.pdv_id AND pc.categoria = p.categoria
           WHERE e.pdv_id = $1 AND e.sku_produto = $2 AND e.permitido = TRUE`,
          [user.pdvId, sku]
        );
        if (!allowed.rows[0]) throw new Error("Produto nao liberado para este PDV.");
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
    });
    return send(res, 201, { ok: true, codigo: orderCode });
  }

  if (url.pathname === "/api/pdv/orders") {
    const pdvId = user.role === "pdv" ? user.pdvId : asInt(url.searchParams.get("pdvId"));
    const from = url.searchParams.get("from");
    const to = url.searchParams.get("to");
    const rows = await query(
      `SELECT p.codigo_pedido, p.data_hora, pr.nome AS produto, p.quantidade_solicitada,
              p.quantidade_liberada, p.status, p.observacao, p.em_andamento_em, p.liberado_em
       FROM pedidos p
       JOIN produtos pr ON pr.sku = p.sku_produto
       WHERE p.pdv_id = $1 AND ($2::date IS NULL OR p.data_hora::date >= $2::date)
         AND ($3::date IS NULL OR p.data_hora::date <= $3::date)
       ORDER BY p.data_hora ASC, p.id ASC`,
      [pdvId, from || null, to || null]
    );
    return send(res, 200, { orders: rows });
  }

  if (url.pathname === "/api/admin/products") {
    if (!requireUser(req, res, "admin")) return;
    if (method === "GET") {
      return send(res, 200, { products: await query("SELECT sku, nome, qtd_total, ativo, categoria, COALESCE(origem, 'manual') AS origem FROM produtos ORDER BY nome") });
    }
    const body = await readBody(req);
    if (method === "POST") {
      const sku = normalizeText(body.sku, 60).toUpperCase();
      const nome = normalizeText(body.nome, 160).toUpperCase();
      const qty = asInt(body.qtd_total);
      if (!sku || !nome) return send(res, 400, { error: "SKU e nome sao obrigatorios." });
      const inserted = await query(
        `INSERT INTO produtos (sku, nome, qtd_total, estoque_central, ativo, categoria, origem)
         VALUES ($1, $2, $3, $3, TRUE, NULL, 'manual')
         ON CONFLICT (sku) DO UPDATE SET
           nome = EXCLUDED.nome,
           qtd_total = EXCLUDED.qtd_total,
           estoque_central = EXCLUDED.estoque_central,
           ativo = TRUE
         WHERE COALESCE(produtos.origem, 'manual') = 'manual'
         RETURNING sku`,
        [sku, nome, qty]
      );
      if (!inserted[0]) return send(res, 400, { error: "Este SKU pertence a um produto integrado ao OMIE." });
      return send(res, 200, { ok: true });
    }
    if (method === "PATCH") {
      const sku = normalizeText(body.sku, 60).toUpperCase();
      const updated = await query("UPDATE produtos SET nome = $2, qtd_total = $3, estoque_central = $3, ativo = $4 WHERE sku = $1 AND COALESCE(origem, 'manual') = 'manual' RETURNING sku", [
        sku,
        normalizeText(body.nome, 160).toUpperCase(),
        asInt(body.qtd_total),
        Boolean(body.ativo)
      ]);
      if (!updated[0]) return send(res, 400, { error: "Produto integrado ao OMIE nao pode ser editado aqui." });
      if (!body.ativo) await query("UPDATE estoque_pdv SET permitido = FALSE WHERE sku_produto = $1", [sku]);
      return send(res, 200, { ok: true });
    }
    if (method === "DELETE") {
      const sku = normalizeText(body.sku, 60).toUpperCase();
      const deleted = await tx(async (client) => {
        const check = await client.query("SELECT sku FROM produtos WHERE sku = $1 AND COALESCE(origem, 'manual') = 'manual'", [sku]);
        if (!check.rows[0]) return [];
        await client.query("DELETE FROM vendas_orion WHERE sku_produto = $1", [sku]);
        await client.query("DELETE FROM pedidos WHERE sku_produto = $1", [sku]);
        await client.query("DELETE FROM estoque_pdv WHERE sku_produto = $1", [sku]);
        const result = await client.query("DELETE FROM produtos WHERE sku = $1 RETURNING sku", [sku]);
        return result.rows;
      });
      if (!deleted[0]) return send(res, 400, { error: "Produto integrado ao OMIE nao pode ser excluido aqui." });
      return send(res, 200, { ok: true });
    }
  }

  if (url.pathname === "/api/admin/products/import" && method === "POST") {
    if (!requireUser(req, res, "admin")) return;
    const body = await readBody(req);
    const items = Array.isArray(body.items) ? body.items.slice(0, 2000) : [];
    if (!items.length) return send(res, 400, { error: "Nenhum produto valido para importar." });

    let imported = 0;
    await tx(async (client) => {
      for (const item of items) {
        const sku = normalizeText(item.sku, 60).toUpperCase();
        const nome = normalizeText(item.nome, 160).toUpperCase();
        const categoria = normalizeText(item.categoria, 120).toUpperCase() || null;
        if (!sku || !nome) continue;
        await client.query(
          `INSERT INTO produtos (sku, nome, qtd_total, estoque_central, ativo, categoria, origem)
           VALUES ($1, $2, $3, $3, $4, $5, 'omie')
           ON CONFLICT (sku) DO UPDATE SET
             nome = EXCLUDED.nome,
             qtd_total = EXCLUDED.qtd_total,
             estoque_central = EXCLUDED.estoque_central,
             ativo = EXCLUDED.ativo,
             categoria = EXCLUDED.categoria,
             origem = 'omie'`,
          [sku, nome, asInt(item.qtd_total), item.ativo !== false, categoria]
        );
        if (categoria) {
          await client.query(
            `INSERT INTO categorias (nome)
             VALUES ($1)
             ON CONFLICT (nome) DO NOTHING`,
            [categoria]
          );
        }
        if (item.ativo === false) {
          await client.query("UPDATE estoque_pdv SET permitido = FALSE WHERE sku_produto = $1", [sku]);
        }
        imported += 1;
      }
    });
    return send(res, 200, { ok: true, imported });
  }

  if (url.pathname === "/api/admin/pdvs") {
    if (!requireUser(req, res, "admin")) return;
    const body = method === "GET" ? {} : await readBody(req);
    if (method === "GET") {
      return send(res, 200, { pdvs: await query(`
        SELECT p.id, p.nome, p.codigo_orion, p.is_cozinha, p.categoria,
               COALESCE(ARRAY(
                 SELECT pc.categoria
                 FROM pdv_categorias pc
                 WHERE pc.pdv_id = p.id
                 ORDER BY pc.categoria
               ), '{}') AS categorias
        FROM pdvs p
        ORDER BY p.nome
      `) });
    }
    if (method === "POST") {
      const nome = normalizeText(body.nome, 120).toUpperCase();
      const senha = normalizeText(body.senha, 120);
      const categoria = normalizeText(body.categoria, 120).toUpperCase() || null;
      const categorias = normalizeCategories(body.categorias);
      if (!nome || !senha) return send(res, 400, { error: "Nome e senha sao obrigatorios." });
      const pdv = await query(
        `INSERT INTO pdvs (nome, senha, codigo_orion, is_cozinha, categoria)
         VALUES ($1, $2, $3, $4, $5)
         ON CONFLICT (nome) DO NOTHING
         RETURNING id`,
        [nome, hashPassword(senha), normalizeText(body.codigo_orion, 60) || null, false, categoria]
      );
      const pdvId = pdv[0]?.id;
      if (pdvId) {
        for (const category of categorias) {
          await query(
            `INSERT INTO categorias (nome)
             VALUES ($1)
             ON CONFLICT (nome) DO NOTHING`,
            [category]
          );
          await query(
            `INSERT INTO pdv_categorias (pdv_id, categoria)
             VALUES ($1, $2)
             ON CONFLICT (pdv_id, categoria) DO NOTHING`,
            [pdvId, category]
          );
        }
        await tx(async (client) => {
          await syncPdvAllowedProducts(client, pdvId);
        });
      }
      return send(res, 200, { ok: true });
    }
    if (method === "PATCH") {
      const pdvId = asInt(body.id);
      const categorias = normalizeCategories(body.categorias);
      const nome = normalizeText(body.nome, 120).toUpperCase();
      if (!pdvId || !nome) return send(res, 400, { error: "PDV invalido." });
      await query("UPDATE pdvs SET nome = $2, codigo_orion = $3, is_cozinha = $4, categoria = $5 WHERE id = $1", [
        pdvId,
        nome,
        normalizeText(body.codigo_orion, 60) || null,
        false,
        normalizeText(body.categoria, 120).toUpperCase() || null
      ]);
      const senha = normalizeText(body.senha, 120);
      if (senha) {
        await query("UPDATE pdvs SET senha = $2 WHERE id = $1", [pdvId, hashPassword(senha)]);
      }
      await tx(async (client) => {
        await client.query("DELETE FROM pdv_categorias WHERE pdv_id = $1", [pdvId]);
        for (const category of categorias) {
          await client.query(
            `INSERT INTO categorias (nome)
             VALUES ($1)
             ON CONFLICT (nome) DO NOTHING`,
            [category]
          );
          await client.query(
            `INSERT INTO pdv_categorias (pdv_id, categoria)
             VALUES ($1, $2)
             ON CONFLICT (pdv_id, categoria) DO NOTHING`,
            [pdvId, category]
          );
        }
        await syncPdvAllowedProducts(client, pdvId);
      });
      return send(res, 200, { ok: true });
    }
    if (method === "DELETE") {
      await query("DELETE FROM pdvs WHERE id = $1", [asInt(body.id)]);
      return send(res, 200, { ok: true });
    }
  }

  if (url.pathname === "/api/admin/categories") {
    if (!requireUser(req, res, "admin")) return;
    if (method === "GET") {
      const rows = await query(
        `SELECT trim(upper(c.nome)) AS nome,
                (SELECT COUNT(*)::int FROM produtos p WHERE trim(upper(COALESCE(p.categoria, ''))) = trim(upper(c.nome))) AS produtos,
                (SELECT COUNT(*)::int FROM pdv_categorias pc WHERE trim(upper(pc.categoria)) = trim(upper(c.nome))) AS pdvs
         FROM categorias c
         ORDER BY trim(upper(c.nome))`
      );
      const products = await query(
        `SELECT sku, nome, trim(upper(COALESCE(categoria, ''))) AS categoria, COALESCE(origem, 'manual') AS origem
         FROM produtos
         WHERE ativo = TRUE
         ORDER BY nome`
      );
      return send(res, 200, { categories: rows, products });
    }
    const body = await readBody(req);
    if (method === "POST") {
      const nome = normalizeText(body.nome, 120).toUpperCase();
      if (!nome) return send(res, 400, { error: "Nome da categoria e obrigatorio." });
      await query(
        `INSERT INTO categorias (nome)
         VALUES ($1)
         ON CONFLICT (nome) DO NOTHING`,
        [nome]
      );
      return send(res, 200, { ok: true });
    }
    if (method === "PATCH") {
      const atual = normalizeText(body.atual, 120).toUpperCase();
      const nome = normalizeText(body.nome, 120).toUpperCase();
      if (!atual || !nome) return send(res, 400, { error: "Categoria atual e novo nome sao obrigatorios." });
      await tx(async (client) => {
        await client.query("UPDATE categorias SET nome = $2 WHERE nome = $1", [atual, nome]);
        await client.query("UPDATE produtos SET categoria = $2 WHERE categoria = $1", [atual, nome]);
        await client.query("UPDATE pdv_categorias SET categoria = $2 WHERE categoria = $1", [atual, nome]);
        await client.query("UPDATE pdvs SET categoria = $2 WHERE categoria = $1", [atual, nome]);
      });
      return send(res, 200, { ok: true });
    }
    if (method === "DELETE") {
      const nome = normalizeText(body.nome, 120).toUpperCase();
      if (!nome) return send(res, 400, { error: "Nome da categoria e obrigatorio." });
      await tx(async (client) => {
        await client.query("DELETE FROM categorias WHERE nome = $1", [nome]);
        await client.query("UPDATE produtos SET categoria = NULL WHERE categoria = $1", [nome]);
        await client.query("DELETE FROM pdv_categorias WHERE categoria = $1", [nome]);
        await client.query("UPDATE pdvs SET categoria = NULL WHERE categoria = $1", [nome]);
      });
      return send(res, 200, { ok: true });
    }
  }

  if (url.pathname === "/api/admin/category-products" && method === "POST") {
    if (!requireUser(req, res, "admin")) return;
    const body = await readBody(req);
    const sku = normalizeText(body.sku, 60).toUpperCase();
    const categoria = normalizeText(body.categoria, 120).toUpperCase() || null;
    if (!sku) return send(res, 400, { error: "Produto invalido." });
    if (categoria) {
      await query(
        `INSERT INTO categorias (nome)
         VALUES ($1)
         ON CONFLICT (nome) DO NOTHING`,
        [categoria]
      );
    }
    await tx(async (client) => {
      await client.query("UPDATE produtos SET categoria = $2 WHERE sku = $1", [sku, categoria]);
      const pdvs = await client.query("SELECT id FROM pdvs");
      for (const pdv of pdvs.rows) {
        await syncPdvAllowedProducts(client, pdv.id);
      }
    });
    return send(res, 200, { ok: true });
  }

  if (url.pathname === "/api/admin/stock") {
    if (!requireUser(req, res, "admin")) return;
    const pdvId = asInt(url.searchParams.get("pdvId"));
    if (method === "GET") {
      const pdvRows = await query("SELECT id, nome, categoria, is_cozinha FROM pdvs WHERE id = $1", [pdvId]);
      const pdv = pdvRows[0] || null;
      const categoryRows = await query("SELECT categoria FROM pdv_categorias WHERE pdv_id = $1 ORDER BY categoria", [pdvId]);
      const categorias = categoryRows.map((row) => row.categoria);
      const rows = await query(
        `SELECT p.sku, p.nome, p.categoria, TRUE AS permitido, COALESCE(e.quantidade, 0) quantidade,
                COALESCE(e.estoque_minimo, 0) estoque_minimo, COALESCE(e.estoque_maximo, 0) estoque_maximo
         FROM produtos p
         LEFT JOIN estoque_pdv e ON e.sku_produto = p.sku AND e.pdv_id = $1
         WHERE (
           COALESCE(array_length($2::text[], 1), 0) > 0
           AND p.categoria = ANY($2::text[])
         )
         ORDER BY p.nome`,
        [pdvId, categorias]
      );
      return send(res, 200, { stock: rows, pdv: { ...pdv, categorias } });
    }
    if (method === "POST") {
      const body = await readBody(req);
      const items = Array.isArray(body.items) ? body.items : [];
      const categoryRows = await query("SELECT categoria FROM pdv_categorias WHERE pdv_id = $1 ORDER BY categoria", [asInt(body.pdvId)]);
      const categorias = categoryRows.map((row) => row.categoria);
      await tx(async (client) => {
        for (const item of items) {
          const product = await client.query("SELECT categoria FROM produtos WHERE sku = $1", [item.sku]);
          const permitido = categorias.includes(product.rows[0]?.categoria);
          await client.query(
            `INSERT INTO estoque_pdv (pdv_id, sku_produto, quantidade, estoque_minimo, estoque_maximo, permitido)
             VALUES ($1, $2, $3, $4, $5, $6)
             ON CONFLICT (pdv_id, sku_produto) DO UPDATE SET
               quantidade = EXCLUDED.quantidade,
               estoque_minimo = EXCLUDED.estoque_minimo,
               estoque_maximo = EXCLUDED.estoque_maximo,
               permitido = EXCLUDED.permitido`,
            [asInt(body.pdvId), item.sku, asInt(item.quantidade), asInt(item.estoque_minimo), asInt(item.estoque_maximo), permitido]
          );
        }
      });
      return send(res, 200, { ok: true });
    }
  }

  if (url.pathname === "/api/admin/orders") {
    if (!requireUser(req, res, "admin")) return;
    const from = url.searchParams.get("from");
    const to = url.searchParams.get("to");
    const rows = await query(
      `SELECT p.id, p.codigo_pedido, p.pdv_id, pd.nome AS pdv, p.solicitante, p.sku_produto, pr.nome AS produto,
              p.quantidade_solicitada, p.quantidade_liberada, p.status, p.observacao,
              pr.qtd_total AS saldo, e.estoque_minimo, e.estoque_maximo, p.criado_em, p.em_andamento_em, p.liberado_em
       FROM pedidos p
       JOIN pdvs pd ON pd.id = p.pdv_id
       JOIN produtos pr ON pr.sku = p.sku_produto
       LEFT JOIN estoque_pdv e ON e.pdv_id = p.pdv_id AND e.sku_produto = p.sku_produto
       WHERE ($1::date IS NULL OR p.criado_em::date >= $1::date)
         AND ($2::date IS NULL OR p.criado_em::date <= $2::date)
       ORDER BY p.criado_em ASC, p.id ASC`,
      [from || null, to || null]
    );
    return send(res, 200, { orders: rows });
  }

  if (url.pathname === "/api/admin/order-flow" && method === "POST") {
    if (!requireUser(req, res, "admin")) return;
    const body = await readBody(req);
    const nextStatus = ["Pendente", "Em Andamento", "Liberado"].includes(body.status) ? body.status : null;
    const items = Array.isArray(body.items) ? body.items : [];
    if (!nextStatus || !items.length) return send(res, 400, { error: "Status ou itens invalidos." });

    await tx(async (client) => {
      for (const item of items) {
        const old = await client.query("SELECT status, quantidade_liberada, pdv_id, sku_produto FROM pedidos WHERE id = $1", [asInt(item.id)]);
        if (!old.rows[0]) continue;
        const current = old.rows[0];
        if (item.remover) {
          if (current.status === "Liberado") {
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
        const qty = asInt(item.quantidade_liberada);

        const timeField = nextStatus === "Em Andamento" ? ", em_andamento_em = CURRENT_TIMESTAMP" : nextStatus === "Liberado" ? ", liberado_em = CURRENT_TIMESTAMP" : "";
        await client.query(
          `UPDATE pedidos SET status = $1, quantidade_liberada = $2 ${timeField} WHERE id = $3`,
          [nextStatus, qty, asInt(item.id)]
        );

        if (nextStatus === "Liberado") {
          const oldReleasedQty = current.status === "Liberado" ? asInt(current.quantidade_liberada) : 0;
          const delta = qty - oldReleasedQty;
          if (delta !== 0) {
            await client.query("UPDATE produtos SET qtd_total = qtd_total - $1 WHERE sku = $2", [delta, current.sku_produto]);
            if (current.status === "Liberado") {
              await client.query(
                "UPDATE estoque_pdv SET quantidade = GREATEST(0, quantidade + $1) WHERE pdv_id = $2 AND sku_produto = $3",
                [delta, current.pdv_id, current.sku_produto]
              );
            } else if (qty > 0) {
              await client.query(
                `INSERT INTO estoque_pdv (pdv_id, sku_produto, quantidade)
                 VALUES ($1, $2, $3)
                 ON CONFLICT (pdv_id, sku_produto) DO UPDATE SET quantidade = estoque_pdv.quantidade + $3`,
                [current.pdv_id, current.sku_produto, qty]
              );
            }
          }
        }

        if (nextStatus !== "Liberado" && current.status === "Liberado") {
          const oldQty = asInt(current.quantidade_liberada);
          await client.query("UPDATE produtos SET qtd_total = qtd_total + $1 WHERE sku = $2", [oldQty, current.sku_produto]);
          await client.query(
            "UPDATE estoque_pdv SET quantidade = GREATEST(0, quantidade - $1) WHERE pdv_id = $2 AND sku_produto = $3",
            [oldQty, current.pdv_id, current.sku_produto]
          );
        }
      }
    });
    return send(res, 200, { ok: true });
  }

  if (url.pathname === "/api/admin/orion") {
    if (!requireUser(req, res, "admin")) return;
    if (method === "POST") {
      const body = await readBody(req);
      const type = body.tipo_operacao === "DEVOLUCAO" ? "DEVOLUCAO" : "VENDA";
      await query(
        `INSERT INTO vendas_orion (pdv_id, sku_produto, quantidade_vendida, tipo_operacao, processado)
         VALUES ($1, $2, $3, $4, FALSE)`,
        [asInt(body.pdvId), normalizeText(body.sku, 60), asInt(body.quantidade, 1), type]
      );
      await processOrionAndAutoOrders();
      return send(res, 200, { ok: true });
    }
    const rows = await query(
      `SELECT v.id, pd.nome AS pdv, pr.nome AS produto, v.quantidade_vendida, v.tipo_operacao, v.data_venda, v.processado
       FROM vendas_orion v
       JOIN pdvs pd ON pd.id = v.pdv_id
       JOIN produtos pr ON pr.sku = v.sku_produto
       ORDER BY v.data_venda DESC
       LIMIT 200`
    );
    return send(res, 200, { events: rows });
  }

  if (url.pathname === "/api/admin/history") {
    if (!requireUser(req, res, "admin")) return;
    const pdvId = asInt(url.searchParams.get("pdvId"));
    const autoOnly = url.searchParams.get("auto") === "1";
    const rows = await query(
      `SELECT p.data_hora, p.codigo_pedido, pd.nome AS pdv, pr.nome AS produto,
              p.quantidade_solicitada, p.quantidade_liberada, p.status, p.solicitante
       FROM pedidos p
       JOIN pdvs pd ON pd.id = p.pdv_id
       JOIN produtos pr ON pr.sku = p.sku_produto
       WHERE ($1::int = 0 OR p.pdv_id = $1)
         AND ($2::boolean = FALSE OR p.codigo_pedido LIKE 'AUTO-%')
       ORDER BY p.data_hora DESC
       LIMIT 500`,
      [pdvId, autoOnly]
    );
    return send(res, 200, { history: rows });
  }

  if (url.pathname === "/api/admin/dashboard") {
    if (!requireUser(req, res, "admin")) return;
    const from = url.searchParams.get("from");
    const to = url.searchParams.get("to");
    const sku = normalizeText(url.searchParams.get("sku"), 60);
    const productSearch = normalizeText(url.searchParams.get("q"), 120);
    const productSearchLike = productSearch ? `%${productSearch}%` : null;
    const rows = await query(
      `SELECT pd.nome AS pdv, pr.sku, pr.nome AS produto, SUM(p.quantidade_solicitada)::int AS total
       FROM pedidos p
       JOIN pdvs pd ON pd.id = p.pdv_id
       JOIN produtos pr ON pr.sku = p.sku_produto
       WHERE ($1::date IS NULL OR p.data_hora::date >= $1::date)
         AND ($2::date IS NULL OR p.data_hora::date <= $2::date)
         AND ($3::text IS NULL OR pr.nome ILIKE $3 OR pr.sku ILIKE $3)
       GROUP BY pd.nome, pr.sku, pr.nome
       ORDER BY total DESC
       LIMIT 20`,
      [from || null, to || null, productSearchLike]
    );

    let selectedSku = sku || rows[0]?.sku || "";
    let selectedProduct = [];
    if (!selectedSku && productSearch) {
      selectedProduct = await query(
        `SELECT sku, nome
         FROM produtos
         WHERE sku ILIKE $1 OR nome ILIKE $2
         ORDER BY CASE WHEN sku ILIKE $1 THEN 0 ELSE 1 END, nome
         LIMIT 1`,
        [productSearch, productSearchLike]
      );
      selectedSku = selectedProduct[0]?.sku || "";
    }
    const productTrend = selectedSku ? await query(
      `SELECT to_char(months.month_start, 'YYYY-MM') AS mes,
              COALESCE(SUM(p.quantidade_solicitada), 0)::int AS total
       FROM generate_series(
         date_trunc('month', CURRENT_DATE) - INTERVAL '5 months',
         date_trunc('month', CURRENT_DATE),
         INTERVAL '1 month'
       ) AS months(month_start)
       LEFT JOIN pedidos p
         ON p.sku_produto = $1
        AND date_trunc('month', p.data_hora) = months.month_start
       GROUP BY months.month_start
       ORDER BY months.month_start`,
      [selectedSku]
    ) : [];

    if (selectedSku && !selectedProduct[0]) {
      selectedProduct = await query("SELECT sku, nome FROM produtos WHERE sku = $1", [selectedSku]);
    }
    return send(res, 200, { ranking: rows, selectedProduct: selectedProduct[0] || null, productTrend });
  }

  if (url.pathname === "/api/admin/config" && method === "POST") {
    if (!requireUser(req, res, "admin")) return;
    const body = await readBody(req);
    if (body.adminPassword) {
      const currentPassword = normalizeText(body.currentAdminPassword, 120);
      const nextPassword = normalizeText(body.adminPassword, 120);
      const confirmPassword = normalizeText(body.confirmAdminPassword, 120);
      if (!currentPassword) return send(res, 400, { error: "Informe a senha atual do almoxarifado." });
      if (nextPassword.length < 4) return send(res, 400, { error: "A nova senha deve ter pelo menos 4 caracteres." });
      if (confirmPassword && nextPassword !== confirmPassword) return send(res, 400, { error: "A confirmacao da senha nao confere." });
      const rows = await query("SELECT valor FROM configuracoes WHERE chave = 'senha_almoxarifado'");
      if (!rows[0] || !verifyPassword(currentPassword, rows[0].valor)) return send(res, 401, { error: "Senha atual incorreta." });
      await query(
        `INSERT INTO configuracoes (chave, valor) VALUES ('senha_almoxarifado', $1)
         ON CONFLICT (chave) DO UPDATE SET valor = EXCLUDED.valor`,
        [hashPassword(nextPassword)]
      );
    }
    for (const key of ["omie_app_key", "omie_app_secret"]) {
      if (body[key] !== undefined) {
        await query(
          `INSERT INTO configuracoes (chave, valor) VALUES ($1, $2)
           ON CONFLICT (chave) DO UPDATE SET valor = EXCLUDED.valor`,
          [key, normalizeText(body[key], 300)]
        );
      }
    }
    return send(res, 200, { ok: true });
  }

  return send(res, 404, { error: "Rota nao encontrada." });
}

function serveStatic(req, res) {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const requested = url.pathname === "/" ? "/index.html" : decodeURIComponent(url.pathname);
  const file = path.normalize(path.join(publicDir, requested));
  if (!file.startsWith(publicDir)) {
    res.writeHead(403);
    return res.end("Forbidden");
  }
  fs.readFile(file, (error, content) => {
    if (error) {
      fs.readFile(path.join(publicDir, "index.html"), (fallbackError, fallback) => {
        if (fallbackError) {
          res.writeHead(404);
          return res.end("Not found");
        }
        res.writeHead(200, { "Content-Type": mime[".html"], "Cache-Control": "no-store" });
        res.end(fallback);
      });
      return;
    }
    res.writeHead(200, { "Content-Type": mime[path.extname(file)] || "application/octet-stream", "Cache-Control": "no-store" });
    res.end(content);
  });
}

let schemaReady;

function ensureSchemaOnce() {
  schemaReady ||= ensureSchema();
  return schemaReady;
}

export async function handler(req, res) {
  await ensureSchemaOnce();
  if (req.url?.startsWith("/api/")) {
    api(req, res).catch((error) => {
      console.error(error);
      send(res, 500, { error: error.message || "Erro interno." });
    });
  } else {
    serveStatic(req, res);
  }
}

export default handler;

if (!process.env.VERCEL) {
  http.createServer((req, res) => {
    handler(req, res).catch((error) => {
      console.error(error);
      send(res, 500, { error: error.message || "Erro interno." });
    });
  }).listen(port, () => {
    console.log(`MyEstoque web rodando em http://localhost:${port}`);
  });
}
