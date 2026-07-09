const app = document.querySelector("#app");

const state = {
  user: null,
  pdvs: [],
  products: [],
  categories: [],
  cart: []
};

const today = () => new Date().toISOString().slice(0, 10);
const weekAgo = () => new Date(Date.now() - 7 * 86400000).toISOString().slice(0, 10);
const monthsAgo = (months) => {
  const date = new Date();
  date.setMonth(date.getMonth() - months);
  return date.toISOString().slice(0, 10);
};
const moneyDate = (value) => (value ? new Date(value).toLocaleString("pt-BR", { timeZone: "America/Sao_Paulo" }) : "-");
const esc = (value) => String(value ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

async function request(path, options = {}) {
  const response = await fetch(path, {
    credentials: "include",
    headers: { "Content-Type": "application/json", ...(options.headers || {}) },
    ...options
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error || "Falha na operacao.");
  return data;
}

function toast(message, type = "ok") {
  const el = document.createElement("div");
  el.className = `fixed bottom-4 right-4 z-50 rounded-lg px-4 py-3 text-white shadow-lg ${type === "error" ? "bg-red-600" : "bg-teal-700"}`;
  el.textContent = message;
  document.body.appendChild(el);
  setTimeout(() => el.remove(), 3200);
}

function shell(content, actions = "") {
  const role = state.user?.role;
  const displayName = role === "admin" ? "Almoxarifado" : state.user?.name;
  const items = role === "admin"
    ? [["dashboard", "Dashboard"], ["products", "Estoque central"], ["stock", "Estoque PDVs"], ["release", "Liberacao"], ["orion", "Vendas ORION"], ["history", "Historico"], ["auto", "Autopedidos"], ["config", "Config"]]
    : [["order", "Novo pedido"], ["mine", "Meus pedidos"], ["my-stock", "Meu estoque"]];

  app.innerHTML = `
    <div class="min-h-screen">
      <nav class="site-topbar sticky top-0 z-30">
        <div class="mx-auto flex max-w-7xl items-center justify-between gap-3 px-4 py-2">
          <div class="flex items-center gap-3">
            <div class="brand-logo" aria-label="Aguas Correntes Park"></div>
            <div class="hidden sm:block">
              <p class="eyebrow">Sistema interno</p>
              <h1 class="text-xl font-black text-[color:var(--ac-teal-dark)]">Gestao de Estoque</h1>
            </div>
          </div>
          <div class="menu-wrap">
            <button class="menu-toggle" id="menu-toggle" type="button" aria-label="Abrir menu" aria-expanded="false">
              <span></span>
              <span></span>
              <span></span>
            </button>
          </div>
        </div>
      </nav>
      <div class="sidebar-backdrop hidden" id="sidebar-backdrop"></div>
      <aside class="side-menu" id="nav-menu" aria-hidden="true">
        <div class="side-menu-head">
          <div>
            <p class="eyebrow">Menu</p>
            <h3 class="section-title text-xl font-black">Navegacao</h3>
          </div>
          <button class="side-close" id="side-close" type="button" aria-label="Fechar menu">×</button>
        </div>
        <div class="side-user">
          <span>Conectado</span>
          <strong>${esc(displayName)}</strong>
        </div>
        <div class="side-menu-list">
          ${items.map(([id, label]) => `<button class="side-link nav-btn" data-view="${id}">${label}</button>`).join("")}
        </div>
        <button class="btn danger side-logout" id="logout">Sair</button>
      </aside>
      <section class="app-hero">
        <div class="relative z-10 mx-auto max-w-7xl px-4 py-8 md:py-12">
          <p class="text-sm font-black uppercase tracking-widest text-orange-200">Almoxarifado e pontos de venda</p>
          <h2 class="mt-2 max-w-2xl text-3xl font-black leading-tight md:text-5xl">Controle o abastecimento do parque com a fluidez do AC Park.</h2>
          <p class="mt-3 max-w-2xl text-white/90">Pedidos, liberacoes, estoque por PDV, ORION e OMIE reunidos em uma experiencia responsiva.</p>
        </div>
      </section>
      <main class="mx-auto max-w-7xl px-4 py-5">
        <div class="mb-4 flex flex-col gap-2 md:flex-row md:items-end md:justify-between">
          <div>
            <p class="eyebrow">Conectado como</p>
            <h2 class="section-title text-2xl font-black">${esc(displayName)}</h2>
          </div>
          <div class="page-actions no-print">${actions}</div>
        </div>
        ${content}
      </main>
    </div>`;

  const menuToggle = document.querySelector("#menu-toggle");
  const sideClose = document.querySelector("#side-close");
  const backdrop = document.querySelector("#sidebar-backdrop");
  const navMenu = document.querySelector("#nav-menu");

  const closeMenu = () => {
    navMenu.classList.remove("is-open");
    navMenu.setAttribute("aria-hidden", "true");
    backdrop.classList.add("hidden");
    menuToggle.classList.remove("is-open");
    menuToggle.setAttribute("aria-expanded", "false");
  };

  const openMenu = () => {
    navMenu.classList.add("is-open");
    navMenu.setAttribute("aria-hidden", "false");
    backdrop.classList.remove("hidden");
    menuToggle.classList.add("is-open");
    menuToggle.setAttribute("aria-expanded", "true");
  };

  menuToggle.addEventListener("click", () => {
    const isOpen = navMenu.classList.contains("is-open");
    if (isOpen) closeMenu();
    else openMenu();
  });
  sideClose.addEventListener("click", closeMenu);
  backdrop.addEventListener("click", closeMenu);

  document.querySelectorAll(".nav-btn").forEach((btn) => btn.addEventListener("click", () => {
    closeMenu();
    route(btn.dataset.view);
  }));
  document.querySelector("#logout").addEventListener("click", async () => {
    await request("/api/auth/logout", { method: "POST" });
    state.user = null;
    renderLogin();
  });
}

async function loadBootstrap() {
  const data = await request("/api/bootstrap");
  state.user = data.user;
  state.pdvs = data.pdvs;
  state.products = data.products;
  state.categories = (data.categories || []).map((item) => item.nome);
}

async function renderLogin() {
  const publicPdvs = await request("/api/public/pdvs").catch(() => ({ pdvs: [] }));
  app.innerHTML = `
    <main class="login-shell grid min-h-screen place-items-center px-4 py-8">
      <section class="login-card w-full max-w-5xl overflow-hidden">
        <div class="grid md:grid-cols-[1fr_0.85fr]">
          <div class="relative min-h-[320px] bg-[linear-gradient(90deg,rgba(0,63,72,.72),rgba(0,123,135,.2)),var(--ac-hero)] bg-cover bg-center p-8 text-white">
            <div class="brand-logo mb-8 rounded-3xl bg-white/95 p-4 shadow-xl"></div>
            <p class="text-sm font-black uppercase tracking-widest text-orange-200">ACPark Gestao</p>
            <h1 class="mt-2 text-4xl font-black leading-tight md:text-5xl">Abastecimento com controle de ponta a ponta.</h1>
            <p class="mt-4 max-w-md text-white/90">PDVs solicitam, Almoxarifado libera e o estoque acompanha vendas, devolucoes e reposicoes automaticas.</p>
          </div>
          <div class="p-6 md:p-8">
        <p class="eyebrow">Acesso protegido</p>
        <h2 class="section-title mt-1 text-3xl font-black">Entrar no sistema</h2>
        <p class="mt-2 text-slate-600">Use o perfil do PDV ou o acesso do Almoxarifado para continuar.</p>
        <form id="login-form" class="mt-6 grid gap-4">
          <label class="grid gap-1 text-sm font-bold">Perfil
            <select name="profile" id="profile">
              <option value="pdv">PDV</option>
              <option value="admin">Almoxarifado</option>
            </select>
          </label>
          <label class="grid gap-1 text-sm font-bold" id="pdv-field">Ponto de venda
            <select name="pdvId">${publicPdvs.pdvs.map((p) => `<option value="${p.id}">${esc(p.nome)}</option>`).join("")}</select>
          </label>
          <label class="grid gap-1 text-sm font-bold">Senha
            <input name="password" type="password" required />
          </label>
          <button class="btn" type="submit">Entrar</button>
        </form>
        <p class="mt-4 text-sm text-slate-500">Seed de teste: Almoxarifado <b>admin123</b>, PDVs <b>123456</b>.</p>
          </div>
        </div>
      </section>
    </main>`;

  document.querySelector("#profile").addEventListener("change", (event) => {
    document.querySelector("#pdv-field").style.display = event.target.value === "admin" ? "none" : "grid";
  });

  document.querySelector("#login-form").addEventListener("submit", async (event) => {
    event.preventDefault();
    const form = Object.fromEntries(new FormData(event.currentTarget));
    try {
      const data = await request("/api/auth/login", { method: "POST", body: JSON.stringify(form) });
      state.user = data.user;
      await loadBootstrap();
      route(state.user.role === "admin" ? "dashboard" : "order");
    } catch (error) {
      toast(error.message, "error");
    }
  });
}

function statusPill(status) {
  return `<span class="status ${esc(status).replace(/\s+/g, "-")}">${esc(status)}</span>`;
}

function monthLabel(value) {
  const [year, month] = String(value).split("-");
  return new Date(Number(year), Number(month) - 1, 1).toLocaleDateString("pt-BR", { month: "short", year: "2-digit" });
}

function table(headers, rows) {
  return `<div class="table-wrap"><table><thead><tr>${headers.map((h) => `<th>${h}</th>`).join("")}</tr></thead><tbody>${rows.join("") || `<tr><td colspan="${headers.length}">Nenhum registro encontrado.</td></tr>`}</tbody></table></div>`;
}

function csvEscape(value) {
  const text = String(value ?? "");
  return /[",\n\r;]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

function downloadCsv(filename, rows) {
  const csv = rows.map((row) => row.map(csvEscape).join(";")).join("\n");
  const blob = new Blob([`\uFEFF${csv}`], { type: "text/csv;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
}

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

function spreadsheetText(value) {
  const text = String(value ?? "").trim();
  return text ? `="${text.replace(/"/g, '""')}"` : "";
}

function normalizeImportedSku(value) {
  const text = String(value ?? "").trim();
  const formulaMatch = text.match(/^="(.*)"$/);
  return formulaMatch ? formulaMatch[1].replace(/""/g, '"') : text;
}

function categoryOptions() {
  return [...new Set(state.categories.map((category) => String(category || "").trim()).filter(Boolean))].sort();
}

function parseProductsSheet(text) {
  const rows = parseDelimited(text);
  if (rows.length < 2) return [];
  const headers = rows[0].map(normalizeHeader);
  const find = (...names) => headers.findIndex((header) => names.includes(header));
  const skuIndex = find("sku", "codigo", "codigoproduto");
  const nameIndex = find("produto", "nome", "nomeproduto", "descricao");
  const stockIndex = find("estoquecentral", "qtdtotal", "quantidade", "estoque");
  const activeIndex = find("ativo", "status");
  const categoryIndex = find("categoria", "categoriaproduto", "grupo");
  if (skuIndex < 0 || nameIndex < 0) throw new Error("A planilha precisa ter as colunas SKU e Produto.");

  return rows.slice(1).map((row) => ({
    sku: normalizeImportedSku(row[skuIndex]),
    nome: String(row[nameIndex] || "").trim(),
    qtd_total: Number.parseInt(String(row[stockIndex] || "0").replace(",", "."), 10) || 0,
    ativo: activeIndex >= 0 ? truthySheetValue(row[activeIndex]) : true,
    categoria: categoryIndex >= 0 ? String(row[categoryIndex] || "").trim() : ""
  })).filter((item) => item.sku && item.nome);
}

async function route(view) {
  try {
    await loadBootstrap();
    const views = {
      order: viewOrder,
      mine: viewMine,
      "my-stock": viewMyStock,
      dashboard: viewDashboard,
      products: viewProductsV2,
      stock: viewStock,
      release: viewRelease,
      orion: viewOrion,
      history: () => viewHistory(false),
      auto: () => viewHistory(true),
      config: viewConfigV2
    };
    await views[view]();
  } catch (error) {
    toast(error.message, "error");
    if (error.message.includes("Login")) renderLogin();
  }
}

async function viewOrder() {
  const data = await request("/api/pdv/products");
  const productLabel = (product) => `${product.sku} - ${product.nome}`;
  const productSearch = (product) => `${product.sku} ${product.nome} ${product.categoria || ""}`.toLowerCase();
  shell(`
    <section class="order-screen">
      <section class="card order-main-card">
        <div class="mb-3">
          <p class="eyebrow">Solicitacao</p>
          <h3 class="section-title text-xl font-black">Novo pedido</h3>
        </div>

        <div class="order-top-grid">
          <div class="order-form-area">
            <div class="order-info-grid">
              <label class="grid gap-1 text-sm font-bold">Solicitante <input name="solicitante" id="solicitante" required /></label>
              <label class="grid gap-1 text-sm font-bold">Observacao <textarea name="observacao" id="observacao" rows="3"></textarea></label>
            </div>

            <section class="category-settings order-add-panel">
              <div>
                <p class="eyebrow">Adicionar produto</p>
                <h4>Adicionar ao pedido</h4>
              </div>
              <div class="category-product-tools order-product-tools">
                <div class="category-product-picker">
                  <label class="category-add-label" for="order-product-search">Produto</label>
                  <input id="order-product-search" class="category-add-product-search" type="search" placeholder="Digite o nome ou SKU do produto" autocomplete="off" />
                  <input id="order-product-sku" type="hidden" />
                  <div class="category-product-suggestions hidden" id="order-product-suggestions">
                    ${data.products.map((product) => `
                      <button class="category-product-suggestion order-product-suggestion" type="button" data-sku="${esc(product.sku)}" data-label="${esc(productLabel(product))}" data-search="${esc(productSearch(product))}">
                        <strong>${esc(product.nome)}</strong>
                        <span>${esc(product.sku)} | ${esc(product.categoria || "-")} | atual ${product.quantidade} | max ${product.estoque_maximo}</span>
                      </button>`).join("") || `<p class="text-sm text-slate-500">Nenhum produto liberado para este PDV.</p>`}
                  </div>
                </div>
                <input id="order-product-quantity" type="number" min="1" value="1" aria-label="Quantidade" />
                <button class="btn secondary" id="add-order-product" type="button">Adicionar</button>
              </div>
            </section>

            <div class="category-product-list order-cart-list">
              <div class="category-product-list-head">
                <strong>Carrinho</strong>
              </div>
              <div id="cart"></div>
              <button class="btn mt-3 w-full" id="send-order">Enviar pedido</button>
            </div>
          </div>
        </div>
      </section>

      <section class="card category-product-list order-available-card">
        <div class="category-product-list-head">
          <strong>Produtos disponiveis</strong>
          <input class="category-product-search" id="available-product-search" type="search" placeholder="Pesquisar produto" />
        </div>
        <div class="category-product-table" id="available-products"></div>
      </section>
    </section>`);

  const addProductToCart = (sku, quantidade = 1) => {
    const product = data.products.find((item) => item.sku === sku);
    const qty = Number(quantidade);
    if (!product || !Number.isFinite(qty) || qty <= 0) return;
    const existing = state.cart.find((item) => item.sku === sku);
    if (existing) existing.quantidade += qty;
    else state.cart.push({ sku, nome: product.nome, quantidade: qty });
  };
  const renderAvailableProducts = () => {
    document.querySelector("#available-products").innerHTML = data.products.length
      ? table(["SKU", "Produto", "Categoria", "Atual", "Max", "Acao"], data.products.map((product) => `
        <tr class="available-product-row" data-search="${esc(productSearch(product))}">
          <td>${esc(product.sku)}</td>
          <td>${esc(product.nome)}</td>
          <td>${esc(product.categoria || "-")}</td>
          <td>${product.quantidade}</td>
          <td>${product.estoque_maximo}</td>
          <td><button class="icon-action add-available-product" type="button" data-sku="${esc(product.sku)}" title="Adicionar produto" aria-label="Adicionar produto">+</button></td>
        </tr>`))
      : `<p class="text-sm text-slate-500">Nenhum produto disponivel para este PDV.</p>`;
    document.querySelectorAll(".add-available-product").forEach((button) => button.addEventListener("click", () => {
      addProductToCart(button.dataset.sku, 1);
      renderCart();
    }));
  };
  const renderCart = () => {
    document.querySelector("#cart").innerHTML = state.cart.length
      ? table(["Produto", "Qtd", "Acao"], state.cart.map((item, index) => `
        <tr class="order-cart-row">
          <td>${esc(item.nome)}</td>
          <td><input class="order-cart-qty" type="number" min="1" value="${item.quantidade}" data-index="${index}" /></td>
          <td><button class="icon-action danger remove" type="button" data-index="${index}" title="Remover produto" aria-label="Remover produto">&times;</button></td>
        </tr>`))
      : `<p class="text-sm text-slate-500">Nenhum produto adicionado ainda.</p>`;
    document.querySelectorAll(".order-cart-qty").forEach((input) => input.addEventListener("input", () => {
      const qty = Number(input.value);
      if (Number.isFinite(qty) && qty > 0) state.cart[Number(input.dataset.index)].quantidade = qty;
    }));
    document.querySelectorAll(".remove").forEach((btn) => btn.addEventListener("click", () => {
      state.cart.splice(Number(btn.dataset.index), 1);
      renderCart();
    }));
  };
  renderAvailableProducts();
  renderCart();

  document.querySelector("#available-product-search").addEventListener("input", (event) => {
    const term = String(event.target.value || "").trim().toLowerCase();
    document.querySelectorAll(".available-product-row").forEach((row) => {
      row.classList.toggle("hidden", term && !row.dataset.search.includes(term));
    });
  });

  const orderProductSearch = document.querySelector("#order-product-search");
  const orderProductSku = document.querySelector("#order-product-sku");
  const orderSuggestions = document.querySelector("#order-product-suggestions");
  const filterOrderSuggestions = () => {
    const term = String(orderProductSearch.value || "").trim().toLowerCase();
    let visible = 0;
    if (orderProductSearch.dataset.selectedLabel !== orderProductSearch.value) {
      orderProductSku.value = "";
    }
    document.querySelectorAll(".order-product-suggestion").forEach((item) => {
      const show = term.length > 0 && item.dataset.search.includes(term);
      item.classList.toggle("hidden", !show);
      if (show) visible += 1;
    });
    orderSuggestions.classList.toggle("hidden", term.length === 0 || visible === 0);
    if (!term) orderProductSku.value = "";
  };
  orderProductSearch.addEventListener("input", filterOrderSuggestions);
  document.querySelectorAll(".order-product-suggestion").forEach((item) => item.addEventListener("click", () => {
    orderProductSearch.value = item.dataset.label || "";
    orderProductSearch.dataset.selectedLabel = orderProductSearch.value;
    orderProductSku.value = item.dataset.sku || "";
    orderSuggestions.classList.add("hidden");
  }));
  document.querySelector("#add-order-product").addEventListener("click", () => {
    addProductToCart(orderProductSku.value, document.querySelector("#order-product-quantity").value);
    orderProductSearch.value = "";
    orderProductSearch.dataset.selectedLabel = "";
    orderProductSku.value = "";
    document.querySelector("#order-product-quantity").value = 1;
    orderSuggestions.classList.add("hidden");
    renderCart();
  });

  document.querySelector("#send-order").addEventListener("click", async () => {
    try {
      await request("/api/pdv/order", {
        method: "POST",
        body: JSON.stringify({
          solicitante: document.querySelector("#solicitante").value,
          observacao: document.querySelector("#observacao").value,
          items: state.cart
        })
      });
      state.cart = [];
      toast("Pedido enviado para o Almoxarifado.");
      route("mine");
    } catch (error) {
      toast(error.message, "error");
    }
  });
}

async function viewMine(filters = {}) {
  const from = filters.from || weekAgo();
  const to = filters.to || today();
  const activeStatus = filters.status || "Pendente";
  const statuses = ["Pendente", "Em Andamento", "Liberado"];
  const statusLabels = { Pendente: "Pendentes", "Em Andamento": "Em andamento", Liberado: "Liberados" };
  const data = await request(`/api/pdv/orders?from=${from}&to=${to}`);
  const released = data.orders.filter((order) => order.status === "Liberado");
  const grouped = Object.values(data.orders.reduce((acc, row) => {
    acc[row.codigo_pedido] ||= [];
    acc[row.codigo_pedido].push(row);
    return acc;
  }, {}));
  const byStatus = statuses.reduce((acc, status) => {
    acc[status] = grouped.filter((group) => group[0]?.status === status);
    return acc;
  }, {});
  const visibleGroups = byStatus[activeStatus] || [];
  shell(`
    ${released.length ? `
      <section class="release-alert card">
        <p class="eyebrow">Pedido liberado</p>
        <h3 class="section-title text-xl font-black">Seu ponto tem ${released.length} pedido(s) liberado(s)</h3>
        <p class="text-sm text-slate-500">Ultimo: pedido ${esc(released[0].codigo_pedido)} em ${moneyDate(released[0].liberado_em || released[0].data_hora)}.</p>
      </section>` : ""}
    <section class="release-screen">
      <section class="card">
        <form id="mine-filter" class="dash-filter">
          <div>
            <p class="eyebrow">Filtro</p>
            <h3 class="section-title text-xl font-black">Meus pedidos</h3>
          </div>
          <label>De
            <input name="from" type="date" value="${esc(from)}" />
          </label>
          <label>Ate
            <input name="to" type="date" value="${esc(to)}" />
          </label>
          <button class="btn" type="submit">Filtrar</button>
        </form>
      </section>
      <div class="config-tabs release-tabs" role="tablist" aria-label="Status dos meus pedidos">
        ${statuses.map((status) => `
          <button class="config-tab ${status === activeStatus ? "is-active" : ""}" type="button" data-mine-status="${esc(status)}" role="tab" aria-selected="${status === activeStatus ? "true" : "false"}">
            ${esc(statusLabels[status] || status)} <span>${byStatus[status].length}</span>
          </button>`).join("")}
      </div>
      <section class="grid gap-4">
        ${visibleGroups.map((group) => pdvOrderCard(group)).join("") || `<div class="card">Nao ha pedidos ${esc(activeStatus.toLowerCase())} no periodo.</div>`}
      </section>
    </section>`);
  document.querySelector("#mine-filter").addEventListener("submit", async (event) => {
    event.preventDefault();
    const form = Object.fromEntries(new FormData(event.currentTarget));
    await viewMine({ ...form, status: activeStatus });
  });
  document.querySelectorAll("[data-mine-status]").forEach((button) => button.addEventListener("click", async () => {
    await viewMine({ from, to, status: button.dataset.mineStatus });
  }));
  bindOrderToggles();
  if (released.length) toast(`Pedido ${released[0].codigo_pedido} liberado para retirada.`);
}

function pdvOrderCard(group) {
  const first = group[0];
  const statusTime = first.status === "Pendente"
    ? `Pendente desde ${moneyDate(first.data_hora)}`
    : first.status === "Em Andamento"
      ? `Em andamento desde ${moneyDate(first.em_andamento_em || first.data_hora)}`
      : `Liberado em ${moneyDate(first.liberado_em || first.data_hora)}`;
  return `<article class="card order-accordion" data-order="${esc(first.codigo_pedido)}">
    <button class="order-accordion-head" type="button" data-toggle-order aria-expanded="false">
      <span class="order-arrow">&#9662;</span>
      <span>
        <strong>Pedido ${esc(first.codigo_pedido)}</strong>
        <small>${esc(statusTime)}</small>
      </span>
      ${statusPill(first.status)}
    </button>
    <div class="order-accordion-body hidden">
      ${first.observacao ? `<p class="mb-3 rounded bg-amber-50 p-2 text-sm text-amber-900">${esc(first.observacao)}</p>` : ""}
      ${table(["Produto", "Solicitado", "Liberado"], group.map((o) => `
        <tr>
          <td>${esc(o.produto)}</td>
          <td>${o.quantidade_solicitada}</td>
          <td>${o.quantidade_liberada}</td>
        </tr>`))}
    </div>
  </article>`;
}

async function viewMyStock() {
  const data = await request("/api/pdv/products");
  shell(`<section class="card"><h3 class="text-xl font-black">Meu estoque</h3>${table(["Produto", "Qtd", "Min", "Max"], data.products.map((p) => `<tr><td>${esc(p.nome)}</td><td>${p.quantidade}</td><td>${p.estoque_minimo}</td><td>${p.estoque_maximo}</td></tr>`))}</section>`);
}

async function viewDashboard(filters = {}) {
  const from = filters.from || monthsAgo(6);
  const to = filters.to || today();
  const sku = filters.sku || "";
  const q = filters.q || "";
  const params = new URLSearchParams({ from, to });
  if (sku) params.set("sku", sku);
  if (q) params.set("q", q);
  const data = await request(`/api/admin/dashboard?${params.toString()}`);
  const max = Math.max(...data.ranking.map((r) => r.total), 1);
  const trendMax = Math.max(...data.productTrend.map((r) => r.total), 1);
  shell(`
    <section class="card mb-4">
      <form id="dash-filter" class="dash-filter">
        <div>
          <p class="eyebrow">Filtro</p>
          <h3 class="section-title text-xl font-black">Pedidos e produto</h3>
        </div>
        <label>Produto
          <input name="q" type="search" list="dashboard-products" value="${esc(q)}" placeholder="Pesquisar produto" autocomplete="off" />
          <datalist id="dashboard-products">
            ${state.products.map((p) => `<option value="${esc(p.nome)}">${esc(p.sku)}</option>`).join("")}
          </datalist>
        </label>
        <label>De
          <input name="from" type="date" value="${esc(from)}" />
        </label>
        <label>Ate
          <input name="to" type="date" value="${esc(to)}" />
        </label>
        <button class="btn" type="submit">Filtrar</button>
      </form>
    </section>
    <section class="grid gap-4 md:grid-cols-3">
      <div class="card metric-card"><p class="eyebrow">PDVs</p><b class="section-title text-3xl">${state.pdvs.length}</b></div>
      <div class="card metric-card"><p class="eyebrow">Produtos</p><b class="section-title text-3xl">${state.products.length}</b></div>
      <div class="card metric-card"><p class="eyebrow">Ativos</p><b class="section-title text-3xl">${state.products.filter((p) => p.ativo).length}</b></div>
    </section>
    <section class="mt-4 grid gap-4 xl:grid-cols-[1fr_420px]">
      <div class="card print-ranking-area">
        <div class="print-logo-header">
          <img src="/logo-print.png" alt="Aguas Correntes Park" />
          <div>
            <p class="eyebrow">Aguas Correntes Park</p>
            <h2 class="section-title text-xl font-black">Ranking de produtos</h2>
          </div>
        </div>
        <div class="flex flex-col gap-1 sm:flex-row sm:items-end sm:justify-between">
          <div>
            <p class="eyebrow">Ranking</p>
            <h3 class="section-title text-xl font-black">Produtos mais pedidos</h3>
          </div>
          <p class="text-sm font-bold text-[color:var(--ac-teal-dark)]">${q ? `Pesquisa: ${esc(q)}` : "Clique em um produto para ver os ultimos meses"}</p>
        </div>
        <div class="mt-4 grid gap-3">
          ${data.ranking.map((r) => `<button class="rank-item product-trend-btn ${data.selectedProduct?.sku === r.sku ? "is-selected" : ""}" data-sku="${esc(r.sku)}">
            <div class="flex justify-between gap-3 text-sm font-bold"><span>${esc(r.produto)} - ${esc(r.pdv)}</span><span>${r.total}</span></div>
            <div class="h-3 rounded-full bg-cyan-50"><div class="h-3 rounded-full bg-[color:var(--ac-orange)]" style="width:${(r.total / max) * 100}%"></div></div>
          </button>`).join("") || `<p class="text-sm text-slate-500">Nenhum pedido encontrado no periodo.</p>`}
        </div>
      </div>
      <div class="card">
        <p class="eyebrow">Grafico mensal</p>
        <h3 class="section-title text-xl font-black">${data.selectedProduct ? esc(data.selectedProduct.nome) : "Selecione um produto"}</h3>
        <p class="mt-1 text-sm text-slate-500">Quantidade solicitada nos ultimos 6 meses.</p>
        <div class="trend-chart mt-5">
          ${data.productTrend.map((item) => `<div class="trend-bar">
            <div class="trend-value">${item.total}</div>
            <div class="trend-track"><span style="height:${Math.max((item.total / trendMax) * 100, item.total > 0 ? 8 : 2)}%"></span></div>
            <strong>${esc(monthLabel(item.mes))}</strong>
          </div>`).join("") || `<p class="text-sm text-slate-500">Sem dados para exibir.</p>`}
        </div>
      </div>
    </section>`);

  document.querySelector("#dash-filter").addEventListener("submit", (event) => {
    event.preventDefault();
    const form = Object.fromEntries(new FormData(event.currentTarget));
    const typedProduct = String(form.q || "").trim();
    const foundProduct = state.products.find((p) =>
      p.sku.toLowerCase() === typedProduct.toLowerCase() ||
      p.nome.toLowerCase() === typedProduct.toLowerCase()
    );
    viewDashboard({ from: form.from, to: form.to, q: typedProduct, sku: foundProduct?.sku || "" });
  });

  document.querySelectorAll(".product-trend-btn").forEach((btn) => btn.addEventListener("click", () => {
    viewDashboard({ from, to, q, sku: btn.dataset.sku });
  }));
}

async function viewProducts() {
  const data = await request("/api/admin/products");
  const categories = categoryOptions();
  shell(`
    <section class="grid gap-4">
      <form id="product-form" class="card product-form-compact">
        <div>
          <p class="eyebrow">Cadastro</p>
          <h3 class="section-title text-xl font-black">Produto</h3>
        </div>
        <input name="sku" placeholder="SKU" required />
        <input name="nome" placeholder="Nome" required />
        <select name="categoria">
          <option value="">Selecione a categoria</option>
          ${categories.map((category) => `<option value="${esc(category)}">${esc(category)}</option>`).join("")}
        </select>
        <input name="qtd_total" type="number" min="0" value="0" />
        <button class="btn">Salvar produto</button>
      </form>
      <section class="card">
        ${table(["SKU", "Produto", "Categoria", "Estoque central", "Status", "Acao"], data.products.map((p) => `
          <tr>
            <td>${esc(p.sku)}</td>
            <td>${esc(p.nome)}</td>
            <td>
              <select class="product-category-select" data-sku="${esc(p.sku)}" data-name="${esc(p.nome)}" data-qty="${p.qtd_total}" data-active="${p.ativo}">
                <option value="">Sem categoria</option>
                ${categories.map((category) => `<option value="${esc(category)}" ${p.categoria === category ? "selected" : ""}>${esc(category)}</option>`).join("")}
              </select>
            </td>
            <td>${p.qtd_total}</td>
            <td>${p.ativo ? "Ativo" : "Inativo"}</td>
            <td><button class="btn secondary toggle-product" data-sku="${esc(p.sku)}" data-active="${p.ativo}" data-name="${esc(p.nome)}" data-qty="${p.qtd_total}" data-category="${esc(p.categoria || "")}">${p.ativo ? "Inativar" : "Reativar"}</button></td>
          </tr>`))}
      </section>
    </section>
    <div class="sidebar-backdrop hidden" id="category-panel-backdrop"></div>
    <aside class="category-panel hidden" id="category-panel">
      <div class="category-panel-head">
        <div>
          <p class="eyebrow">Categorias</p>
          <h3 class="section-title text-xl font-black">Gerenciar categorias</h3>
        </div>
        <button class="side-close" id="close-category-panel" type="button" aria-label="Fechar painel">×</button>
      </div>
      <form id="category-form" class="category-panel-form">
        <input name="atual" type="hidden" />
        <input name="nome" placeholder="Nova categoria" required />
        <div class="category-panel-actions">
          <button class="btn secondary hidden" id="cancel-category-edit" type="button">Cancelar</button>
          <button class="btn" id="save-category-btn" type="submit">Salvar categoria</button>
        </div>
      </form>
      <div class="category-panel-list" id="category-panel-list"></div>
    </aside>`, `
      <div class="sheet-actions">
        <button class="btn secondary" id="sheet-actions-toggle">Planilha</button>
        <div class="sheet-actions-menu hidden" id="sheet-actions-menu">
          <button class="btn secondary" id="export-products">Exportar Google Sheets</button>
          <label class="btn secondary import-sheet-control">
            Importar planilha
            <input id="import-products" type="file" accept=".csv,.tsv,text/csv,text/tab-separated-values" hidden />
          </label>
        </div>
      </div>
      <button class="btn secondary" id="open-category-panel">+ Categoria</button>
    `);

  const sheetActionsToggle = document.querySelector("#sheet-actions-toggle");
  const sheetActionsMenu = document.querySelector("#sheet-actions-menu");
  const closeSheetActions = () => sheetActionsMenu.classList.add("hidden");
  sheetActionsToggle.addEventListener("click", () => {
    sheetActionsMenu.classList.toggle("hidden");
  });

  document.querySelector("#export-products").addEventListener("click", () => {
    const headers = ["SKU", "Produto", "Categoria", "Estoque Central", "Ativo"];
    const rows = data.products.map((p) => [spreadsheetText(p.sku), p.nome, p.categoria || "", p.qtd_total, p.ativo ? "SIM" : "NAO"]);
    downloadCsv("produtos_google_sheets.csv", [headers, ...rows]);
    closeSheetActions();
  });

  document.querySelector("#import-products").addEventListener("change", async (event) => {
    const file = event.target.files?.[0];
    if (!file) return;
    try {
      const text = await file.text();
      const items = parseProductsSheet(text);
      if (!items.length) throw new Error("Nenhum produto valido encontrado na planilha.");
      await request("/api/admin/products/import", { method: "POST", body: JSON.stringify({ items }) });
      toast(`${items.length} produtos importados.`);
      closeSheetActions();
      route("products");
    } catch (error) {
      toast(error.message, "error");
    } finally {
      event.target.value = "";
    }
  });

  document.querySelector("#product-form").addEventListener("submit", async (event) => {
    event.preventDefault();
    await request("/api/admin/products", { method: "POST", body: JSON.stringify(Object.fromEntries(new FormData(event.currentTarget))) });
    toast("Produto salvo.");
    route("products");
  });
  document.querySelectorAll(".product-category-select").forEach((select) => select.addEventListener("change", async () => {
    await request("/api/admin/products", {
      method: "PATCH",
      body: JSON.stringify({
        sku: select.dataset.sku,
        nome: select.dataset.name,
        categoria: select.value,
        qtd_total: select.dataset.qty,
        ativo: select.dataset.active === "true"
      })
    });
    toast("Categoria atualizada.");
    await loadBootstrap();
    route("products");
  }));
  document.querySelectorAll(".toggle-product").forEach((btn) => btn.addEventListener("click", async () => {
    await request("/api/admin/products", { method: "PATCH", body: JSON.stringify({ sku: btn.dataset.sku, nome: btn.dataset.name, categoria: btn.dataset.category, qtd_total: btn.dataset.qty, ativo: btn.dataset.active !== "true" }) });
    route("products");
  }));

  const categoryList = document.querySelector("#category-panel-list");
  const categoryForm = document.querySelector("#category-form");
  const categoryNameInput = categoryForm.querySelector("input[name='nome']");
  const categoryCurrentInput = categoryForm.querySelector("input[name='atual']");
  const cancelCategoryEdit = document.querySelector("#cancel-category-edit");
  const saveCategoryBtn = document.querySelector("#save-category-btn");
  let selectedCategoryName = "";
  const resetCategoryForm = () => {
    categoryCurrentInput.value = "";
    categoryNameInput.value = "";
    categoryNameInput.placeholder = "Nova categoria";
    cancelCategoryEdit.classList.add("hidden");
    saveCategoryBtn.textContent = "Salvar categoria";
  };
  const openCategoryPanel = async () => {
    const panelData = await request("/api/admin/categories");
    categoryList.innerHTML = panelData.categories.length
      ? panelData.categories.map((category) => `
          <div class="category-row">
            <div class="category-row-head">
              <div>
              <strong>${esc(category.nome)}</strong>
              <span>${category.produtos} produto(s) | ${category.pdvs} PDV(s)</span>
              </div>
              <div class="category-row-actions">
                <button class="icon-action category-edit-btn" data-name="${esc(category.nome)}" title="Editar categoria" aria-label="Editar categoria">✎</button>
                <button class="icon-action danger category-delete-btn" data-name="${esc(category.nome)}" title="Excluir categoria" aria-label="Excluir categoria">×</button>
              </div>
            </div>
          </div>`).join("")
      : `<p class="text-sm text-slate-500">Nenhuma categoria cadastrada ainda.</p>`;
    document.querySelectorAll(".category-edit-btn").forEach((button) => button.addEventListener("click", async () => {
      const categoryName = button.dataset.name;
      selectedCategoryName = "";
      await renderCategories();
      categoryCurrentInput.value = categoryName;
      categoryNameInput.value = categoryName;
      cancelCategoryEdit.classList.remove("hidden");
      saveCategoryBtn.textContent = "Salvar alteracao";
      categoryNameInput.focus();
    }));
    document.querySelectorAll(".category-delete-btn").forEach((button) => button.addEventListener("click", async () => {
      await request("/api/admin/categories", { method: "DELETE", body: JSON.stringify({ nome: button.dataset.name }) });
      toast("Categoria excluida.");
      await loadBootstrap();
      await openCategoryPanel();
    }));
    categoryPanel.classList.remove("hidden");
    categoryPanel.classList.add("is-open");
    categoryBackdrop.classList.remove("hidden");
  };
  const closeCategoryPanel = () => {
    resetCategoryForm();
    categoryPanel.classList.add("hidden");
    categoryPanel.classList.remove("is-open");
    categoryBackdrop.classList.add("hidden");
  };
  document.querySelector("#open-category-panel").addEventListener("click", openCategoryPanel);
  document.querySelector("#close-category-panel").addEventListener("click", closeCategoryPanel);
  categoryBackdrop.addEventListener("click", closeCategoryPanel);
  cancelCategoryEdit.addEventListener("click", resetCategoryForm);
  document.querySelector("#category-form").addEventListener("submit", async (event) => {
    event.preventDefault();
    const form = Object.fromEntries(new FormData(event.currentTarget));
    const isEditing = Boolean(form.atual);
    await request("/api/admin/categories", {
      method: isEditing ? "PATCH" : "POST",
      body: JSON.stringify(form)
    });
    toast(isEditing ? "Categoria atualizada." : "Categoria cadastrada.");
    await loadBootstrap();
    closeCategoryPanel();
    route("products");
  });
}

async function viewProductsV2() {
  const data = await request("/api/admin/products");
  const manualProducts = data.products.filter((product) => (product.origem || "manual") === "manual");
  const omieProducts = data.products.filter((product) => (product.origem || "manual") === "omie");
  shell(`
    <section class="grid gap-4">
      <section class="product-tabs-shell">
        <div class="config-tabs" role="tablist" aria-label="Produtos do estoque central">
          <button class="config-tab is-active" type="button" data-product-tab="manual" role="tab" aria-selected="true">Produtos manuais</button>
          <button class="config-tab" type="button" data-product-tab="omie" role="tab" aria-selected="false">Produtos OMIE</button>
          <button class="config-tab" type="button" data-product-tab="categories" role="tab" aria-selected="false">Categorias</button>
        </div>
        <section class="product-panel is-active" data-product-panel="manual" role="tabpanel">
          <form id="product-form" class="card product-form-compact">
            <input name="editing" type="hidden" />
            <div>
              <p class="eyebrow">Cadastro</p>
              <h3 class="section-title text-xl font-black" id="product-form-title">Produto manual</h3>
            </div>
            <input name="sku" placeholder="SKU" required />
            <input name="nome" placeholder="Nome" required />
            <input name="qtd_total" type="number" min="0" value="0" />
            <select name="ativo">
              <option value="true">Ativo</option>
              <option value="false">Inativo</option>
            </select>
            <button class="btn secondary hidden" id="cancel-product-edit" type="button">Cancelar edicao</button>
            <button class="btn">Salvar produto</button>
          </form>
          <div class="card">
            ${table(["SKU", "Produto", "Categoria", "Estoque central", "Status", "Acoes"], manualProducts.map((p) => `
              <tr>
                <td>${esc(p.sku)}</td>
                <td>${esc(p.nome)}</td>
                <td>${esc(p.categoria || "-")}</td>
                <td>${p.qtd_total}</td>
                <td>${p.ativo ? "Ativo" : "Inativo"}</td>
                <td><div class="table-actions"><button class="icon-action edit-product" type="button" data-sku="${esc(p.sku)}" data-name="${esc(p.nome)}" data-qty="${p.qtd_total}" data-active="${p.ativo}" title="Editar produto" aria-label="Editar produto">&#9998;</button><button class="icon-action danger delete-product" type="button" data-sku="${esc(p.sku)}" data-name="${esc(p.nome)}" title="Excluir produto" aria-label="Excluir produto">&times;</button></div></td>
              </tr>`))}
          </div>
        </section>
        <section class="product-panel hidden" data-product-panel="omie" role="tabpanel">
          <div class="card">
            ${table(["SKU", "Produto", "Categoria", "Estoque central", "Status"], omieProducts.map((p) => `
              <tr>
                <td>${esc(p.sku)}</td>
                <td>${esc(p.nome)}</td>
                <td>${esc(p.categoria || "-")}</td>
                <td>${p.qtd_total}</td>
                <td>${p.ativo ? "Ativo" : "Inativo"}</td>
              </tr>`))}
          </div>
        </section>
        <section class="product-panel hidden" data-product-panel="categories" role="tabpanel">
          <section class="card grid gap-4">
            <div>
              <p class="eyebrow">Categorias</p>
              <h3 class="section-title text-xl font-black">Gerenciar categorias</h3>
            </div>
            <form id="category-form" class="category-panel-form">
              <input name="atual" type="hidden" />
              <input name="nome" placeholder="Nova categoria" required />
              <div class="category-panel-actions">
                <button class="btn secondary hidden" id="cancel-category-edit" type="button">Cancelar</button>
                <button class="btn" id="save-category-btn" type="submit">Salvar categoria</button>
              </div>
            </form>
            <div class="category-panel-list" id="category-panel-list"></div>
          </section>
        </section>
      </section>
    </section>`, `
      <div class="sheet-actions">
        <button class="btn secondary" id="sheet-actions-toggle">Planilha</button>
        <div class="sheet-actions-menu hidden" id="sheet-actions-menu">
          <button class="btn secondary" id="export-products">Exportar Google Sheets</button>
          <label class="btn secondary import-sheet-control">
            Importar planilha OMIE
            <input id="import-products" type="file" accept=".csv,.tsv,text/csv,text/tab-separated-values" hidden />
          </label>
        </div>
      </div>
    `);

  document.querySelectorAll("[data-product-tab]").forEach((button) => button.addEventListener("click", () => {
    document.querySelectorAll("[data-product-tab]").forEach((tab) => {
      const active = tab.dataset.productTab === button.dataset.productTab;
      tab.classList.toggle("is-active", active);
      tab.setAttribute("aria-selected", active ? "true" : "false");
    });
    document.querySelectorAll("[data-product-panel]").forEach((panel) => {
      const active = panel.dataset.productPanel === button.dataset.productTab;
      panel.classList.toggle("is-active", active);
      panel.classList.toggle("hidden", !active);
    });
  }));

  const sheetActionsMenu = document.querySelector("#sheet-actions-menu");
  const closeSheetActions = () => sheetActionsMenu.classList.add("hidden");
  document.querySelector("#sheet-actions-toggle").addEventListener("click", () => sheetActionsMenu.classList.toggle("hidden"));
  document.querySelector("#export-products").addEventListener("click", () => {
    const headers = ["SKU", "Produto", "Categoria", "Estoque Central", "Ativo", "Origem"];
    const rows = data.products.map((p) => [spreadsheetText(p.sku), p.nome, p.categoria || "", p.qtd_total, p.ativo ? "SIM" : "NAO", p.origem || "manual"]);
    downloadCsv("produtos_google_sheets.csv", [headers, ...rows]);
    closeSheetActions();
  });
  document.querySelector("#import-products").addEventListener("change", async (event) => {
    const file = event.target.files?.[0];
    if (!file) return;
    try {
      const text = await file.text();
      const items = parseProductsSheet(text);
      if (!items.length) throw new Error("Nenhum produto valido encontrado na planilha.");
      await request("/api/admin/products/import", { method: "POST", body: JSON.stringify({ items }) });
      toast(`${items.length} produtos OMIE importados.`);
      closeSheetActions();
      route("products");
    } catch (error) {
      toast(error.message, "error");
    } finally {
      event.target.value = "";
    }
  });

  const productForm = document.querySelector("#product-form");
  const productTitle = document.querySelector("#product-form-title");
  const productSku = productForm.querySelector('[name="sku"]');
  const cancelProductEdit = document.querySelector("#cancel-product-edit");
  const resetProductForm = () => {
    productForm.reset();
    productForm.querySelector('[name="editing"]').value = "";
    productSku.readOnly = false;
    productTitle.textContent = "Produto manual";
    cancelProductEdit.classList.add("hidden");
  };
  document.querySelectorAll(".edit-product").forEach((button) => button.addEventListener("click", () => {
    productForm.querySelector('[name="editing"]').value = "true";
    productSku.value = button.dataset.sku;
    productSku.readOnly = true;
    productForm.querySelector('[name="nome"]').value = button.dataset.name;
    productForm.querySelector('[name="qtd_total"]').value = button.dataset.qty;
    productForm.querySelector('[name="ativo"]').value = button.dataset.active === "true" ? "true" : "false";
    productTitle.textContent = `Editar produto: ${button.dataset.name}`;
    cancelProductEdit.classList.remove("hidden");
    productForm.scrollIntoView({ behavior: "smooth", block: "start" });
  }));
  document.querySelectorAll(".delete-product").forEach((button) => button.addEventListener("click", async () => {
    if (!window.confirm(`Excluir o produto ${button.dataset.name}?`)) return;
    await request("/api/admin/products", { method: "DELETE", body: JSON.stringify({ sku: button.dataset.sku }) });
    toast("Produto excluido.");
    await loadBootstrap();
    route("products");
  }));
  cancelProductEdit.addEventListener("click", resetProductForm);
  productForm.addEventListener("submit", async (event) => {
    event.preventDefault();
    const form = Object.fromEntries(new FormData(event.currentTarget));
    const editing = Boolean(form.editing);
    form.ativo = form.ativo === "true";
    delete form.editing;
    await request("/api/admin/products", { method: editing ? "PATCH" : "POST", body: JSON.stringify(form) });
    toast(editing ? "Produto atualizado." : "Produto salvo.");
    await loadBootstrap();
    route("products");
  });

  const categoryList = document.querySelector("#category-panel-list");
  const categoryForm = document.querySelector("#category-form");
  const categoryNameInput = categoryForm.querySelector("input[name='nome']");
  const categoryCurrentInput = categoryForm.querySelector("input[name='atual']");
  const cancelCategoryEdit = document.querySelector("#cancel-category-edit");
  const saveCategoryBtn = document.querySelector("#save-category-btn");
  let selectedCategoryName = "";
  const resetCategoryForm = () => {
    categoryCurrentInput.value = "";
    categoryNameInput.value = "";
    categoryNameInput.placeholder = "Nova categoria";
    cancelCategoryEdit.classList.add("hidden");
    saveCategoryBtn.textContent = "Salvar categoria";
  };
  const renderCategories = async () => {
    const panelData = await request("/api/admin/categories");
    const categoryKey = (value) => String(value || "").trim().toUpperCase();
    const categoryProducts = (panelData.products && panelData.products.length ? panelData.products : (await request("/api/admin/products")).products || [])
      .map((product) => ({ ...product, categoria: categoryKey(product.categoria) }));
    const categories = panelData.categories || state.categories.map((nome) => ({ nome, produtos: 0, pdvs: 0 }));
    if (selectedCategoryName && !categories.some((category) => categoryKey(category.nome) === categoryKey(selectedCategoryName))) {
      selectedCategoryName = "";
    }
    const selectedCategory = categories.find((category) => categoryKey(category.nome) === categoryKey(selectedCategoryName));
    const selectedKey = categoryKey(selectedCategory?.nome);
    const assigned = selectedCategory ? categoryProducts.filter((product) => categoryKey(product.categoria) === selectedKey) : [];
    const available = selectedCategory ? categoryProducts.filter((product) => categoryKey(product.categoria) !== selectedKey) : [];
    categoryForm.classList.toggle("hidden", Boolean(selectedCategory));
    categoryList.innerHTML = selectedCategory
      ? `
        <section class="category-detail category-detail-screen">
          <div class="category-detail-head">
            <div>
              <p class="eyebrow">Produtos da categoria</p>
              <h3 class="section-title text-xl font-black">${esc(selectedCategory.nome)}</h3>
              <p class="text-sm text-slate-500">${assigned.length} produto(s) vinculado(s)</p>
            </div>
            <div class="category-row-actions">
              <button class="btn secondary" type="button" id="back-category-list">Voltar</button>
            </div>
          </div>
          <section class="category-settings">
            <div>
              <p class="eyebrow">Configuracao da categoria</p>
              <h4>Editar dados</h4>
            </div>
            <div class="category-settings-form">
              <input id="selected-category-name" value="${esc(selectedCategory.nome)}" />
              <button class="btn secondary update-category-btn" type="button" data-current="${esc(selectedCategory.nome)}">Salvar nome</button>
              <button class="btn danger delete-category-btn" type="button" data-name="${esc(selectedCategory.nome)}">Excluir categoria</button>
            </div>
          </section>
          <div class="category-product-tools">
            <div class="category-product-picker">
              <label class="category-add-label" for="category-add-product-search">Adicionar produto</label>
              <input id="category-add-product-search" class="category-add-product-search" type="search" placeholder="Digite o nome ou SKU do produto" autocomplete="off" />
              <input class="category-add-product-sku" type="hidden" />
              <div class="category-product-suggestions hidden">
                ${available.map((product) => `
                  <button class="category-product-suggestion" type="button" data-sku="${esc(product.sku)}" data-label="${esc(`${product.nome} (${product.sku})`)}" data-search="${esc(`${product.sku} ${product.nome} ${product.origem || "manual"}`.toLowerCase())}">
                    <strong>${esc(product.nome)}</strong>
                    <span>${esc(product.sku)} | ${esc(product.origem || "manual")}</span>
                  </button>`).join("") || `<p class="text-sm text-slate-500">Nenhum produto disponivel para adicionar.</p>`}
              </div>
            </div>
            <button class="btn secondary add-category-product" type="button" data-category="${esc(selectedCategory.nome)}">Adicionar</button>
          </div>
          <div class="category-product-list">
            <div class="category-product-list-head">
              <strong>Produtos vinculados</strong>
              <input class="category-product-search" type="search" placeholder="Pesquisar produto" />
            </div>
            <div class="category-product-table">
              ${assigned.length ? table(["SKU", "Produto", "Origem", "Acao"], assigned.map((product) => `
                <tr class="category-product-row" data-search="${esc(`${product.sku} ${product.nome} ${product.origem || "manual"}`.toLowerCase())}">
                  <td>${esc(product.sku)}</td>
                  <td>${esc(product.nome)}</td>
                  <td>${esc(product.origem || "manual")}</td>
                  <td><button class="icon-action danger remove-category-product" type="button" data-sku="${esc(product.sku)}" title="Remover produto" aria-label="Remover produto">&times;</button></td>
                </tr>`)) : `<p class="text-sm text-slate-500">Nenhum produto nesta categoria.</p>`}
            </div>
          </div>
        </section>`
      : categories.length
        ? `
          <div class="category-list-summary">
            ${categories.map((category) => `
            <button class="category-row category-row-button" type="button" data-open-category="${esc(category.nome)}">
              <div class="category-row-head">
                <div>
                  <strong>${esc(category.nome)}</strong>
                  <span>${category.produtos} produto(s) | ${category.pdvs} PDV(s)</span>
                </div>
                <span class="category-row-open">Abrir</span>
              </div>
            </button>`).join("")}
          </div>`
        : `<p class="text-sm text-slate-500">Nenhuma categoria cadastrada ainda.</p>`;
    document.querySelectorAll("[data-open-category]").forEach((button) => button.addEventListener("click", async () => {
      selectedCategoryName = button.dataset.openCategory;
      await renderCategories();
    }));
    document.querySelector("#back-category-list")?.addEventListener("click", async () => {
      selectedCategoryName = "";
      await renderCategories();
    });
    document.querySelector(".category-product-search")?.addEventListener("input", (event) => {
      const term = String(event.target.value || "").trim().toLowerCase();
      document.querySelectorAll(".category-product-row").forEach((row) => {
        row.classList.toggle("hidden", term && !row.dataset.search.includes(term));
      });
    });
    const addProductSearch = document.querySelector(".category-add-product-search");
    const addProductSku = document.querySelector(".category-add-product-sku");
    const suggestions = document.querySelector(".category-product-suggestions");
    const filterSuggestions = () => {
      const term = String(addProductSearch?.value || "").trim().toLowerCase();
      let visible = 0;
      if (addProductSearch?.dataset.selectedLabel !== addProductSearch?.value) {
        addProductSku.value = "";
      }
      document.querySelectorAll(".category-product-suggestion").forEach((item) => {
        const show = term.length > 0 && item.dataset.search.includes(term);
        item.classList.toggle("hidden", !show);
        if (show) visible += 1;
      });
      suggestions?.classList.toggle("hidden", term.length === 0 || visible === 0);
      if (!term) addProductSku.value = "";
    };
    addProductSearch?.addEventListener("input", filterSuggestions);
    document.querySelectorAll(".category-product-suggestion").forEach((item) => item.addEventListener("click", () => {
      addProductSearch.value = item.dataset.label || "";
      addProductSearch.dataset.selectedLabel = addProductSearch.value;
      addProductSku.value = item.dataset.sku || "";
      suggestions?.classList.add("hidden");
    }));
    document.querySelector(".update-category-btn")?.addEventListener("click", async (event) => {
      const input = document.querySelector("#selected-category-name");
      const nextName = String(input?.value || "").trim();
      if (!nextName) return;
      await request("/api/admin/categories", {
        method: "PATCH",
        body: JSON.stringify({ atual: event.currentTarget.dataset.current, nome: nextName })
      });
      toast("Categoria atualizada.");
      selectedCategoryName = nextName;
      await loadBootstrap();
      await renderCategories();
    });
    document.querySelector(".delete-category-btn")?.addEventListener("click", async (event) => {
      if (!window.confirm(`Excluir a categoria ${event.currentTarget.dataset.name}?`)) return;
      await request("/api/admin/categories", { method: "DELETE", body: JSON.stringify({ nome: event.currentTarget.dataset.name }) });
      toast("Categoria excluida.");
      selectedCategoryName = "";
      await loadBootstrap();
      await renderCategories();
    });
    document.querySelectorAll(".add-category-product").forEach((button) => button.addEventListener("click", async () => {
      const detail = button.closest(".category-detail");
      const sku = detail?.querySelector(".category-add-product-sku")?.value || "";
      if (!sku) return;
      await request("/api/admin/category-products", { method: "POST", body: JSON.stringify({ sku, categoria: button.dataset.category }) });
      toast("Produto adicionado a categoria.");
      await loadBootstrap();
      await renderCategories();
    }));
    document.querySelectorAll(".remove-category-product").forEach((button) => button.addEventListener("click", async () => {
      await request("/api/admin/category-products", { method: "POST", body: JSON.stringify({ sku: button.dataset.sku, categoria: "" }) });
      toast("Produto removido da categoria.");
      await loadBootstrap();
      await renderCategories();
    }));
  };
  cancelCategoryEdit.addEventListener("click", resetCategoryForm);
  categoryForm.addEventListener("submit", async (event) => {
    event.preventDefault();
    const form = Object.fromEntries(new FormData(event.currentTarget));
    const isEditing = Boolean(form.atual);
    await request("/api/admin/categories", {
      method: isEditing ? "PATCH" : "POST",
      body: JSON.stringify(form)
    });
    toast(isEditing ? "Categoria atualizada." : "Categoria cadastrada.");
    await loadBootstrap();
    resetCategoryForm();
    await renderCategories();
  });
  await renderCategories();
}

async function viewStock() {
  const pdvId = state.pdvs[0]?.id || 0;
  const data = pdvId ? await request(`/api/admin/stock?pdvId=${pdvId}`) : { stock: [], pdv: null };
  const categoriesText = data.pdv?.categorias?.length ? data.pdv.categorias.join(", ") : "";
  shell(`
    <section class="card">
      <div class="mb-3 grid gap-3 md:grid-cols-[1fr_auto]">
        <select id="stock-pdv">${state.pdvs.map((p) => `<option value="${p.id}">${esc(p.nome)}</option>`).join("")}</select>
        <button class="btn" id="save-stock">Salvar configuracoes</button>
      </div>
      <div class="stock-category-note">${categoriesText ? `Categorias permitidas deste PDV: <strong>${esc(categoriesText)}</strong>` : "Este PDV ainda nao possui categorias permitidas. Nenhum produto fica liberado para solicitacao ate o almoxarifado definir as categorias."}</div>
      <div id="stock-table"></div>
    </section>`);

  const render = (payload) => {
    const stock = payload.stock || [];
    const currentCategories = payload.pdv?.categorias?.length ? payload.pdv.categorias.join(", ") : "";
    document.querySelector(".stock-category-note").innerHTML = currentCategories ? `Categorias permitidas deste PDV: <strong>${esc(currentCategories)}</strong>` : "Este PDV ainda nao possui categorias permitidas. Nenhum produto fica liberado para solicitacao ate o almoxarifado definir as categorias.";
    document.querySelector("#stock-table").innerHTML = table(["Produto", "Categoria", "Permissao", "Atual", "Min", "Max"], stock.map((s) => `
      <tr data-sku="${esc(s.sku)}">
        <td>${esc(s.nome)}</td>
        <td>${esc(s.categoria || "-")}</td>
        <td><span class="status Liberado">Automatica</span></td>
        <td><input class="quantidade" type="number" value="${s.quantidade}"></td>
        <td><input class="minimo" type="number" value="${s.estoque_minimo}"></td>
        <td><input class="maximo" type="number" value="${s.estoque_maximo}"></td>
      </tr>`));
  };
  render(data);
  document.querySelector("#stock-pdv").addEventListener("change", async (event) => {
    const fresh = await request(`/api/admin/stock?pdvId=${event.target.value}`);
    render(fresh);
  });
  document.querySelector("#save-stock").addEventListener("click", async () => {
    const items = [...document.querySelectorAll("#stock-table tbody tr")].map((tr) => ({
      sku: tr.dataset.sku,
      permitido: true,
      quantidade: tr.querySelector(".quantidade").value,
      estoque_minimo: tr.querySelector(".minimo").value,
      estoque_maximo: tr.querySelector(".maximo").value
    }));
    await request("/api/admin/stock", { method: "POST", body: JSON.stringify({ pdvId: document.querySelector("#stock-pdv").value, items }) });
    toast("Estoque do PDV atualizado.");
  });
}

async function viewRelease(filters = {}) {
  const from = filters.from || weekAgo();
  const to = filters.to || today();
  const activeStatus = filters.status || "Pendente";
  const statuses = ["Pendente", "Em Andamento", "Liberado"];
  const statusLabels = { Pendente: "Pendentes", "Em Andamento": "Em andamento", Liberado: "Liberados" };
  const data = await request(`/api/admin/orders?from=${from}&to=${to}`);
  const grouped = Object.values(data.orders.reduce((acc, row) => {
    acc[row.codigo_pedido] ||= [];
    acc[row.codigo_pedido].push(row);
    return acc;
  }, {}));
  const byStatus = statuses.reduce((acc, status) => {
    acc[status] = grouped.filter((group) => group[0]?.status === status);
    return acc;
  }, {});
  const visibleGroups = byStatus[activeStatus] || [];
  shell(`
    <section class="release-screen">
      <section class="card">
        <form id="release-filter" class="dash-filter">
          <div>
            <p class="eyebrow">Filtro</p>
            <h3 class="section-title text-xl font-black">Liberacao de pedidos</h3>
          </div>
          <label>De
            <input name="from" type="date" value="${esc(from)}" />
          </label>
          <label>Ate
            <input name="to" type="date" value="${esc(to)}" />
          </label>
          <button class="btn" type="submit">Filtrar</button>
        </form>
      </section>

      <div class="release-tabs-row">
        <div class="config-tabs release-tabs" role="tablist" aria-label="Status dos pedidos">
          ${statuses.map((status) => `
            <button class="config-tab ${status === activeStatus ? "is-active" : ""}" type="button" data-release-status="${esc(status)}" role="tab" aria-selected="${status === activeStatus ? "true" : "false"}">
              ${esc(statusLabels[status] || status)} <span>${byStatus[status].length}</span>
            </button>`).join("")}
        </div>
        <button class="btn secondary release-refresh" id="refresh-release" type="button">Atualizar solicitacoes</button>
      </div>

      <section class="grid gap-4">
        ${visibleGroups.map((group) => orderCard(group)).join("") || `<div class="card">Nao ha pedidos ${esc(activeStatus.toLowerCase())} no periodo.</div>`}
      </section>
    </section>`);
  document.querySelector("#release-filter").addEventListener("submit", async (event) => {
    event.preventDefault();
    const form = Object.fromEntries(new FormData(event.currentTarget));
    await viewRelease({ ...form, status: activeStatus });
  });
  document.querySelectorAll("[data-release-status]").forEach((button) => button.addEventListener("click", async () => {
    await viewRelease({ from, to, status: button.dataset.releaseStatus });
  }));
  document.querySelector("#refresh-release").addEventListener("click", async () => {
    await viewRelease({ from, to, status: activeStatus });
  });
  bindOrderToggles();
  document.querySelectorAll(".print-order").forEach((btn) => btn.addEventListener("click", () => {
    printOrder(btn.closest("[data-order]"));
  }));
  document.querySelectorAll(".flow").forEach((btn) => btn.addEventListener("click", async () => {
    const card = btn.closest("[data-order]");
    const items = [...card.querySelectorAll("tbody tr")].map((tr) => ({
      id: tr.dataset.id,
      quantidade_liberada: tr.querySelector(".liberada").value,
      remover: tr.querySelector(".remover").checked
    }));
    await request("/api/admin/order-flow", { method: "POST", body: JSON.stringify({ status: btn.dataset.status, items }) });
    toast("Pedido atualizado.");
    await viewRelease({ from, to, status: btn.dataset.status });
  }));
}

function orderCard(group) {
  const first = group[0];
  const statusTime = first.status === "Pendente"
    ? `Pendente desde ${moneyDate(first.criado_em)}`
    : first.status === "Em Andamento"
      ? `Em andamento desde ${moneyDate(first.em_andamento_em || first.criado_em)}`
      : `Liberado em ${moneyDate(first.liberado_em || first.criado_em)}`;
  const actions = first.status === "Pendente"
    ? `<button class="btn flow" data-status="Em Andamento">Enviar para em andamento</button>`
    : first.status === "Em Andamento"
      ? `<button class="btn secondary flow" data-status="Pendente">Voltar para pendente</button><button class="btn flow" data-status="Liberado">Liberar pedido</button>`
      : `<button class="btn secondary flow" data-status="Em Andamento">Voltar para em andamento</button><button class="btn secondary flow" data-status="Pendente">Voltar para pendente</button>`;
  return `<article class="card order-accordion" data-order="${esc(first.codigo_pedido)}">
    <button class="order-accordion-head" type="button" data-toggle-order aria-expanded="false">
      <span class="order-arrow">&#9662;</span>
      <span>
        <strong>Pedido ${esc(first.codigo_pedido)} - ${esc(first.pdv)}</strong>
        <small>${esc(first.solicitante)} | ${esc(statusTime)}</small>
      </span>
      ${statusPill(first.status)}
    </button>
    <div class="order-accordion-body hidden">
      <div class="order-card-actions no-print">
        <button class="btn secondary print-order" type="button">Imprimir pedido</button>
      </div>
      ${first.observacao ? `<p class="mb-3 rounded bg-amber-50 p-2 text-sm text-amber-900">${esc(first.observacao)}</p>` : ""}
      ${table(["Remover", "Produto", "Solicitado", "Liberar", "Saldo"], group.map((o) => `
        <tr data-id="${o.id}">
          <td><input class="remover" type="checkbox"></td>
          <td>${esc(o.produto)}</td>
          <td>${o.quantidade_solicitada}</td>
          <td><input class="liberada" type="number" min="0" value="${o.quantidade_liberada || o.quantidade_solicitada}"></td>
          <td>${o.saldo}</td>
        </tr>`))}
      <div class="order-card-actions no-print">${actions}</div>
    </div>
  </article>`;
}

function bindOrderToggles() {
  document.querySelectorAll("[data-toggle-order]").forEach((button) => button.addEventListener("click", () => {
    const card = button.closest(".order-accordion");
    const body = card?.querySelector(".order-accordion-body");
    const expanded = button.getAttribute("aria-expanded") === "true";
    button.setAttribute("aria-expanded", expanded ? "false" : "true");
    body?.classList.toggle("hidden", expanded);
    card?.classList.toggle("is-open", !expanded);
  }));
}

function printOrder(card) {
  if (!card) return;
  card.querySelector(".order-accordion-body")?.classList.remove("hidden");
  card.querySelector("[data-toggle-order]")?.setAttribute("aria-expanded", "true");
  card.classList.add("print-order-target", "is-open");
  document.body.classList.add("printing-order");
  window.print();
  setTimeout(() => {
    document.body.classList.remove("printing-order");
    card.classList.remove("print-order-target");
  }, 300);
}

async function viewOrion() {
  const data = await request("/api/admin/orion");
  shell(`
    <section class="grid gap-4 lg:grid-cols-[360px_1fr]">
      <form id="orion-form" class="card grid gap-3">
        <h3 class="text-xl font-black">Simular ORION</h3>
        <select name="pdvId">${state.pdvs.map((p) => `<option value="${p.id}">${esc(p.nome)}</option>`).join("")}</select>
        <select name="sku">${state.products.map((p) => `<option value="${p.sku}">${esc(p.nome)}</option>`).join("")}</select>
        <input name="quantidade" type="number" min="1" value="1" />
        <select name="tipo_operacao"><option>VENDA</option><option>DEVOLUCAO</option></select>
        <button class="btn">Registrar evento</button>
      </form>
      <section class="card">${table(["Data", "PDV", "Produto", "Qtd", "Operacao", "Processado"], data.events.map((e) => `<tr><td>${moneyDate(e.data_venda)}</td><td>${esc(e.pdv)}</td><td>${esc(e.produto)}</td><td>${e.quantidade_vendida}</td><td>${e.tipo_operacao}</td><td>${e.processado ? "Sim" : "Nao"}</td></tr>`))}</section>
    </section>`);
  document.querySelector("#orion-form").addEventListener("submit", async (event) => {
    event.preventDefault();
    await request("/api/admin/orion", { method: "POST", body: JSON.stringify(Object.fromEntries(new FormData(event.currentTarget))) });
    toast("Evento ORION processado.");
    route("orion");
  });
}

async function viewHistory(autoOnly) {
  const data = await request(`/api/admin/history?auto=${autoOnly ? "1" : "0"}`);
  shell(`<section class="card"><h3 class="text-xl font-black">${autoOnly ? "Historico de autopedidos" : "Historico geral"}</h3>${table(["Data", "Pedido", "PDV", "Produto", "Solicitado", "Liberado", "Status"], data.history.map((h) => `<tr><td>${moneyDate(h.data_hora)}</td><td>${esc(h.codigo_pedido)}</td><td>${esc(h.pdv)}</td><td>${esc(h.produto)}</td><td>${h.quantidade_solicitada}</td><td>${h.quantidade_liberada}</td><td>${statusPill(h.status)}</td></tr>`))}</section>`);
}

async function viewConfig() {
  const categories = categoryOptions();
  shell(`
    <section class="config-tabs-shell">
      <div class="config-tabs" role="tablist" aria-label="Configuracoes do sistema">
        <button class="config-tab is-active" type="button" data-config-tab="pdv" role="tab" aria-selected="true">Criar PDV</button>
        <button class="config-tab" type="button" data-config-tab="security" role="tab" aria-selected="false">Seguranca e APIs</button>
        <button class="config-tab" type="button" data-config-tab="manage" role="tab" aria-selected="false">Gerenciar PDVs</button>
      </div>

      <div class="config-tab-panels">
        <section class="config-panel is-active" data-config-panel="pdv" role="tabpanel">
          <form id="pdv-form" class="card grid gap-3">
            <input name="id" type="hidden" />
            <h3 class="text-xl font-black" id="pdv-form-title">Criar PDV</h3>
            <input name="nome" placeholder="Nome do PDV" required />
            <input name="senha" type="password" placeholder="Senha" required />
            <input name="codigo_orion" placeholder="Codigo ORION" />
            <div class="category-picker">
              <p class="text-sm font-bold">Categorias permitidas para este PDV</p>
              <div class="category-select-row">
                <select id="pdv-category-select">
                  <option value="">Selecione uma categoria</option>
                  ${categories.map((category) => `<option value="${esc(category)}">${esc(category)}</option>`).join("")}
                </select>
                <button class="btn secondary" id="add-pdv-category" type="button">Adicionar</button>
              </div>
              <div class="category-picker-list" id="pdv-category-list">
                ${categories.length ? `<p class="text-sm text-slate-500">Nenhuma categoria adicionada ainda.</p>` : `<p class="text-sm text-slate-500">Cadastre categorias nos produtos para aparecerem aqui.</p>`}
              </div>
            </div>
            <div class="form-actions">
              <button class="btn hidden" id="cancel-pdv-edit" type="button">Cancelar edicao</button>
              <button class="btn" id="save-pdv-button">Criar PDV</button>
            </div>
          </form>
        </section>

        <section class="config-panel hidden" data-config-panel="security" role="tabpanel">
          <form id="config-form" class="card grid gap-3">
            <h3 class="text-xl font-black">Seguranca e APIs</h3>
            <input name="adminPassword" type="password" placeholder="Nova senha do Almoxarifado" />
            <input name="omie_app_key" placeholder="Omie app key" />
            <input name="omie_app_secret" placeholder="Omie app secret" />
            <button class="btn">Salvar configuracoes</button>
          </form>
        </section>

        <section class="config-panel hidden" data-config-panel="manage" role="tabpanel">
          <section class="card">
            <div class="mb-3">
              <p class="eyebrow">Gestao</p>
              <h3 class="text-xl font-black">Gerenciar PDVs</h3>
            </div>
            ${table(["PDV", "ORION", "Categorias permitidas", "Acoes"], state.pdvs.map((p) => `<tr><td>${esc(p.nome)}</td><td>${esc(p.codigo_orion || "-")}</td><td>${esc((p.categorias || []).join(", ") || "-")}</td><td><div class="table-actions"><button class="icon-action" type="button" data-edit-pdv="${p.id}" title="Editar PDV" aria-label="Editar PDV">&#9998;</button><button class="icon-action danger" type="button" data-delete-pdv="${p.id}" title="Excluir PDV" aria-label="Excluir PDV">&times;</button></div></td></tr>`))}
          </section>
        </section>
      </div>
    </section>`);
  const selectedPdvCategories = [];
  const tabButtons = [...document.querySelectorAll("[data-config-tab]")];
  const tabPanels = [...document.querySelectorAll("[data-config-panel]")];
  const setConfigTab = (tabId) => {
    tabButtons.forEach((button) => {
      const active = button.dataset.configTab === tabId;
      button.classList.toggle("is-active", active);
      button.setAttribute("aria-selected", active ? "true" : "false");
    });
    tabPanels.forEach((panel) => {
      const active = panel.dataset.configPanel === tabId;
      panel.classList.toggle("is-active", active);
      panel.classList.toggle("hidden", !active);
    });
  };
  tabButtons.forEach((button) => button.addEventListener("click", () => setConfigTab(button.dataset.configTab)));
  const pdvForm = document.querySelector("#pdv-form");
  const pdvCategoryList = document.querySelector("#pdv-category-list");
  const pdvTitle = document.querySelector("#pdv-form-title");
  const pdvPassword = pdvForm.querySelector('[name="senha"]');
  const pdvIdField = pdvForm.querySelector('[name="id"]');
  const savePdvButton = document.querySelector("#save-pdv-button");
  const cancelPdvEdit = document.querySelector("#cancel-pdv-edit");
  const resetPdvForm = () => {
    pdvForm.reset();
    pdvIdField.value = "";
    pdvPassword.required = true;
    pdvPassword.placeholder = "Senha";
    pdvTitle.textContent = "Criar PDV";
    savePdvButton.textContent = "Criar PDV";
    cancelPdvEdit.classList.add("hidden");
    selectedPdvCategories.splice(0, selectedPdvCategories.length);
    renderPdvCategories();
  };
  const renderPdvCategories = () => {
    pdvCategoryList.innerHTML = selectedPdvCategories.length
      ? selectedPdvCategories.map((category) => `
          <label class="category-chip selected-chip">
            <input name="categorias" type="hidden" value="${esc(category)}">
            <span>${esc(category)}</span>
            <button class="chip-remove" type="button" data-category="${esc(category)}" aria-label="Remover categoria">x</button>
          </label>`).join("")
      : `<p class="text-sm text-slate-500">Nenhuma categoria adicionada ainda.</p>`;
    document.querySelectorAll(".chip-remove").forEach((button) => button.addEventListener("click", () => {
      const index = selectedPdvCategories.indexOf(button.dataset.category);
      if (index >= 0) selectedPdvCategories.splice(index, 1);
      renderPdvCategories();
    }));
  };
  document.querySelector("#add-pdv-category").addEventListener("click", () => {
    const select = document.querySelector("#pdv-category-select");
    const value = String(select.value || "").trim();
    if (!value) return;
    if (!selectedPdvCategories.includes(value)) selectedPdvCategories.push(value);
    select.value = "";
    renderPdvCategories();
  });
  document.querySelectorAll("[data-edit-pdv]").forEach((button) => button.addEventListener("click", () => {
    const pdv = state.pdvs.find((item) => String(item.id) === button.dataset.editPdv);
    if (!pdv) return;
    pdvIdField.value = pdv.id;
    pdvForm.querySelector('[name="nome"]').value = pdv.nome || "";
    pdvForm.querySelector('[name="codigo_orion"]').value = pdv.codigo_orion || "";
    pdvPassword.value = "";
    pdvPassword.required = false;
    pdvPassword.placeholder = "Nova senha (opcional)";
    pdvTitle.textContent = `Editar PDV: ${pdv.nome}`;
    savePdvButton.textContent = "Salvar alteracoes";
    cancelPdvEdit.classList.remove("hidden");
    selectedPdvCategories.splice(0, selectedPdvCategories.length, ...(pdv.categorias || []));
    renderPdvCategories();
    setConfigTab("pdv");
    pdvForm.scrollIntoView({ behavior: "smooth", block: "start" });
  }));
  document.querySelectorAll("[data-delete-pdv]").forEach((button) => button.addEventListener("click", async () => {
    const pdv = state.pdvs.find((item) => String(item.id) === button.dataset.deletePdv);
    if (!pdv || !window.confirm(`Excluir o PDV ${pdv.nome}?`)) return;
    await request("/api/admin/pdvs", { method: "DELETE", body: JSON.stringify({ id: pdv.id }) });
    toast("PDV excluido.");
    await loadBootstrap();
    route("config");
  }));
  cancelPdvEdit.addEventListener("click", resetPdvForm);
  renderPdvCategories();
  document.querySelector("#pdv-form").addEventListener("submit", async (event) => {
    event.preventDefault();
    const formData = new FormData(event.currentTarget);
    const form = Object.fromEntries(formData);
    form.categorias = formData.getAll("categorias");
    const editing = Boolean(form.id);
    await request("/api/admin/pdvs", { method: editing ? "PATCH" : "POST", body: JSON.stringify(form) });
    toast(editing ? "PDV atualizado." : "PDV criado.");
    await loadBootstrap();
    route("config");
  });
  document.querySelector("#config-form").addEventListener("submit", async (event) => {
    event.preventDefault();
    await request("/api/admin/config", { method: "POST", body: JSON.stringify(Object.fromEntries(new FormData(event.currentTarget))) });
    toast("Configuracoes salvas.");
  });
}

async function viewConfigV2() {
  const categories = categoryOptions();
  const categorySelect = (id) => `
    <div class="category-picker">
      <p class="text-sm font-bold">Categorias permitidas para este PDV</p>
      <div class="category-select-row">
        <select id="${id}-select">
          <option value="">Selecione uma categoria</option>
          ${categories.map((category) => `<option value="${esc(category)}">${esc(category)}</option>`).join("")}
        </select>
        <button class="btn secondary" id="${id}-add" type="button">Adicionar</button>
      </div>
      <div class="category-picker-list" id="${id}-list">
        ${categories.length ? `<p class="text-sm text-slate-500">Nenhuma categoria adicionada ainda.</p>` : `<p class="text-sm text-slate-500">Cadastre categorias nos produtos para aparecerem aqui.</p>`}
      </div>
    </div>`;

  shell(`
    <section class="config-tabs-shell">
      <div class="config-tabs" role="tablist" aria-label="Configuracoes do sistema">
        <button class="config-tab is-active" type="button" data-config-tab="manage" role="tab" aria-selected="true">Gerenciar PDVs</button>
        <button class="config-tab" type="button" data-config-tab="pdv" role="tab" aria-selected="false">Criar PDV</button>
        <button class="config-tab" type="button" data-config-tab="security" role="tab" aria-selected="false">Seguranca</button>
        <button class="config-tab" type="button" data-config-tab="apis" role="tab" aria-selected="false">APIs</button>
      </div>

      <div class="config-tab-panels">
        <section class="config-panel is-active" data-config-panel="manage" role="tabpanel">
          <form id="pdv-edit-form" class="card grid gap-3 hidden">
            <input name="id" type="hidden" />
            <h3 class="text-xl font-black" id="pdv-edit-title">Editar PDV</h3>
            <input name="nome" placeholder="Nome do PDV" required />
            <input name="senha" type="password" placeholder="Nova senha (opcional)" />
            <input name="codigo_orion" placeholder="Codigo ORION" />
            ${categorySelect("edit-pdv-category")}
            <div class="form-actions">
              <button class="btn secondary" id="cancel-pdv-edit" type="button">Cancelar edicao</button>
              <button class="btn" type="submit">Salvar alteracoes</button>
            </div>
          </form>
          <section class="card mt-4">
            <div class="mb-3">
              <p class="eyebrow">Gestao</p>
              <h3 class="text-xl font-black">Gerenciar PDVs</h3>
            </div>
            ${table(["PDV", "ORION", "Categorias permitidas", "Acoes"], state.pdvs.map((p) => `<tr><td>${esc(p.nome)}</td><td>${esc(p.codigo_orion || "-")}</td><td>${esc((p.categorias || []).join(", ") || "-")}</td><td><div class="table-actions"><button class="icon-action" type="button" data-edit-pdv="${p.id}" title="Editar PDV" aria-label="Editar PDV">&#9998;</button><button class="icon-action danger" type="button" data-delete-pdv="${p.id}" title="Excluir PDV" aria-label="Excluir PDV">&times;</button></div></td></tr>`))}
          </section>
        </section>

        <section class="config-panel hidden" data-config-panel="pdv" role="tabpanel">
          <form id="pdv-create-form" class="card grid gap-3">
            <h3 class="text-xl font-black">Criar PDV</h3>
            <input name="nome" placeholder="Nome do PDV" required />
            <input name="senha" type="password" placeholder="Senha" required />
            <input name="codigo_orion" placeholder="Codigo ORION" />
            ${categorySelect("create-pdv-category")}
            <button class="btn">Criar PDV</button>
          </form>
        </section>

        <section class="config-panel hidden" data-config-panel="security" role="tabpanel">
          <form id="security-form" class="card grid gap-3">
            <h3 class="text-xl font-black">Seguranca do almoxarifado</h3>
            <input name="currentAdminPassword" type="password" placeholder="Senha atual do Almoxarifado" required />
            <input name="adminPassword" type="password" placeholder="Nova senha do Almoxarifado" required />
            <input name="confirmAdminPassword" type="password" placeholder="Confirmar nova senha" required />
            <button class="btn">Alterar senha</button>
          </form>
        </section>

        <section class="config-panel hidden" data-config-panel="apis" role="tabpanel">
          <form id="apis-form" class="card grid gap-3">
            <h3 class="text-xl font-black">APIs e integracoes</h3>
            <input name="omie_app_key" placeholder="Omie app key" />
            <input name="omie_app_secret" placeholder="Omie app secret" />
            <button class="btn">Salvar APIs</button>
          </form>
        </section>
      </div>
    </section>`);

  const setConfigTab = (tabId) => {
    document.querySelectorAll("[data-config-tab]").forEach((button) => {
      const active = button.dataset.configTab === tabId;
      button.classList.toggle("is-active", active);
      button.setAttribute("aria-selected", active ? "true" : "false");
    });
    document.querySelectorAll("[data-config-panel]").forEach((panel) => {
      const active = panel.dataset.configPanel === tabId;
      panel.classList.toggle("is-active", active);
      panel.classList.toggle("hidden", !active);
    });
  };
  document.querySelectorAll("[data-config-tab]").forEach((button) => button.addEventListener("click", () => setConfigTab(button.dataset.configTab)));

  const categoryPickers = {};
  const setupCategoryPicker = (id, initial = []) => {
    const selected = [...initial];
    const list = document.querySelector(`#${id}-list`);
    const render = () => {
      list.innerHTML = selected.length
        ? selected.map((category) => `<label class="category-chip selected-chip"><input name="categorias" type="hidden" value="${esc(category)}"><span>${esc(category)}</span><button class="chip-remove" type="button" data-category="${esc(category)}" aria-label="Remover categoria">x</button></label>`).join("")
        : `<p class="text-sm text-slate-500">Nenhuma categoria adicionada ainda.</p>`;
      list.querySelectorAll(".chip-remove").forEach((button) => button.addEventListener("click", () => {
        const index = selected.indexOf(button.dataset.category);
        if (index >= 0) selected.splice(index, 1);
        render();
      }));
    };
    document.querySelector(`#${id}-add`).addEventListener("click", () => {
      const select = document.querySelector(`#${id}-select`);
      const value = String(select.value || "").trim();
      if (value && !selected.includes(value)) selected.push(value);
      select.value = "";
      render();
    });
    categoryPickers[id] = {
      set(values) {
        selected.splice(0, selected.length, ...(values || []));
        render();
      }
    };
    render();
  };
  setupCategoryPicker("create-pdv-category");
  setupCategoryPicker("edit-pdv-category");

  const pdvEditForm = document.querySelector("#pdv-edit-form");
  const resetPdvEdit = () => {
    pdvEditForm.reset();
    pdvEditForm.classList.add("hidden");
    categoryPickers["edit-pdv-category"].set([]);
  };
  document.querySelectorAll("[data-edit-pdv]").forEach((button) => button.addEventListener("click", () => {
    const pdv = state.pdvs.find((item) => String(item.id) === button.dataset.editPdv);
    if (!pdv) return;
    pdvEditForm.classList.remove("hidden");
    pdvEditForm.querySelector('[name="id"]').value = pdv.id;
    pdvEditForm.querySelector('[name="nome"]').value = pdv.nome || "";
    pdvEditForm.querySelector('[name="senha"]').value = "";
    pdvEditForm.querySelector('[name="codigo_orion"]').value = pdv.codigo_orion || "";
    document.querySelector("#pdv-edit-title").textContent = `Editar PDV: ${pdv.nome}`;
    categoryPickers["edit-pdv-category"].set(pdv.categorias || []);
    setConfigTab("manage");
    pdvEditForm.scrollIntoView({ behavior: "smooth", block: "start" });
  }));
  document.querySelectorAll("[data-delete-pdv]").forEach((button) => button.addEventListener("click", async () => {
    const pdv = state.pdvs.find((item) => String(item.id) === button.dataset.deletePdv);
    if (!pdv || !window.confirm(`Excluir o PDV ${pdv.nome}?`)) return;
    await request("/api/admin/pdvs", { method: "DELETE", body: JSON.stringify({ id: pdv.id }) });
    toast("PDV excluido.");
    await loadBootstrap();
    route("config");
  }));
  document.querySelector("#cancel-pdv-edit").addEventListener("click", resetPdvEdit);
  pdvEditForm.addEventListener("submit", async (event) => {
    event.preventDefault();
    const formData = new FormData(event.currentTarget);
    const form = Object.fromEntries(formData);
    form.categorias = formData.getAll("categorias");
    await request("/api/admin/pdvs", { method: "PATCH", body: JSON.stringify(form) });
    toast("PDV atualizado.");
    await loadBootstrap();
    route("config");
  });
  document.querySelector("#pdv-create-form").addEventListener("submit", async (event) => {
    event.preventDefault();
    const formData = new FormData(event.currentTarget);
    const form = Object.fromEntries(formData);
    form.categorias = formData.getAll("categorias");
    await request("/api/admin/pdvs", { method: "POST", body: JSON.stringify(form) });
    toast("PDV criado.");
    await loadBootstrap();
    route("config");
  });
  document.querySelector("#security-form").addEventListener("submit", async (event) => {
    event.preventDefault();
    await request("/api/admin/config", { method: "POST", body: JSON.stringify(Object.fromEntries(new FormData(event.currentTarget))) });
    toast("Senha do almoxarifado atualizada.");
    event.currentTarget.reset();
  });
  document.querySelector("#apis-form").addEventListener("submit", async (event) => {
    event.preventDefault();
    await request("/api/admin/config", { method: "POST", body: JSON.stringify(Object.fromEntries(new FormData(event.currentTarget))) });
    toast("APIs salvas.");
  });
}

request("/api/auth/me")
  .then(async ({ user }) => {
    state.user = user;
    if (user) {
      await loadBootstrap();
      route(user.role === "admin" ? "dashboard" : "order");
    } else {
      renderLogin();
    }
  })
  .catch(renderLogin);
