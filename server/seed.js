import "dotenv/config";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { pool, hashPassword, tx } from "./db.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const schema = fs.readFileSync(path.join(__dirname, "schema.sql"), "utf8");

const pdvs = [
  ["BAR PISCINA", "BAR-01", false, "BEBIDAS"],
  ["LANCHONETE", "LAN-01", false, "LANCHES"],
  ["COZINHA CENTRAL", "COZ-01", true, "COZINHA"]
];

const produtos = [
  ["REFRI-350", "REFRIGERANTE LATA 350ML", 240, "BEBIDAS"],
  ["AGUA-500", "AGUA MINERAL 500ML", 300, "BEBIDAS"],
  ["CERVEJA-350", "CERVEJA LATA 350ML", 180, "BEBIDAS"],
  ["SUCO-300", "SUCO NATURAL 300ML", 120, "BEBIDAS"],
  ["SALGADO-UND", "SALGADO ASSADO UND", 90, "LANCHES"]
];

async function seed() {
  await pool.query(schema);
  await tx(async (client) => {
    await client.query(
      `INSERT INTO configuracoes (chave, valor)
       VALUES ('senha_almoxarifado', $1)
       ON CONFLICT (chave) DO UPDATE SET valor = EXCLUDED.valor`,
      [hashPassword("admin123")]
    );

    for (const [nome, _codigoExterno, cozinha, categoria] of pdvs) {
      await client.query(
        `INSERT INTO pdvs (nome, senha, is_cozinha, categoria)
         VALUES ($1, $2, $3, $4)
         ON CONFLICT (nome) DO UPDATE SET is_cozinha = EXCLUDED.is_cozinha, categoria = EXCLUDED.categoria`,
        [nome, hashPassword("123456"), cozinha, categoria]
      );
    }

    for (const [sku, nome, qtd, categoria] of produtos) {
      await client.query(
        `INSERT INTO produtos (sku, nome, qtd_total, estoque_central, ativo, categoria, origem)
         VALUES ($1, $2, $3, $3, TRUE, $4, 'manual')
         ON CONFLICT (sku) DO UPDATE SET nome = EXCLUDED.nome, qtd_total = EXCLUDED.qtd_total, ativo = TRUE, categoria = EXCLUDED.categoria, origem = 'manual'`,
        [sku, nome, qtd, categoria]
      );
    }

    const pdvRows = await client.query("SELECT id FROM pdvs");
    for (const pdv of pdvRows.rows) {
      for (const [sku] of produtos) {
        await client.query(
          `INSERT INTO estoque_pdv (pdv_id, sku_produto, quantidade, estoque_minimo, estoque_maximo, permitido)
           VALUES ($1, $2, 8, 6, 24, TRUE)
           ON CONFLICT (pdv_id, sku_produto) DO UPDATE
           SET estoque_minimo = EXCLUDED.estoque_minimo,
               estoque_maximo = EXCLUDED.estoque_maximo,
               permitido = TRUE`,
          [pdv.id, sku]
        );
      }
    }
  });

  console.log("Seed concluido. Almoxarifado: admin123 | PDVs: 123456");
  await pool.end();
}

seed().catch(async (error) => {
  console.error(error);
  await pool.end();
  process.exit(1);
});
