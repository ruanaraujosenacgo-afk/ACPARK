const autoRefreshState = {
  timer: null,
  key: null,
  running: false,
  callback: null,
  ignoreEditing: false,
  guard: null
};

export function stopAutoRefresh() {
  if (autoRefreshState.timer) clearInterval(autoRefreshState.timer);
  autoRefreshState.timer = null;
  autoRefreshState.key = null;
  autoRefreshState.running = false;
  autoRefreshState.callback = null;
  autoRefreshState.ignoreEditing = false;
  autoRefreshState.guard = null;
}

function userIsEditing() {
  const active = document.activeElement;
  if (!active) return false;
  return ["INPUT", "TEXTAREA", "SELECT"].includes(active.tagName) || active.isContentEditable;
}

function formHasChanges(form) {
  return [...form.elements].some((field) => {
    if (!field || field.disabled || !field.name && field.type !== "file") return false;
    if (field.type === "file") return field.files?.length > 0;
    if (field.type === "checkbox" || field.type === "radio") return field.checked !== field.defaultChecked;
    if (field.tagName === "SELECT") {
      return [...field.options].some((option) => option.selected !== option.defaultSelected);
    }
    return field.value !== field.defaultValue;
  });
}

function userHasUnfinishedWork() {
  if (userIsEditing()) return true;
  if (document.querySelector(".system-confirm-modal, .damage-status-modal, .photo-viewer-dialog")) return true;
  if (document.querySelector("[data-autorefresh-lock='true'], .is-saving, .is-processing")) return true;
  return [...document.querySelectorAll("form")].some(formHasChanges);
}

export function startAutoRefresh(key, callback, interval = 8000, options = {}) {
  const ignoreEditing = Boolean(options.ignoreEditing);
  const guard = typeof options.guard === "function" ? options.guard : null;
  if (autoRefreshState.key === key && autoRefreshState.timer) {
    autoRefreshState.callback = callback;
    autoRefreshState.ignoreEditing = ignoreEditing;
    autoRefreshState.guard = guard;
    return;
  }
  stopAutoRefresh();
  autoRefreshState.key = key;
  autoRefreshState.callback = callback;
  autoRefreshState.ignoreEditing = ignoreEditing;
  autoRefreshState.guard = guard;
  autoRefreshState.timer = setInterval(async () => {
    if (
      document.hidden
      || autoRefreshState.running
      || (!autoRefreshState.ignoreEditing && userHasUnfinishedWork())
      || (autoRefreshState.guard && autoRefreshState.guard() === false)
    ) return;
    autoRefreshState.running = true;
    try {
      await autoRefreshState.callback?.();
    } catch (error) {
      console.warn("Falha ao atualizar automaticamente.", error);
    } finally {
      autoRefreshState.running = false;
    }
  }, interval);
}
