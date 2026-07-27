export function mapLocalProductToOmie(product) {
  return {
    codigo: product?.sku || product?.codigo || "",
    descricao: product?.nome || "",
    unidade: product?.unidade_medida || "UN"
  };
}
