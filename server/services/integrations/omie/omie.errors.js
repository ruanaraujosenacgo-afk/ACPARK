export class OmieIntegrationError extends Error {
  constructor(message, { code = "OMIE_UNKNOWN_ERROR", category = "UNKNOWN", status = 500, retryable = false, response = null } = {}) {
    super(message);
    this.name = "OmieIntegrationError";
    this.code = code;
    this.category = category;
    this.status = status;
    this.retryable = retryable;
    this.response = response;
  }
}

export function classifyOmieError(error) {
  if (error instanceof OmieIntegrationError) return error;
  const message = String(error?.message || error || "Falha desconhecida no OMIE.");
  if (error?.name === "AbortError" || /timeout|tempo limite/i.test(message)) {
    return new OmieIntegrationError("Tempo limite ao comunicar com o OMIE.", {
      code: "OMIE_TIMEOUT",
      category: "TIMEOUT",
      status: 408,
      retryable: true
    });
  }
  if (/app_key|app_secret|credenc/i.test(message)) {
    return new OmieIntegrationError("Credenciais OMIE invalidas ou ausentes.", {
      code: "OMIE_AUTH_ERROR",
      category: "AUTH",
      status: 401,
      retryable: false
    });
  }
  return new OmieIntegrationError(message, {
    code: "OMIE_UNKNOWN_ERROR",
    category: "UNKNOWN",
    status: Number(error?.status || 500),
    retryable: Boolean(error?.retryable)
  });
}

export function errorStatusForJob(error) {
  const classified = classifyOmieError(error);
  if (classified.category === "AUTH") return "ERRO_AUTENTICACAO";
  if (classified.category === "CONFIG") return "ERRO_CONFIGURACAO";
  if (classified.category === "DATA") return "ERRO_DADOS";
  if (classified.retryable) return "ERRO_TEMPORARIO";
  return "ERRO_DADOS";
}

export function errorStatusForConnection(error) {
  const classified = classifyOmieError(error);
  if (classified.category === "AUTH") return "CREDENCIAIS_INVALIDAS";
  if (classified.category === "CONFIG") return "ENDPOINT_INVALIDO";
  if (classified.category === "TIMEOUT") return "TIMEOUT";
  if (classified.status === 429 || classified.code === "OMIE_LOCAL_RATE_LIMIT") return "LIMITE_EXCEDIDO";
  if (classified.retryable) return "INDISPONIVEL";
  return "ERRO_DESCONHECIDO";
}
