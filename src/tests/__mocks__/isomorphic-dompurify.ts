/**
 * isomorphic-dompurify pour les tests Jest : la bibliothèque publiée (ESM, via
 * jsdom) ne se charge pas dans le setup CommonJS du projet.
 *
 * Imitation de son comportement avec `ALLOWED_TAGS: []`, le seul réglage employé
 * (commons/utils/plainText.ts), vérifiée sur la vraie bibliothèque : contenu de
 * <script>/<style> retiré, autres balises retirées en gardant leur texte, puis
 * sérialisation HTML du texte (`&`, `<`, `>` encodés).
 */
export default {
  sanitize: (input: unknown) =>
    String(input)
      .replace(/<(script|style)\b[\s\S]*?<\/\1>/gi, '')
      .replace(/<\/?[a-z][^>]*>/gi, '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
};
