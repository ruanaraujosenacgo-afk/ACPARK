export function buildStockMovementPayload({
  operationKey,
  productSku,
  quantity,
  movementType,
  documentCode,
  pdvName,
  reason
}) {
  return {
    cCodIntMov: operationKey,
    cCodProduto: productSku,
    nQtde: Number(quantity),
    cTipoMovimento: movementType,
    cDocumento: documentCode,
    cObservacoes: [pdvName, reason].filter(Boolean).join(" | ")
  };
}
