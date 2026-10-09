const HTML_ENTITIES: Record<string, string> = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#39;'
};

/**
 * Échappe une chaîne avant de l'insérer dans du HTML (texte ou valeur
 * d'attribut entre guillemets). Les emails reprennent des pseudos, titres
 * d'annonces et messages saisis par les membres : sans échappement, un pseudo
 * comme `<a href=…>` deviendrait un lien d'hameçonnage signé MyKpopTrade.
 */
export function escapeHtml(input: string): string {
  return input.replace(/[&<>"']/g, (char) => HTML_ENTITIES[char]);
}
