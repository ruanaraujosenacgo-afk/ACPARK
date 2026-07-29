function parseBrazilianDate(value) {
  const text = String(value || "").trim();
  const match = text.match(/^(\d{2})\/(\d{2})\/(\d{4})$/);
  if (!match) return null;
  return `${match[3]}-${match[2]}-${match[1]} 00:00:00`;
}

function parseQuantity(value) {
  const number = Number(String(value ?? 0).replace(",", "."));
  return Number.isFinite(number) ? number : 0;
}

export function mapOmieProduct(product = {}) {
  return {
    externalId: String(product.codigo_produto || product.id_prod || ""),
    sku: String(product.codigo || product.cod_int || product.codigo_produto || ""),
    name: product.descricao || product.nome || "",
    unit: product.unidade || product.codigo_unidade || "UN",
    updatedAt: parseBrazilianDate(product.info?.dAlt || product.data_alteracao)
  };
}

export function mapOmieStock(stock = {}) {
  return {
    productExternalId: String(stock.codigo_produto || stock.id_prod || ""),
    locationExternalId: String(stock.codigo_local_estoque || stock.local_estoque || ""),
    quantity: parseQuantity(stock.saldo ?? stock.quantidade ?? stock.qtd),
    raw: stock
  };
}

export function classifyOrigin(movement = {}) {
  const text = `${movement.referencia || ""} ${movement.origem || ""} ${movement.operacao || ""}`.toUpperCase();
  if (movement.cancelamento === "S" || text.includes("CANCEL")) return "ORION_CANCELAMENTO";
  if (movement.devolucao === "S" || text.includes("DEVOL")) return "ORION_DEVOLUCAO";
  if (text.includes("ORION") || String(movement.operacao || "") === "12") return "ORION_VENDA";
  if (text.includes("OMIE")) return "OMIE";
  return "ORIGEM_NAO_IDENTIFICADA";
}

export function mapOmieMovement(movement = {}) {
  const type = String(movement.tipo_movimento || movement.tipo || "").toUpperCase();
  return {
    productExternalId: String(movement.id_prod || movement.codigo_produto || ""),
    date: parseBrazilianDate(movement.data || movement.data_movimento),
    quantity: parseQuantity(movement.quantidade || movement.quan),
    operationType: type.startsWith("S") || type === "SAI" ? "SAIDA" : "ENTRADA",
    origin: classifyOrigin(movement),
    raw: movement
  };
}
