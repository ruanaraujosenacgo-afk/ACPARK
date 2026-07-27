import crypto from "node:crypto";

export const OMIE_ENDPOINTS = Object.freeze({
  PRODUCTS: { endpoint: "/geral/produtos/", call: "ListarProdutos" },
  LOCATIONS: { endpoint: "/estoque/local/", call: "ListarLocaisEstoque" },
  STOCK: { endpoint: "/estoque/consulta/", call: "ListarPosEstoque" },
  MOVEMENTS: { endpoint: "/estoque/consulta/", call: "ListarMovimentoEstoque" }
});

function firstValue(source, keys, fallback = "") {
  for (const key of keys) {
    const value = source?.[key];
    if (value !== undefined && value !== null && String(value) !== "") return value;
  }
  return fallback;
}

function numberValue(value, fallback = 0) {
  const parsed = Number(String(value ?? "").replace(",", "."));
  return Number.isFinite(parsed) ? parsed : fallback;
}

function normalizeDateTime(value) {
  const text = String(value || "").trim();
  if (!text) return "";
  const br = text.match(/^(\d{2})\/(\d{2})\/(\d{4})(?:\s+(\d{2}:\d{2}(?::\d{2})?))?$/);
  if (br) return `${br[3]}-${br[2]}-${br[1]} ${br[4] || "00:00:00"}`;
  return text;
}

export function safeJson(value) {
  return JSON.stringify(value || {});
}

export function mapOmieProduct(item) {
  const info = item?.info || {};
  const externalId = String(firstValue(item, ["codigo_produto", "nCodProd", "id_prod", "id"], ""));
  const sku = String(firstValue(item, ["codigo", "cCodigo", "sku", "codigo_produto_integracao"], externalId));
  const updatedAt = firstValue(info, ["dAlt", "dInc"], firstValue(item, ["data_alteracao", "dAlt"], ""));
  const inactiveFlag = String(firstValue(item, ["inativo", "bloqueado"], "N")).toUpperCase();
  const activeFlag = String(firstValue(item, ["ativo"], "")).toUpperCase();
  return {
    externalId,
    sku,
    integrationCode: String(firstValue(item, ["codigo_produto_integracao", "cCodInt"], "")),
    description: String(firstValue(item, ["descricao", "cDescricao", "nome"], sku || externalId)),
    unit: String(firstValue(item, ["unidade", "cUnidade"], "UN")),
    family: String(firstValue(item, ["codigo_familia", "familia", "cFamilia"], "")),
    itemType: String(firstValue(item, ["tipoItem", "tipo_item", "cTipoItem"], "REVENDA")),
    active: activeFlag ? ["S", "SIM", "TRUE", "1", "ATIVO"].includes(activeFlag) : !["S", "SIM", "INATIVO", "I", "TRUE", "1"].includes(inactiveFlag),
    ean: String(firstValue(item, ["ean", "cEAN"], "")),
    ncm: String(firstValue(item, ["ncm", "cNCM"], "")),
    price: numberValue(firstValue(item, ["valor_unitario", "preco", "nValorUnitario"], 0)),
    stockControl: String(firstValue(item, ["controlar_estoque", "cControlarEstoque", "estoque"], "")),
    updatedAt: normalizeDateTime(updatedAt),
    raw: item
  };
}

export function mapOmieLocation(item) {
  const externalId = String(firstValue(item, ["codigo_local_estoque", "nCodLocal", "codLocal", "codigo", "id"], ""));
  const inactiveFlag = String(firstValue(item, ["inativo", "bloqueado"], "N")).toUpperCase();
  const activeFlag = String(firstValue(item, ["ativo"], "")).toUpperCase();
  return {
    externalId,
    code: String(firstValue(item, ["codigo", "cCodigo", "codigo_local_estoque", "nCodLocal"], externalId)),
    name: String(firstValue(item, ["descricao", "nome", "cDescricao", "cLocalEstoque"], externalId)),
    description: String(firstValue(item, ["observacao", "descricao_detalhada", "cObservacao"], "")),
    active: activeFlag ? ["S", "SIM", "TRUE", "1", "ATIVO"].includes(activeFlag) : !["S", "SIM", "INATIVO", "I", "TRUE", "1"].includes(inactiveFlag),
    company: String(firstValue(item, ["empresa", "filial", "cnpj"], "")),
    raw: item
  };
}

export function mapOmieStock(item, fallbackLocation = "") {
  const externalProductId = String(firstValue(item, ["codigo_produto", "nCodProd", "id_prod", "idProd"], ""));
  const locationId = String(firstValue(item, ["codigo_local_estoque", "nCodLocal", "codLocal"], fallbackLocation));
  return {
    externalProductId,
    locationId,
    quantity: numberValue(firstValue(item, ["saldo", "nSaldo", "estoque", "quantidade", "nSaldoAtual"], 0)),
    referenceDate: String(firstValue(item, ["dDataPosicao", "data", "data_posicao"], "")),
    raw: item
  };
}

export function deterministicMovementId(item) {
  const basis = [
    firstValue(item, ["codigo_movimento", "nCodMovEstoque", "id", "idMovimento", "idMov"], ""),
    firstValue(item, ["id_prod", "codigo_produto", "nCodProd", "idProd"], ""),
    firstValue(item, ["codigo_local_estoque", "nCodLocal"], ""),
    firstValue(item, ["data", "dDtMovimento", "dtMovimento"], ""),
    firstValue(item, ["tipo", "tipo_movimento", "cTipo"], ""),
    firstValue(item, ["quantidade", "nQtde", "nQuantidade"], ""),
    firstValue(item, ["documento", "cDocumento", "referencia", "cReferencia"], "")
  ].join("|");
  const explicit = String(firstValue(item, ["codigo_movimento", "nCodMovEstoque", "id", "idMovimento", "idMov"], ""));
  if (explicit) return explicit;
  return `DET-${crypto.createHash("sha256").update(basis).digest("hex").slice(0, 32)}`;
}

export function classifyOrigin(item) {
  const operacao = String(firstValue(item, ["operacao"], ""));
  const cancelamento = String(firstValue(item, ["cancelamento"], "")).toUpperCase() === "S";
  const devolucao = String(firstValue(item, ["devolucao"], "")).toUpperCase() === "S";
  if (operacao === "12" && cancelamento) return "ORION_CANCELAMENTO";
  if (operacao === "13" || devolucao) return "ORION_DEVOLUCAO";
  if (operacao === "12") return "ORION_VENDA";
  if (operacao === "28") return "OMIE_PRODUCAO";
  if (operacao === "00") return "OMIE_AJUSTE_MANUAL";
  const evidence = [
    firstValue(item, ["documento", "cDocumento"], ""),
    firstValue(item, ["referencia", "cReferencia", "external_reference"], ""),
    firstValue(item, ["descricao", "cDescricao", "observacao", "cObs"], ""),
    firstValue(item, ["origem", "codigo_origem", "cOrigem"], "")
  ].join(" ").toUpperCase();
  if (/ACPARK-PEDIDO|ACPARK_TRANSFERENCIA/.test(evidence)) return "ACPARK_TRANSFERENCIA";
  if (/ACPARK-DEVOLUCAO/.test(evidence)) return "ACPARK_DEVOLUCAO";
  if (/ACPARK-AVARIA|AVARIA ACPARK/.test(evidence)) return "ACPARK_AVARIA";
  if (/ORION/.test(evidence) && /CANCEL/.test(evidence)) return "ORION_CANCELAMENTO";
  if (/ORION/.test(evidence) && /DEVOL/.test(evidence)) return "ORION_DEVOLUCAO";
  if (/ORION/.test(evidence) && /VENDA|PEDIDO|CUPOM/.test(evidence)) return "ORION_VENDA";
  if (/PRODUC/.test(evidence)) return "OMIE_PRODUCAO";
  if (/AJUST/.test(evidence)) return "OMIE_AJUSTE_MANUAL";
  return "ORIGEM_NAO_IDENTIFICADA";
}

export function mapOmieMovement(item) {
  const quantity = numberValue(firstValue(item, ["quantidade", "nQtde", "nQuantidade", "qtde"], 0));
  const type = String(firstValue(item, ["tipo", "tipo_movimento", "cTipo"], quantity < 0 ? "S" : "E"));
  return {
    movementId: deterministicMovementId(item),
    externalProductId: String(firstValue(item, ["id_prod", "codigo_produto", "nCodProd", "idProd"], "")),
    locationId: String(firstValue(item, ["codigo_local_estoque", "nCodLocal"], "")),
    quantity,
    unit: String(firstValue(item, ["unidade", "cUnidade"], "UN")),
    operationType: /S|SAIDA|SAÍDA/i.test(type) ? "SAIDA" : "ENTRADA",
    originSystem: classifyOrigin(item),
    reference: String(firstValue(item, ["documento", "cDocumento", "referencia", "cReferencia", "numDoc", "numPedido"], "")),
    description: String(firstValue(item, ["descricao", "cDescricao", "observacao", "cObs", "desOrigem"], "")),
    movementDate: normalizeDateTime(firstValue(item, ["data", "dDtMovimento", "dtMovimento", "dtMov"], "")),
    raw: item
  };
}

export function extractItems(data, keys) {
  for (const key of keys) {
    const value = data?.[key];
    if (Array.isArray(value)) return value;
  }
  return [];
}

export function extractTotalPages(data) {
  return Number(data?.total_de_paginas || data?.nTotPaginas || data?.total_paginas || data?.total_de_páginas || 1) || 1;
}
