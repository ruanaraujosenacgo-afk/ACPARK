import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

const app = fs.readFileSync(new URL("../public/app.js", import.meta.url), "utf8");
const styles = fs.readFileSync(new URL("../public/styles.css", import.meta.url), "utf8");
const routes = fs.readFileSync(new URL("../server/modules/pedidos/pedidos.routes.js", import.meta.url), "utf8");
const service = fs.readFileSync(new URL("../server/modules/pedidos/pedidos.service.js", import.meta.url), "utf8");

test("release screen exposes bulk product selection and delete action", () => {
  assert.match(app, /bulk-order-item/);
  assert.match(app, /delete-selected-order-items/);
  assert.match(app, /0 produtos selecionados/);
  assert.match(app, /Excluir selecionados/);
});

test("release screen saves draft and releases only entered quantities", () => {
  assert.match(app, /save-release-draft/);
  assert.match(app, /Salvar rascunho/);
  assert.match(app, /Enviar para retirada/);
  assert.match(app, /data-release-mode="entered-only"/);
  assert.match(app, /release_mode: releaseMode/);
  assert.doesNotMatch(app, /Liberar completo/);
  assert.doesNotMatch(app, /Liberar parcial/);
  assert.doesNotMatch(app, /Liberação Parcial/);
});

test("deleting products preserves draft values for remaining items", () => {
  assert.match(app, /function removeReleaseDraftItems/);
  assert.match(app, /removeReleaseDraftItems\(card\.dataset\.order, selectedItems\.map/);
  assert.match(app, /removeReleaseDraftItems\(card\.dataset\.order, \[itemId\]\)/);
});

test("release pending items can be selected even when input is prefilled", () => {
  assert.match(app, /const savedReleaseQty = Number\(o\.quantidade_liberada \|\| 0\)/);
  assert.match(app, /const canBulkDeleteItem = canRemoveProducts/);
  assert.doesNotMatch(app, /canBulkDeleteItem = canRemoveProducts[\s\S]*savedReleaseQty > 0/);
});

test("bulk delete uses system modal with product details", () => {
  assert.match(app, /confirmSystem\(\{/);
  assert.match(app, /detailsHtml/);
  assert.match(app, /system-confirm-list/);
  assert.match(app, /error\.status !== 404/);
  assert.match(app, /\/api\/admin\/order-item/);
  assert.doesNotMatch(app, /confirm\(`Deseja excluir/);
});

test("delete order button no longer has partial release mode", () => {
  assert.doesNotMatch(app, /Excluir somente a parte pendente/);
  assert.doesNotMatch(app, /confirmLabel: isPartialDelete/);
  assert.doesNotMatch(app, /full_delete: true/);
  assert.doesNotMatch(routes, /const fullDelete = body\.full_delete/);
  assert.doesNotMatch(routes, /deleteStatus === "Libera[\s\S]*&& !fullDelete/);
});

test("bulk delete route validates status and version", () => {
  assert.match(routes, /url\.pathname === "\/api\/admin\/order-items"/);
  assert.match(routes, /Produtos s/);
  assert.doesNotMatch(routes, /produto j[\s\S]{0,160}Libera/);
  assert.match(routes, /Conflito de edi/);
  assert.match(routes, /FOR UPDATE/);
});

test("order flow supports entered-only release mode without automatic completion", () => {
  assert.match(routes, /release_mode === "entered-only"/);
  assert.match(routes, /ALTER TABLE pedidos ADD COLUMN IF NOT EXISTS release_mode TEXT/);
  assert.match(routes, /release_mode = \$6/);
  assert.match(routes, /releaseMode === "entered-only"[\s\S]*\? requestedReleaseQty/);
  assert.match(routes, /Informe a quantidade que deseja liberar em pelo menos um produto/);
});

test("entered-only release does not create automatic partial remainder on withdrawal", () => {
  assert.match(routes, /release_mode/);
  assert.doesNotMatch(routes, /quantidade_solicitada = CASE WHEN \$6 = 'entered-only'/);
  assert.doesNotMatch(routes, /const suppressRemainder = row\.release_mode === "entered-only"/);
  assert.doesNotMatch(routes, /missingQty > 0 && !hasSeparateRemainder && !suppressRemainder/);
  assert.doesNotMatch(routes, /VALUES \(\$1, \$2, \$3, \$4, \$5, 0, 'Libera/);
});

test("returning an order to in progress regroups all split status items", () => {
  assert.match(routes, /if \(orderCode && nextStatus === "Em Andamento"\)/);
  assert.match(routes, /WHERE codigo_pedido = \$1\s+ORDER BY id\s+FOR UPDATE/);
  assert.match(routes, /group\.releasedTotal \+ pendingQty/);
  assert.match(routes, /DELETE FROM pedidos WHERE id = ANY\(\$1::int\[\]\)/);
});

test("moving release to withdrawal merges existing pending withdrawal item", () => {
  assert.match(routes, /itemStatus === "Aguardando Retirada"/);
  assert.match(routes, /AND sku_produto = \$2[\s\S]*AND status = 'Aguardando Retirada'[\s\S]*AND id <> \$3/);
  assert.match(routes, /quantidade_liberada = COALESCE\(quantidade_liberada, 0\) \+ \$2/);
  assert.match(routes, /DELETE FROM pedidos WHERE id = \$1/);
});

test("bulk delete styles keep controls usable on release table", () => {
  assert.match(styles, /\.release-select-control/);
  assert.match(styles, /\.release-bulk-actions/);
  assert.match(styles, /\.system-confirm-details/);
});

test("release partial status is no longer offered as a server action", () => {
  assert.match(service, /orderStatuses = \["Pendente", "Em Andamento", "Aguardando Retirada", "Finalizado"\]/);
  assert.match(service, /normalizeOrderStatus\(status\)/);
  assert.doesNotMatch(service, /orderStatuses = \["Pendente", "Em Andamento", "Aguardando Retirada", "Libera/);
  assert.doesNotMatch(routes, /const deleteStatus = orderStatuses\.includes\(body\.status\) \? body\.status : ""/);
  assert.match(routes, /const requestStatus = orderStatuses\.includes\(body\.status\) \? body\.status : ""/);
  assert.doesNotMatch(routes, /nextStatus === "Libera/);
});

test("partial order delete path was removed", () => {
  assert.doesNotMatch(routes, /if \(deleteStatus === "Libera[\s\S]*&& !fullDelete\)/);
  assert.doesNotMatch(routes, /COALESCE\(quantidade_liberada, 0\) <= 0/);
  assert.match(routes, /DELETE FROM pedidos WHERE codigo_pedido = \$1 RETURNING id/);
});
