export const orderStatuses = ["Pendente", "Em Andamento", "Aguardando Retirada", "Finalizado"];

const releasedOrderStatuses = new Set(["Aguardando Retirada", "Liberação Parcial", "LiberaÃ§Ã£o Parcial", "Finalizado", "Liberado Parcial", "Liberado"]);

export function isReleasedOrderStatus(status) {
  return releasedOrderStatuses.has(status) || releasedOrderStatuses.has(normalizeOrderStatus(status));
}

export function normalizeOrderStatus(status) {
  if (status === "Liberado") return "Finalizado";
  if (status === "Liberado Parcial" || status === "Liberação Parcial" || status === "LiberaÃ§Ã£o Parcial") return "Aguardando Retirada";
  return status || "Pendente";
}
