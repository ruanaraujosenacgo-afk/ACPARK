const loadingState = {
  count: 0,
  timer: null,
  message: "Carregando..."
};

function ensureLoadingIndicator() {
  let el = document.querySelector("#global-loading");
  if (el) return el;
  el = document.createElement("div");
  el.id = "global-loading";
  el.className = "global-loading";
  el.setAttribute("role", "status");
  el.setAttribute("aria-live", "polite");
  el.innerHTML = `
    <div class="loading-progress"></div>
    <div class="loading-pill">
      <span class="loading-spinner" aria-hidden="true"></span>
      <span class="loading-text">Carregando...</span>
    </div>`;
  document.body.appendChild(el);
  return el;
}

function setLoadingMessage(message) {
  const el = ensureLoadingIndicator();
  const text = el.querySelector(".loading-text");
  if (text) text.textContent = message || "Carregando...";
}

export function beginLoading(message = "Carregando...") {
  loadingState.count += 1;
  loadingState.message = message;
  setLoadingMessage(message);
  document.body.classList.add("is-busy");
  if (loadingState.count === 1) {
    clearTimeout(loadingState.timer);
    loadingState.timer = setTimeout(() => {
      ensureLoadingIndicator().classList.add("is-visible");
    }, 180);
  }
  return () => endLoading();
}

export function endLoading() {
  loadingState.count = Math.max(0, loadingState.count - 1);
  if (loadingState.count > 0) return;
  clearTimeout(loadingState.timer);
  loadingState.timer = null;
  document.body.classList.remove("is-busy");
  ensureLoadingIndicator().classList.remove("is-visible");
}
