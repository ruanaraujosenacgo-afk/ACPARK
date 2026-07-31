export class OmieConfigurationError extends Error {
  constructor(message = "Integração OMIE não configurada.") {
    super(message);
    this.name = "OmieConfigurationError";
    this.retryable = false;
  }
}

export class OmieRequestError extends Error {
  constructor(message, { status = 0, retryable = false, response = null } = {}) {
    super(message);
    this.name = "OmieRequestError";
    this.status = status;
    this.retryable = retryable;
    this.response = response;
  }
}

export function isRetryableOmieStatus(status) {
  return [408, 429, 500, 502, 503, 504].includes(Number(status));
}
