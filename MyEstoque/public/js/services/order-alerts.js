import { request } from "../api/api-client.js";
import { state } from "../state/app-state.js";
import { toast } from "../ui/notifications.js";
import { esc } from "../ui.js";
import {
  activateAudioAlerts,
  audioIsActivated,
  enqueueOrderAlert,
  stopAllOrderAlerts,
  stopCurrentOrderAlert,
  testOrderAlert
} from "./audio-alert-manager.js";

const storageKey = "acparkNotifiedOrderEvents";
const viewedStorageKey = "acparkViewedOrderAlerts";
const silencedStorageKey = "acparkSilencedOrderAlerts";
const activeStorageKey = "acparkActiveOrderAlerts";
const focusOrderKey = "acparkFocusReleaseOrder";
const tabLockPrefix = "acparkOrderAlertLock:";
const channelName = "acpark-order-alerts";
const defaultPreferences = {
  enabled: true,
  soundId: "repetitive-alert",
  volume: 70,
  visualNotifications: true,
  repeatMode: "three_times",
  repeatIntervalSeconds: 5,
  stopOnView: true,
  stopOnServiceStart: true
};

let eventSource = null;
let fallbackTimer = null;
let preferences = { ...defaultPreferences };
let sounds = [];
let routeCallback = null;
let refreshReleaseCallback = null;
let lastPendingBaseline = null;
let lastPendingIds = new Set();
const notifiedEventIds = new Set(readStoredEvents());
const viewedAlertIds = new Set(readStoredList(viewedStorageKey));
const silencedAlertIds = new Set(readStoredList(silencedStorageKey));
const activeAlerts = new Map(readStoredActiveAlerts().map((alert) => [alert.orderId, alert]));
const tabId = crypto.randomUUID();
const broadcast = "BroadcastChannel" in window ? new BroadcastChannel(channelName) : null;

function readStoredEvents() {
  return readStoredList(storageKey);
}

function readStoredList(key) {
  try {
    return JSON.parse(sessionStorage.getItem(key) || "[]");
  } catch {
    return [];
  }
}

function rememberListValue(key, set, value) {
  if (!value) return;
  set.add(String(value));
  const values = [...set].slice(-160);
  sessionStorage.setItem(key, JSON.stringify(values));
}

function readStoredActiveAlerts() {
  try {
    const alerts = JSON.parse(sessionStorage.getItem(activeStorageKey) || "[]");
    if (!Array.isArray(alerts)) return [];
    const now = Date.now();
    return alerts.filter((alert) => alert?.orderId && now - Number(alert.savedAt || now) < 6 * 60 * 60 * 1000);
  } catch {
    return [];
  }
}

function persistActiveAlerts() {
  const alerts = [...activeAlerts.values()].slice(-20).map((alert) => ({
    ...alert,
    savedAt: alert.savedAt || Date.now()
  }));
  sessionStorage.setItem(activeStorageKey, JSON.stringify(alerts));
}

function rememberEvent(eventId) {
  if (!eventId) return;
  rememberListValue(storageKey, notifiedEventIds, eventId);
}

function isDismissed(orderId, eventId) {
  return viewedAlertIds.has(String(orderId)) || silencedAlertIds.has(String(orderId))
    || viewedAlertIds.has(String(eventId)) || silencedAlertIds.has(String(eventId));
}

function canThisTabPlay(eventId) {
  if (!eventId) return true;
  const key = `${tabLockPrefix}${eventId}`;
  const now = Date.now();
  try {
    const current = JSON.parse(localStorage.getItem(key) || "null");
    if (current?.tabId && current.tabId !== tabId && now - Number(current.at || 0) < 15000) return false;
    localStorage.setItem(key, JSON.stringify({ tabId, at: now }));
    return true;
  } catch {
    return true;
  }
}

function normalizePreferences(next = {}) {
  return {
    ...defaultPreferences,
    ...next,
    volume: Math.max(0, Math.min(100, Number(next.volume ?? defaultPreferences.volume))),
    repeatIntervalSeconds: [3, 5, 10, 15, 30].includes(Number(next.repeatIntervalSeconds))
      ? Number(next.repeatIntervalSeconds)
      : defaultPreferences.repeatIntervalSeconds
  };
}

function orderIdFromEvent(event = {}) {
  return String(event.orderId || event.orderNumber || event.eventId || "");
}

function ensureOrderAlertContainer() {
  let root = document.querySelector("#order-alert-root");
  if (!root) {
    root = document.createElement("div");
    root.id = "order-alert-root";
    root.className = "order-alert-container";
    root.setAttribute("aria-live", "polite");
    root.setAttribute("aria-atomic", "false");
    document.body.appendChild(root);
  }
  return root;
}

function updateActivationButton() {
  const button = document.querySelector("#order-alert-activate");
  if (!button) return;
  const shouldShow = state.user?.role === "admin" && preferences.enabled && !audioIsActivated();
  button.classList.toggle("hidden", !shouldShow);
}

export async function activateOrderAlertAudio() {
  const ok = await activateAudioAlerts();
  updateActivationButton();
  if (ok) {
    requeueActiveAudioAlerts();
    toast("Alertas sonoros ativados.");
  }
  return ok;
}

function requeueActiveAudioAlerts() {
  activeAlerts.forEach((alert) => {
    if (isDismissed(alert.orderId, alert.eventId) || !canThisTabPlay(alert.eventId)) return;
    enqueueOrderAlert({
      orderId: alert.orderId,
      preferences,
      shouldStop: () => shouldStopByStatus(alert.orderId)
    });
  });
}

function removeAlertCard(orderId) {
  document.querySelector(`[data-order-alert-card="${CSS.escape(String(orderId))}"]`)?.remove();
  activeAlerts.delete(String(orderId));
  persistActiveAlerts();
}

function markAlertStopped(orderId, eventId, reason) {
  const key = reason === "VIEWED" ? viewedStorageKey : silencedStorageKey;
  const set = reason === "VIEWED" ? viewedAlertIds : silencedAlertIds;
  rememberListValue(key, set, orderId);
  rememberListValue(key, set, eventId);
  stopAllOrderAlerts();
  removeAlertCard(orderId);
  broadcast?.postMessage({ type: "ORDER_ALERT_STOPPED", orderId, eventId, reason });
}

function openReleaseAndStop(orderId, eventId, button = null) {
  if (button) {
    button.disabled = true;
    button.textContent = "Abrindo pedido...";
  }
  stopAllOrderAlerts();
  markAlertStopped(orderId, eventId, "VIEWED");
  sessionStorage.setItem(focusOrderKey, String(orderId));
  routeCallback?.("release");
}

function silenceOrder(orderId, eventId, button = null) {
  if (button) {
    button.disabled = true;
    button.textContent = "Silenciando...";
  }
  markAlertStopped(orderId, eventId, "SILENCED");
}

function showOrderToast(event) {
  if (!preferences.visualNotifications) return;
  const orderId = orderIdFromEvent(event);
  const eventId = event.eventId || orderId;
  if (!orderId || isDismissed(orderId, eventId)) return;
  if (document.querySelector(`[data-order-alert-card="${CSS.escape(orderId)}"]`)) return;
  const root = ensureOrderAlertContainer();
  const itemCount = Number(event.itemCount || 0);
  const node = document.createElement("div");
  node.className = "toast ok order-alert-toast";
  node.dataset.orderAlertCard = orderId;
  node.setAttribute("role", "status");
  node.innerHTML = `
    <div class="order-alert-toast-title">Novo pedido recebido</div>
    <div class="order-alert-toast-meta">
      <strong>${esc(event.orderNumber || "Pedido")}</strong>
      <span>${esc(event.pointName || "PDV")}</span>
      <span>${itemCount ? `${itemCount} produto(s)` : "Aguardando itens"}</span>
    </div>
    <div class="order-alert-toast-actions">
      <button type="button" class="toast-action-btn" data-order-alert-view>Visualizar</button>
      <button type="button" class="toast-action-btn secondary" data-order-alert-silence>Silenciar alerta</button>
    </div>
  `;
  node.querySelector("[data-order-alert-view]")?.addEventListener("click", (clickEvent) => {
    openReleaseAndStop(orderId, eventId, clickEvent.currentTarget);
  });
  node.querySelector("[data-order-alert-silence]")?.addEventListener("click", (clickEvent) => {
    silenceOrder(orderId, eventId, clickEvent.currentTarget);
  });
  root.appendChild(node);
  activeAlerts.set(orderId, {
    eventId,
    orderId,
    orderNumber: event.orderNumber || "Pedido",
    pointName: event.pointName || "PDV",
    itemCount,
    createdAt: event.createdAt || new Date().toISOString(),
    status: "ALERTING",
    savedAt: Date.now()
  });
  persistActiveAlerts();
}

function showPendingSnapshotAlerts(snapshot = {}) {
  if (!preferences.visualNotifications || state.user?.role !== "admin") return;
  const orders = Array.isArray(snapshot.orders) ? snapshot.orders : [];
  for (const order of orders) {
    const orderId = orderIdFromEvent(order);
    const eventId = order.eventId || `pending:${orderId}`;
    if (!orderId || !snapshot.ids?.has(orderId) || isDismissed(orderId, eventId)) continue;
    showOrderToast({ ...order, eventId });
  }
}

async function fetchPendingSnapshot() {
  const summary = await request("/api/admin/order-alert-summary", { silentLoading: true });
  const ids = Array.isArray(summary.pendingOrderIds)
    ? summary.pendingOrderIds.map(String).filter(Boolean)
    : Array.isArray(summary.pendingOrders)
      ? summary.pendingOrders.map((item) => String(item.orderId || item.orderNumber)).filter(Boolean)
      : [];
  return {
    count: Number(summary.pending || 0),
    ids: new Set(ids),
    orders: Array.isArray(summary.pendingOrders) ? summary.pendingOrders : []
  };
}

async function refreshCountersOnly() {
  if (state.user?.role !== "admin") return null;
  try {
    const snapshot = await fetchPendingSnapshot();
    state.orderAlertPendingCount = snapshot.count;
    document.querySelectorAll("[data-global-release-count]").forEach((node) => {
      node.textContent = String(state.orderAlertPendingCount || 0);
      node.classList.toggle("hidden", !state.orderAlertPendingCount);
    });
    reconcileActiveAlerts(snapshot.ids);
    return snapshot;
  } catch {
    return null;
  }
}

async function refreshReleaseIfOpen() {
  const snapshot = await refreshCountersOnly();
  if (state.currentView === "release") {
    await refreshReleaseCallback?.();
  }
  return snapshot;
}

function shouldStopByStatus(orderId) {
  if (!preferences.stopOnServiceStart || !orderId) return false;
  return !lastPendingIds.has(String(orderId));
}

function reconcileActiveAlerts(pendingIds = new Set()) {
  for (const [orderId, alert] of activeAlerts.entries()) {
    if (!pendingIds.has(String(orderId)) && preferences.stopOnServiceStart) {
      markAlertStopped(orderId, alert.eventId, "SERVICE_STARTED");
    }
  }
}

async function handleNewOrderEvent(event) {
  const orderId = orderIdFromEvent(event);
  const eventId = event.eventId || `${event.orderNumber || ""}:${event.createdAt || ""}`;
  if (!eventId || notifiedEventIds.has(eventId) || isDismissed(orderId, eventId)) return;
  rememberEvent(eventId);
  broadcast?.postMessage({ type: "order-alert-processed", eventId });
  showOrderToast(event);
  if (canThisTabPlay(eventId)) {
    if (orderId) lastPendingIds.add(orderId);
    enqueueOrderAlert({
      orderId: orderId || eventId,
      preferences,
      shouldStop: () => shouldStopByStatus(orderId)
    });
  }
  await refreshReleaseIfOpen();
}

async function startFallbackPolling() {
  if (fallbackTimer || state.user?.role !== "admin") return;
  try {
    const snapshot = await fetchPendingSnapshot();
    lastPendingBaseline = snapshot.count;
    lastPendingIds = snapshot.ids;
    state.orderAlertPendingCount = snapshot.count;
    showPendingSnapshotAlerts(snapshot);
  } catch {
    lastPendingBaseline = 0;
    lastPendingIds = new Set();
  }
  fallbackTimer = setInterval(async () => {
    if (state.user?.role !== "admin") return;
    try {
      const snapshot = await fetchPendingSnapshot();
      showPendingSnapshotAlerts(snapshot);
      const newOrders = snapshot.orders.filter((item) => {
        const orderId = String(item.orderId || item.orderNumber || "");
        return orderId && !lastPendingIds.has(orderId);
      });
      for (const order of newOrders) {
        const eventId = `fallback:${order.orderId || order.orderNumber}`;
        if (notifiedEventIds.has(eventId)) continue;
        await handleNewOrderEvent({ ...order, eventId });
      }
      if (!newOrders.length && lastPendingBaseline !== null && snapshot.count > lastPendingBaseline) {
        const eventId = `fallback:count:${snapshot.count}:${Date.now()}`;
        toast(snapshot.count - lastPendingBaseline === 1 ? "Novo pedido recebido." : "Novos pedidos recebidos.");
        if (canThisTabPlay(eventId)) {
          enqueueOrderAlert({ orderId: eventId, preferences, shouldStop: () => false });
        }
        await refreshReleaseIfOpen();
      }
      lastPendingBaseline = snapshot.count;
      lastPendingIds = snapshot.ids;
      state.orderAlertPendingCount = snapshot.count;
    } catch {
      // Tenta de novo no proximo ciclo.
    }
  }, 12000);
}

export async function startOrderAlerts(options = {}) {
  if (state.user?.role !== "admin") {
    stopOrderAlerts();
    return;
  }
  routeCallback = options.route || routeCallback;
  refreshReleaseCallback = options.refreshRelease || refreshReleaseCallback;
  try {
    const data = await request("/api/user/order-alert-preferences", { silentLoading: true });
    preferences = normalizePreferences(data.preferences || preferences);
    sounds = data.sounds || [];
  } catch {
    preferences = { ...defaultPreferences };
  }
  updateActivationButton();
  activeAlerts.forEach((alert) => {
    if (!isDismissed(alert.orderId, alert.eventId)) showOrderToast(alert);
  });
  const snapshot = await refreshCountersOnly();
  if (snapshot) {
    lastPendingBaseline = snapshot.count;
    lastPendingIds = snapshot.ids;
    showPendingSnapshotAlerts(snapshot);
  }
  if (eventSource) return;
  if (!window.EventSource) {
    await startFallbackPolling();
    return;
  }
  eventSource = new EventSource("/api/admin/order-alert-events");
  eventSource.addEventListener("NEW_PENDING_ORDER", (message) => {
    try {
      handleNewOrderEvent(JSON.parse(message.data || "{}"));
    } catch {
      toast("Novo pedido recebido.");
    }
  });
  eventSource.onerror = () => {
    eventSource?.close();
    eventSource = null;
    startFallbackPolling();
  };
}

export function stopOrderAlerts() {
  eventSource?.close();
  eventSource = null;
  if (fallbackTimer) clearInterval(fallbackTimer);
  fallbackTimer = null;
  lastPendingBaseline = null;
  lastPendingIds = new Set();
  stopAllOrderAlerts();
  document.querySelector("#order-alert-root")?.remove();
  activeAlerts.clear();
  persistActiveAlerts();
}

broadcast?.addEventListener("message", (event) => {
  if (event.data?.type === "order-alert-processed" && event.data.eventId) {
    rememberEvent(event.data.eventId);
  }
  if (event.data?.type === "order-alert-silenced") {
    stopAllOrderAlerts();
  }
  if (event.data?.type === "ORDER_ALERT_STOPPED") {
    const reason = event.data.reason === "VIEWED" ? "VIEWED" : "SILENCED";
    const key = reason === "VIEWED" ? viewedStorageKey : silencedStorageKey;
    const set = reason === "VIEWED" ? viewedAlertIds : silencedAlertIds;
    rememberListValue(key, set, event.data.orderId);
    rememberListValue(key, set, event.data.eventId);
    stopAllOrderAlerts();
    removeAlertCard(event.data.orderId);
  }
});

function renderSoundOptions() {
  const soundOptions = sounds.length ? sounds : [
    { id: "repetitive-alert", displayName: "Alerta repetitivo" },
    { id: "repetitive-bell", displayName: "Campainha repetitiva" },
    { id: "urgent", displayName: "Chamada urgente" },
    { id: "waiting", displayName: "Pedido aguardando" },
    { id: "soft-continuous", displayName: "Alerta continuo suave" },
    { id: "default", displayName: "Alerta padrao" }
  ];
  return soundOptions
    .map((sound) => `<option value="${esc(sound.id)}" ${sound.id === preferences.soundId ? "selected" : ""}>${esc(sound.displayName)}</option>`)
    .join("");
}

export function renderOrderAlertSettings() {
  preferences = normalizePreferences(preferences);
  return `
    <form id="order-alert-settings-form" class="card grid gap-4">
      <div>
        <p class="eyebrow">Alertas de novos pedidos</p>
        <h3 class="text-xl font-black">Alerta sonoro global</h3>
        <p class="text-sm text-slate-500">Funciona para o Almoxarifado em qualquer pagina interna enquanto o sistema estiver aberto.</p>
      </div>
      <label class="alert-toggle-row">
        <input name="enabled" type="checkbox" ${preferences.enabled ? "checked" : ""} />
        <span>Ativar alerta sonoro</span>
      </label>
      <div class="alert-settings-grid">
        <label class="grid gap-1 text-sm font-bold">Toque
          <select name="soundId">${renderSoundOptions()}</select>
        </label>
        <label class="grid gap-1 text-sm font-bold">Repeticao
          <select name="repeatMode">
            <option value="once" ${preferences.repeatMode === "once" ? "selected" : ""}>Tocar uma vez</option>
            <option value="two_times" ${preferences.repeatMode === "two_times" ? "selected" : ""}>Tocar 2 vezes</option>
            <option value="three_times" ${preferences.repeatMode === "three_times" ? "selected" : ""}>Tocar 3 vezes</option>
            <option value="thirty_seconds" ${preferences.repeatMode === "thirty_seconds" ? "selected" : ""}>Repetir por 30 segundos</option>
            <option value="until_viewed" ${preferences.repeatMode === "until_viewed" ? "selected" : ""}>Repetir ate visualizar</option>
            <option value="until_service_start" ${preferences.repeatMode === "until_service_start" ? "selected" : ""}>Repetir ate iniciar atendimento</option>
          </select>
        </label>
        <label class="grid gap-1 text-sm font-bold">Intervalo
          <select name="repeatIntervalSeconds">
            ${[3, 5, 10, 15, 30].map((seconds) => `<option value="${seconds}" ${Number(preferences.repeatIntervalSeconds) === seconds ? "selected" : ""}>${seconds} segundos</option>`).join("")}
          </select>
        </label>
      </div>
      <label class="grid gap-2 text-sm font-bold">Volume
        <div class="alert-volume-row">
          <input name="volume" type="range" min="0" max="100" value="${Number(preferences.volume || 70)}" />
          <strong id="order-alert-volume-label">${Number(preferences.volume || 70)}%</strong>
        </div>
      </label>
      <div class="alert-settings-grid">
        <label class="alert-toggle-row">
          <input name="visualNotifications" type="checkbox" ${preferences.visualNotifications ? "checked" : ""} />
          <span>Exibir notificacao visual</span>
        </label>
        <label class="alert-toggle-row">
          <input name="stopOnView" type="checkbox" ${preferences.stopOnView ? "checked" : ""} />
          <span>Parar ao visualizar a Liberacao</span>
        </label>
        <label class="alert-toggle-row">
          <input name="stopOnServiceStart" type="checkbox" ${preferences.stopOnServiceStart ? "checked" : ""} />
          <span>Parar quando o atendimento iniciar</span>
        </label>
      </div>
      <div class="order-card-actions">
        <button class="btn secondary" id="test-order-alert-sound" type="button">Testar alerta</button>
        <button class="btn secondary" id="stop-order-alert-sound" type="button">Parar teste</button>
        <button class="btn secondary" id="activate-order-alert-audio" type="button">Ativar audio neste navegador</button>
        <button class="btn secondary" id="restore-order-alert-default" type="button">Restaurar padrao</button>
        <button class="btn" type="submit">Salvar configuracoes</button>
      </div>
      <p class="text-sm text-slate-500">Os toques sao gerados pelo proprio sistema, sem copiar sons externos.</p>
    </form>`;
}

function payloadFromForm(form) {
  return {
    enabled: form.enabled.checked,
    soundId: form.soundId.value,
    volume: Number(form.volume.value || 70),
    visualNotifications: form.visualNotifications.checked,
    repeatMode: form.repeatMode.value,
    repeatIntervalSeconds: Number(form.repeatIntervalSeconds.value || 5),
    stopOnView: form.stopOnView.checked,
    stopOnServiceStart: form.stopOnServiceStart.checked
  };
}

export function bindOrderAlertSettings() {
  const form = document.querySelector("#order-alert-settings-form");
  if (!form) return;
  const volume = form.querySelector('[name="volume"]');
  const enabled = form.querySelector('[name="enabled"]');
  const label = document.querySelector("#order-alert-volume-label");
  volume?.addEventListener("input", () => {
    label.textContent = Number(volume.value) === 0 ? "Silenciado" : `${volume.value}%`;
  });
  enabled?.addEventListener("change", async () => {
    if (enabled.checked) await activateOrderAlertAudio();
    updateActivationButton();
  });
  document.querySelector("#activate-order-alert-audio")?.addEventListener("click", activateOrderAlertAudio);
  document.querySelector("#test-order-alert-sound")?.addEventListener("click", async () => {
    await activateOrderAlertAudio();
    await testOrderAlert(payloadFromForm(form));
  });
  document.querySelector("#stop-order-alert-sound")?.addEventListener("click", () => stopCurrentOrderAlert());
  document.querySelector("#restore-order-alert-default")?.addEventListener("click", () => {
    form.enabled.checked = true;
    form.soundId.value = "repetitive-alert";
    form.volume.value = 70;
    form.visualNotifications.checked = true;
    form.repeatMode.value = "three_times";
    form.repeatIntervalSeconds.value = 5;
    form.stopOnView.checked = true;
    form.stopOnServiceStart.checked = true;
    label.textContent = "70%";
  });
  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    const payload = payloadFromForm(form);
    if (payload.enabled) await activateOrderAlertAudio();
    const data = await request("/api/user/order-alert-preferences", {
      method: "PUT",
      body: JSON.stringify(payload)
    });
    preferences = normalizePreferences(data.preferences || payload);
    updateActivationButton();
    toast("Configuracao de alertas salva.");
  });
}
