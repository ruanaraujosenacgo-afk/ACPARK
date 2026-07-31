import { beginLoading } from "../ui/loading.js";

export async function request(path, options = {}) {
  const { loadingMessage = "Carregando dados...", silentLoading = false, ...fetchOptions } = options;
  const stopLoading = silentLoading ? () => {} : beginLoading(loadingMessage);
  try {
    const response = await fetch(path, {
      credentials: "include",
      headers: { "Content-Type": "application/json", ...(fetchOptions.headers || {}) },
      ...fetchOptions
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) {
      const error = new Error(data.message || data.error || "Falha na operação.");
      error.status = response.status;
      error.code = data.error;
      error.details = data;
      throw error;
    }
    return data;
  } finally {
    stopLoading();
  }
}


