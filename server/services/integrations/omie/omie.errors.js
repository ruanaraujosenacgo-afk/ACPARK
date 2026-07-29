export class OmieIntegrationError extends Error {
  constructor(message, { status = 500, retryable = false, details = null } = {}) {
    super(message);
    this.name = "OmieIntegrationError";
    this.status = status;
    this.retryable = retryable;
    this.details = details;
  }
}

export function isOmieCredentialError(data) {
  const message = String(data?.faultstring || data?.message || "").toLowerCase();
  return message.includes("app_key") || message.includes("app_secret") || message.includes("credencial");
}
