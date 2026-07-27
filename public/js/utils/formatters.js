export const today = () => new Date().toISOString().slice(0, 10);

export const weekAgo = () => new Date(Date.now() - 7 * 86400000).toISOString().slice(0, 10);

export const monthsAgo = (months) => {
  const date = new Date();
  date.setMonth(date.getMonth() - months);
  return date.toISOString().slice(0, 10);
};

function parseDateValue(value) {
  if (!value) return null;
  if (value instanceof Date) return value;
  const text = String(value);
  if (/^\d{4}-\d{2}-\d{2}$/.test(text)) {
    const [year, month, day] = text.split("-").map(Number);
    return new Date(year, month - 1, day, 12);
  }
  const hasTimezone = /(?:Z|[+-]\d{2}:?\d{2})$/i.test(text);
  const hasTime = /[T\s]\d{2}:\d{2}/.test(text);
  return new Date(hasTime && !hasTimezone ? text.replace(" ", "T") : text);
}

export const moneyDate = (value) => {
  const date = parseDateValue(value);
  if (!date || Number.isNaN(date.getTime())) return "-";
  const dateOnly = typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value);
  return dateOnly
    ? date.toLocaleDateString("pt-BR", { timeZone: "America/Sao_Paulo" })
    : date.toLocaleString("pt-BR", { timeZone: "America/Sao_Paulo" });
};

export function monthLabel(value) {
  const [year, month] = String(value).split("-");
  return new Date(Number(year), Number(month) - 1, 1).toLocaleDateString("pt-BR", { month: "short", year: "2-digit" });
}

export function pendingReleaseQty(item) {
  return Math.max(Number(item.quantidade_solicitada || 0) - Number(item.quantidade_liberada || 0), 0);
}
