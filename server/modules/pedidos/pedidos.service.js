export const orderStatuses = ["Pendente", "Em Andamento", "Aguardando Retirada", "LiberaÃ§Ã£o Parcial", "Finalizado"];

const releasedOrderStatuses = new Set(["Aguardando Retirada", "LiberaÃ§Ã£o Parcial", "LiberaÃƒÂ§ÃƒÂ£o Parcial", "Finalizado", "Liberado Parcial", "Liberado"]);

export function isReleasedOrderStatus(status) {
  return releasedOrderStatuses.has(status) || releasedOrderStatuses.has(normalizeOrderStatus(status));
}

export function normalizeOrderStatus(status) {
  if (status === "Liberado") return "Finalizado";
  if (status === "Liberado Parcial" || status === "LiberaÃƒÂ§ÃƒÂ£o Parcial") return "LiberaÃ§Ã£o Parcial";
  return status || "Pendente";
}
