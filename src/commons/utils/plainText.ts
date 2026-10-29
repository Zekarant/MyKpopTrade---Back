import DOMPurify from 'isomorphic-dompurify';

/**
 * Texte saisi par les membres, stocké en texte brut : ni balise, ni entité HTML.
 *
 * Le front affiche tout en texte échappé (aucun `v-html`) et les e-mails
 * échappent leurs valeurs : stocker « A&amp;B » au lieu de « A&B » faisait
 * afficher « A&amp;B » partout, et échapper deux fois dans les e-mails.
 */

/** Entités produites par la sérialisation de DOMPurify (et par un éventuel ancien encodage). */
const ENTITIES: Record<string, string> = {
  '&lt;': '<',
  '&gt;': '>',
  '&quot;': '"',
  '&#39;': '\'',
  '&nbsp;': ' ',
  '&amp;': '&'
};

const HTML_ENTITY = /&(?:lt|gt|quot|#39|nbsp|amp);/g;

/** Décode les entités en une seule passe : « &amp;lt; » redevient « &lt; », pas « < ». */
export function decodeHtmlEntities(value: string): string {
  return value.replace(HTML_ENTITY, (entity) => ENTITIES[entity]);
}

/** Retire balises et contenu actif (`<script>`, `onerror`…) et rend le texte lui-même. */
export function toPlainText(value: string): string {
  return decodeHtmlEntities(DOMPurify.sanitize(value, { ALLOWED_TAGS: [], ALLOWED_ATTR: [] }));
}
