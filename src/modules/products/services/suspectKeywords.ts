/**
 * Liste de mots-clés déclenchant une analyse IA d'une annonce. Volontairement
 * large : un mot détecté ne bloque rien en soi, il déclenche juste l'appel à
 * Mistral (`productModerationService`) qui tranche en tenant compte du
 * contexte. Éditable librement — versionner (`SUSPECT_KEYWORDS_VERSION`) à
 * chaque changement notable pour garder une trace dans `moderationFlag`.
 */
export const SUSPECT_KEYWORDS_VERSION = 'v2';

/** Reproduction non officielle vendue comme authentique. */
const COUNTERFEIT_KEYWORDS = [
  'contrefaçon', 'contrefacon', 'contrefait', 'contrefaite',
  'réplique', 'replique', 'replica', 'bootleg', 'counterfeit',
  'copie non officielle', 'fake officiel', 'faux officiel'
];

/** Tentative de contourner la plateforme (paiement direct, contact hors app). */
const OFF_PLATFORM_PAYMENT_KEYWORDS = [
  'western union', 'mandat cash', 'cash app', 'zelle',
  'paypal famille et amis', 'paypal f&f', 'friends and family',
  'virement direct', 'iban direct', 'hors plateforme', 'hors application',
  'contactez-moi sur whatsapp', 'contactez moi sur whatsapp',
  'écrivez-moi sur telegram', 'ecrivez moi sur telegram'
];

/** Objets dont la vente est interdite ou hors du périmètre de la marketplace. */
const PROHIBITED_ITEM_KEYWORDS = [
  'arme à feu', 'arme a feu', 'pistolet', 'fusil', 'revolver', 'carabine',
  'munitions', 'munition', 'balles réelles', 'balles reelles',
  'explosif', 'grenade', 'silencieux',
  'arme blanche', 'poing américain', 'poing americain',
  'drogue', 'stupéfiant', 'stupefiant', 'cannabis', 'cocaïne', 'cocaine',
  'ecstasy', 'mdma'
];

const ALL_KEYWORDS = [
  ...COUNTERFEIT_KEYWORDS,
  ...OFF_PLATFORM_PAYMENT_KEYWORDS,
  ...PROHIBITED_ITEM_KEYWORDS
];

/** Minuscules, sans accents, espaces normalisés — pour une correspondance robuste. */
const normalize = (value: string): string =>
  value
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/\s+/g, ' ')
    .trim();

const NORMALIZED_KEYWORDS = ALL_KEYWORDS.map((keyword) => ({
  original: keyword,
  normalized: normalize(keyword)
}));

/**
 * Cherche les mots-clés suspects présents dans le titre + la description
 * d'une annonce. Retourne la liste des mots-clés (forme originale, dédupliquée)
 * effectivement trouvés — vide si rien ne déclenche d'analyse.
 */
export const findSuspectKeywords = (title: string, description: string): string[] => {
  const haystack = normalize(`${title} ${description}`);
  const matches = NORMALIZED_KEYWORDS.filter(({ normalized }) => haystack.includes(normalized));
  return [...new Set(matches.map((m) => m.original))];
};
