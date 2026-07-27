export function toast(message, type = "ok", options = {}) {
  let root = document.querySelector("#toast-root");
  if (!root) {
    root = document.createElement("div");
    root.id = "toast-root";
    root.className = "toast-container";
    root.setAttribute("aria-live", "polite");
    root.setAttribute("aria-atomic", "true");
    document.body.appendChild(root);
  }
  const el = document.createElement("div");
  el.className = `toast ${type === "error" ? "toast-error" : "toast-ok"}`;
  el.textContent = message;
  if (typeof options.onClick === "function") {
    el.classList.add("toast-clickable");
    el.tabIndex = 0;
    el.setAttribute("role", "button");
    el.addEventListener("click", options.onClick);
    el.addEventListener("keydown", (event) => {
      if (event.key === "Enter" || event.key === " ") {
        event.preventDefault();
        options.onClick();
      }
    });
  }
  root.appendChild(el);
  setTimeout(() => el.remove(), 3200);
}
