import { decodeHtmlEntities } from '../../commons/utils/plainText';

/**
 * isomorphic-dompurify pour les tests Jest : la bibliothèque publiée (ESM, via
 * jsdom) ne se charge pas dans le setup CommonJS du projet.
 *
 * Imitation de son comportement avec `ALLOWED_TAGS: []`, le seul réglage employé
 * (commons/utils/plainText.ts), vérifiée sur la vraie bibliothèque, dans le même
 * ordre que le parseur : contenu de <script>/<style> retiré, autres balises
 * retirées en gardant leur texte, entités du texte décodées (« &lt;a&gt; » est du
 * texte, pas une balise), puis sérialisation HTML (`&`, `<`, `>` encodés).
 */
export default {
  sanitize: (input: unknown) =>
    decodeHtmlEntities(
      String(input)
        .replace(/<(script|style)\b[\s\S]*?<\/\1>/gi, '')
        .replace(/<\/?[a-z][^>]*>/gi, '')
    )
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
};
