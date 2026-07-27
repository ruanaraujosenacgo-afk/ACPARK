export const app = document.querySelector("#app");

export const state = {
  user: null,
  pdvs: [],
  products: [],
  categories: [],
  config: {},
  cart: [],
  orderIdempotencyKey: null,
  currentView: null,
  orderAlertPendingCount: 0
};
