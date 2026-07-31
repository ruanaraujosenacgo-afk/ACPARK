export function send(res, status, data, headers = {}) {
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8", ...headers });
  res.end(JSON.stringify(data));
}

export function readBody(req) {
  return new Promise((resolve, reject) => {
    let body = "";
    let tooLarge = false;
    req.on("data", (chunk) => {
      if (tooLarge) return;
      body += chunk;
      if (body.length > 8_000_000) {
        tooLarge = true;
        reject(new Error("Arquivo muito grande para importar de uma vez. Tente novamente em lotes menores."));
      }
    });
    req.on("end", () => {
      if (tooLarge) return;
      if (!body) return resolve({});
      try {
        resolve(JSON.parse(body));
      } catch {
        reject(new Error("JSON inválido."));
      }
    });
  });
}

export function normalizeText(value, max = 120) {
  return String(value || "").trim().slice(0, max);
}

export function normalizeCategories(values) {
  if (!Array.isArray(values)) return [];
  return [...new Set(values.map((value) => normalizeText(value, 120).toUpperCase()).filter(Boolean))];
}

export function normalizeCategoryList(value) {
  const values = Array.isArray(value) ? value : String(value || "").split(/[;,|]/);
  return normalizeCategories(values);
}


