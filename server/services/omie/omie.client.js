import { getOmieConfig } from "./omie.config.js";
import { OmieConfigurationError, OmieRequestError, isRetryableOmieStatus } from "./omie.errors.js";

export async function callOmie(endpoint, payload, { fetchImpl = fetch, env = process.env } = {}) {
  const config = getOmieConfig(env);
  if (!config.configured) throw new OmieConfigurationError();

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), config.timeoutMs);
  const started = Date.now();
  try {
    const response = await fetchImpl(`${config.baseUrl}${endpoint}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        app_key: config.appKey,
        app_secret: config.appSecret,
        ...payload
      }),
      signal: controller.signal
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) {
      throw new OmieRequestError(data.faultstring || data.message || "Falha na comunicação com o OMIE.", {
        status: response.status,
        retryable: isRetryableOmieStatus(response.status),
        response: data
      });
    }
    return {
      data,
      elapsedMs: Date.now() - started
    };
  } catch (error) {
    if (error.name === "AbortError") {
      throw new OmieRequestError("Tempo limite ao comunicar com o OMIE.", { status: 408, retryable: true });
    }
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}
