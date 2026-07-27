function parseDelimited(text) {
  const firstLine = text.split(/\r?\n/, 1)[0] || "";
  const semicolons = (firstLine.match(/;/g) || []).length;
  const commas = (firstLine.match(/,/g) || []).length;
  const delimiter = text.includes("\t") ? "\t" : semicolons > commas ? ";" : ",";
  const rows = [];
  let row = [];
  let cell = "";
  let quoted = false;

  for (let i = 0; i < text.length; i += 1) {
    const char = text[i];
    const next = text[i + 1];
    if (char === '"' && quoted && next === '"') {
      cell += '"';
      i += 1;
    } else if (char === '"') {
      quoted = !quoted;
    } else if (char === delimiter && !quoted) {
      row.push(cell);
      cell = "";
    } else if ((char === "\n" || char === "\r") && !quoted) {
      if (char === "\r" && next === "\n") i += 1;
      row.push(cell);
      if (row.some((value) => String(value).trim())) rows.push(row);
      row = [];
      cell = "";
    } else {
      cell += char;
    }
  }
  row.push(cell);
  if (row.some((value) => String(value).trim())) rows.push(row);
  return rows;
}

function normalizeHeader(value) {
  return String(value || "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]/g, "");
}

function truthySheetValue(value) {
  return ["sim", "s", "true", "1", "ativo", "yes"].includes(String(value || "").trim().toLowerCase());
}

export function spreadsheetText(value) {
  const text = String(value ?? "").trim();
  return text ? `="${text.replace(/"/g, '""')}"` : "";
}

function normalizeImportedSku(value) {
  const text = String(value ?? "").trim();
  const formulaMatch = text.match(/^="(.*)"$/);
  return formulaMatch ? formulaMatch[1].replace(/""/g, '"') : text;
}

function parseProductsRows(rows) {
  if (rows.length < 2) return [];
  const headers = rows[0].map(normalizeHeader);
  const find = (...names) => headers.findIndex((header) => names.includes(header));
  const skuIndex = find("sku", "codigo", "codigoproduto");
  const nameIndex = find("produto", "nome", "nomeproduto", "descricao");
  const stockIndex = find("estoquecentral", "qtdtotal", "quantidade", "estoque");
  const activeIndex = find("ativo", "status");
  const categoryIndex = find("categoria", "categoriaproduto", "grupo");
  const originIndex = find("origem", "fonte", "integracao");
  if (skuIndex < 0 || nameIndex < 0) throw new Error("A planilha precisa ter as colunas SKU/Código e Produto.");

  return rows.slice(1).map((row) => ({
    sku: normalizeImportedSku(row[skuIndex]),
    nome: String(row[nameIndex] || "").trim(),
    qtd_total: Number.parseInt(String(row[stockIndex] || "0").replace(",", "."), 10) || 0,
    ativo: activeIndex >= 0 ? truthySheetValue(row[activeIndex]) : true,
    categoria: categoryIndex >= 0 ? String(row[categoryIndex] || "").trim() : "",
    origem: originIndex >= 0 ? String(row[originIndex] || "").trim().toLowerCase() : "manual"
  })).filter((item) => item.sku && item.nome);
}

function parseProductsSheet(text) {
  return parseProductsRows(parseDelimited(text));
}

export async function parseProductsFile(file) {
  const extension = file.name.split(".").pop()?.toLowerCase();
  if (["xlsx", "xls"].includes(extension)) {
    if (!window.XLSX) throw new Error("Leitor de Excel indisponível. Recarregue a página e tente novamente.");
    const buffer = await file.arrayBuffer();
    const workbook = window.XLSX.read(buffer, { type: "array", cellDates: false, raw: true });
    const sheet = workbook.Sheets[workbook.SheetNames[0]];
    const rows = window.XLSX.utils.sheet_to_json(sheet, { header: 1, raw: true, defval: "" });
    return parseProductsRows(rows);
  }
  return parseProductsSheet(await file.text());
}


